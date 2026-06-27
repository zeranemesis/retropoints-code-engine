import express from 'express';
import { assertConfig, config } from './config.js';
import {
  createInstallState,
  decodeCustomerAccountSessionToken,
  customerIdFromSessionClaims,
  isValidShopDomain,
  makeCode,
  verifyAppProxySignature,
  verifyCustomerAccountSessionToken,
  verifyInstallState,
  verifyOAuthHmac,
  verifyWebhookHmac
} from './security.js';
import { calculatePointsFromCents, calculateRedeemable, tierFromLifetimePoints } from './retropoints.js';
import {
  createCustomerMetafieldDefinitions,
  createOrdersPaidWebhookSubscription,
  createRetroPointsDiscount,
  getCustomerPoints,
  setCustomerPoints
} from './shopify-admin.js';
import { findPendingRedemptionByCode, markRedemptionUsed, saveInstallation, saveRedemption } from './db.js';

assertConfig();

const APP_VERSION = '2026-06-27-webhook-usererrors-fix';
const app = express();
app.set('trust proxy', 1);

function publicBaseUrl(req) {
  return `https://${req.get('host')}`;
}

function webhookCallbackUrl(req) {
  return `${publicBaseUrl(req)}/webhooks/orders-paid`;
}
function setCustomerAccountCors(req, res) {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Authorization,Content-Type');
}

app.post('/webhooks/orders-paid', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!verifyWebhookHmac(req)) return res.status(401).send('Invalid webhook HMAC');

  const order = JSON.parse(req.body.toString('utf8'));
  const customerId = order.customer?.id;
  if (!customerId) return res.status(200).send('No customer');

  const usedCode = (order.discount_codes || [])
    .map((discount) => discount.code)
    .find((code) => code && code.startsWith('RP-'));

  const redemption = usedCode ? await findPendingRedemptionByCode(usedCode) : null;
  const current = await getCustomerPoints(customerId);

  const earnedPoints = calculatePointsFromCents(Math.round(Number(order.total_price || 0) * 100));
  const pointsAfterRedemption = redemption ? Math.max(0, current.points - redemption.pointsUsed) : current.points;
  const newPoints = pointsAfterRedemption + earnedPoints;
  const newLifetime = current.lifetimePoints + earnedPoints;
  const newTier = tierFromLifetimePoints(newLifetime);

  await setCustomerPoints(customerId, {
    points: newPoints,
    lifetimePoints: newLifetime,
    tier: newTier
  });

  if (redemption) await markRedemptionUsed(usedCode, order.id);
  res.status(200).send('OK');
});

app.use(express.json());

app.get('/health', (_req, res) => {
  res.json({ ok: true, app: 'RetroPoints Code Engine', version: APP_VERSION });
});

app.get('/', (req, res) => {
  if (req.query.shop && !req.query.code) {
    return res.redirect(`/auth/install?shop=${encodeURIComponent(req.query.shop)}`);
  }

  res.type('html').send(`
    <main style="font-family:system-ui,sans-serif;padding:32px;line-height:1.5">
      <h1>RetroPoints Code Engine</h1>
      <p>Application active. Les clients utilisent leurs points depuis le panier RetroParty.</p>
      <p><a href="/auth/install?shop=${config.shop}">Installer sur ${config.shop}</a></p>
    </main>
  `);
});

app.get('/auth/install', (req, res) => {
  const shop = String(req.query.shop || config.shop || '').trim();
  if (!isValidShopDomain(shop)) return res.status(400).send('Shop invalide.');

  const redirectUri = `https://${req.get('host')}/auth/callback`;
  const state = createInstallState(shop);
  const url = new URL(`https://${shop}/admin/oauth/authorize`);
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('scope', config.scopes);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('state', state);

  res.redirect(url.toString());
});

app.get('/auth/callback', async (req, res) => {
  const shop = String(req.query.shop || '').trim();
  const code = String(req.query.code || '');
  const state = String(req.query.state || '');

  if (!isValidShopDomain(shop)) return res.status(400).send('Shop invalide.');
  if (!verifyOAuthHmac(req)) return res.status(401).send('HMAC Shopify invalide.');
  if (!verifyInstallState(state, shop)) return res.status(401).send('Etat OAuth invalide.');

  const response = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code
    })
  });

  const token = await response.json().catch(() => ({}));
  if (!response.ok || !token.access_token) {
    return res.status(500).send(`Installation impossible : ${JSON.stringify(token)}`);
  }

  await saveInstallation({
    shop,
    accessToken: token.access_token,
    scope: token.scope || config.scopes
  });

  let metafieldsStatus = '<p>Creation des champs meta : non testee.</p>';
  let webhookStatus = '<p>Webhook orders/paid : non teste.</p>';

  try {
    const results = await createCustomerMetafieldDefinitions();
    const hasError = results.some((result) => result.status === 'error');
    const labels = results.map((result) => `${result.key}: ${result.status}`).join(', ');

    metafieldsStatus = hasError
      ? `<p>Champs meta RetroPoints : une erreur est a corriger (${labels}).</p>`
      : `<p>Champs meta RetroPoints : OK (${labels}).</p>`;
  } catch (error) {
    metafieldsStatus = `<p>Champs meta RetroPoints : erreur ${String(error.message || error)}</p>`;
  }


  try {
    const webhook = await createOrdersPaidWebhookSubscription(webhookCallbackUrl(req));
    webhookStatus = webhook.status === 'error'
      ? `<p>Webhook orders/paid : erreur ${JSON.stringify(webhook.errors)}</p>`
      : `<p>Webhook orders/paid : OK (${webhook.status})</p>`;
  } catch (error) {
    webhookStatus = `<p>Webhook orders/paid : erreur ${String(error.message || error)}</p>`;
  }

  res.type('html').send(`
    <main style="font-family:system-ui,sans-serif;padding:32px;line-height:1.5">
      <h1>RetroPoints installe</h1>
      <p>L'application est maintenant installee sur ${shop}.</p>
      ${metafieldsStatus}
      ${webhookStatus}
      <p>Version serveur : ${APP_VERSION}</p>
      <p><a href="https://${shop}/apps/retropoints/health">Tester le proxy RetroPoints</a></p>
    </main>
  `);
});


app.options('/customer-account/points', (req, res) => {
  setCustomerAccountCors(req, res);
  res.status(204).send('');
});

app.get('/customer-account/points', async (req, res) => {
  setCustomerAccountCors(req, res);

  const token = String(req.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
  if (!token) return res.status(401).json({ ok: false, error: 'Connexion client requise.' });

  try {
    let claims;
    let verified = true;

    try {
      claims = verifyCustomerAccountSessionToken(token);
    } catch (verificationError) {
      verified = false;
      claims = decodeCustomerAccountSessionToken(token);
      console.warn(`RetroPoints customer token decoded without strict verification: ${verificationError.message}`);
    }

    const customerId = customerIdFromSessionClaims(claims);
    const customer = await getCustomerPoints(customerId);

    res.json({
      ok: true,
      verified,
      points: customer.points,
      lifetimePoints: customer.lifetimePoints,
      tier: customer.tier
    });
  } catch (error) {
    console.error(`RetroPoints customer-account points error: ${error.message}`);
    res.status(401).json({ ok: false, error: error.message });
  }
});
app.get('/setup/metafields', async (_req, res) => {
  try {
    const results = await createCustomerMetafieldDefinitions();
    const hasError = results.some((result) => result.status === 'error');

    res.status(hasError ? 500 : 200).json({
      ok: !hasError,
      app: 'RetroPoints Code Engine',
      version: APP_VERSION,
      ownerType: 'CUSTOMER',
      definitions: results
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      version: APP_VERSION,
      error: error.message
    });
  }
});

app.get('/setup/webhooks', async (req, res) => {
  try {
    const callbackUrl = webhookCallbackUrl(req);
    const webhook = await createOrdersPaidWebhookSubscription(callbackUrl);
    const hasError = webhook.status === 'error';

    res.status(hasError ? 500 : 200).json({
      ok: !hasError,
      app: 'RetroPoints Code Engine',
      version: APP_VERSION,
      topic: 'ORDERS_PAID',
      callbackUrl,
      webhook
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      app: 'RetroPoints Code Engine',
      version: APP_VERSION,
      error: error.message
    });
  }
});

app.post('/proxy/redeem', async (req, res) => {
  if (!verifyAppProxySignature(req)) return res.status(401).json({ ok: false, error: 'Requete non autorisee.' });

  const customerId = new URL(req.originalUrl, `https://${req.headers.host}`).searchParams.get('logged_in_customer_id');
  if (!customerId) return res.status(401).json({ ok: false, error: 'Connecte-toi pour utiliser tes points.' });

  try {
    const cartTotalCents = Number(req.body.cart_total_cents || 0);
    const customer = await getCustomerPoints(customerId);
    const redeemable = calculateRedeemable({
      availablePoints: customer.points,
      cartTotalCents
    });

    if (!redeemable.canRedeem) {
      return res.status(400).json({ ok: false, error: `Il faut au moins ${config.minRedeemPoints} points utilisables.` });
    }

    const code = makeCode(customerId, redeemable.discountCents);
    const expiresAt = new Date(Date.now() + config.discountExpirationMinutes * 60 * 1000);
    const discountNodeId = await createRetroPointsDiscount({
      customerId,
      code,
      discountCents: redeemable.discountCents,
      expiresAt
    });

    await saveRedemption({
      code,
      discountNodeId,
      customerId: String(customerId),
      pointsUsed: redeemable.pointsUsed,
      discountCents: redeemable.discountCents,
      status: 'pending',
      createdAt: new Date().toISOString(),
      expiresAt: expiresAt.toISOString()
    });

    res.json({
      ok: true,
      discount_code: code,
      points_used: redeemable.pointsUsed,
      discount_cents: redeemable.discountCents,
      expires_at: expiresAt.toISOString(),
      message: `Reduction RetroPoints appliquee : ${redeemable.pointsUsed} points utilises.`
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.get('/proxy/health', (req, res) => {
  const signed = verifyAppProxySignature(req);
  res.json({
    ok: signed,
    app: 'RetroPoints Code Engine',
    proxy: signed ? 'connected' : 'invalid_signature'
  });
});

app.post('/proxy/release', async (req, res) => {
  if (!verifyAppProxySignature(req)) return res.status(401).json({ ok: false, error: 'Requete non autorisee.' });

  res.json({
    ok: true,
    message: 'Reduction RetroPoints retiree du panier.'
  });
});

app.listen(config.port, () => {
  console.log(`RetroPoints Code Engine listening on port ${config.port}`);
});
