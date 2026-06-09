import express from 'express';
import { assertConfig, config } from './config.js';
import { verifyAppProxySignature, verifyWebhookHmac, makeCode } from './security.js';
import { calculatePointsFromCents, calculateRedeemable, tierFromLifetimePoints } from './retropoints.js';
import { createRetroPointsDiscount, getCustomerPoints, setCustomerPoints } from './shopify-admin.js';
import { findPendingRedemptionByCode, markRedemptionUsed, saveRedemption } from './db.js';

assertConfig();

const app = express();

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
  res.json({ ok: true, app: 'RetroPoints Code Engine' });
});

app.get('/', (_req, res) => {
  res.type('html').send(`
    <main style="font-family:system-ui,sans-serif;padding:32px;line-height:1.5">
      <h1>RetroPoints Code Engine</h1>
      <p>Application active. Les clients utilisent leurs points depuis le panier RetroParty.</p>
    </main>
  `);
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
