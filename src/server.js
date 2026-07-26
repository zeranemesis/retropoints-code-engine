import express from 'express';
import { fileURLToPath } from 'node:url';
import { assertConfig, config } from './config.js';
import {
  authenticateProxyRequest,
  createInstallState,
  decodeCustomerAccountSessionToken,
  customerIdFromSessionClaims,
  getClientIp,
  makeCode,
  requestHash,
  validateIdempotencyKey,
  verifyCustomerAccountSessionToken,
  verifyInstallState,
  verifyOAuthHmac,
  verifyWebhookHmac
} from './security.js';
import {
  attachDiscountToRedemption,
  cleanupExpiredRedemptions,
  claimProxyReplay,
  confirmRedemption,
  createRedemptionReservation,
  failOrderProcessing,
  failRedemptionCreation,
  findRedemptionByCode,
  findRedemptionByIdempotency,
  finishOrderProcessing,
  getActiveReservedPoints,
  getCustomerRedemptionState,
  getProcessedOrder,
  claimOrderAdjustment,
  finishOrderAdjustment,
  markOrderPointsUpdated,
  releaseRedemption,
  saveInstallation,
  startOrderProcessing,
  withCustomerLock
} from './db.js';
import { calculatePointsFromCents, calculateRedeemable, evaluateDiscountCombination, tierFromLifetimePoints } from './retropoints.js';
import {
  createCustomerMetafieldDefinitions,
  createOrdersCancelledWebhookSubscription,
  createOrdersPaidWebhookSubscription,
  createRefundsCreateWebhookSubscription,
  createRetroPointsDiscount,
  deleteRetroPointsDiscount,
  getCustomerPoints,
  setCustomerPoints
} from './shopify-admin.js';

assertConfig();

export const APP_VERSION = '2026-07-26-production-hardening';
export const app = express();
const rateBuckets = new Map();
const processingOrderIds = new Set();
app.set('trust proxy', 1);

function noStore(res) {
  res.set('Cache-Control', 'private, no-store');
}

function requireSetup(req, res) {
  noStore(res);
  if (!config.setupToken || req.get('x-retropoints-setup-token') !== config.setupToken) {
    res.status(404).json({ ok: false, error: 'Route indisponible.' });
    return false;
  }
  return true;
}

function publicBaseUrl(req) {
  return 'https://' + req.get('host');
}

function webhookCallbackUrl(req) {
  return publicBaseUrl(req) + '/webhooks/orders-paid';
}

async function createRequiredWebhooks(req) {
  const base = publicBaseUrl(req);
  return Promise.all([
    createOrdersPaidWebhookSubscription(base + '/webhooks/orders-paid'),
    createOrdersCancelledWebhookSubscription(base + '/webhooks/orders-cancelled'),
    createRefundsCreateWebhookSubscription(base + '/webhooks/refunds-create')
  ]);
}

function setCustomerAccountCors(res) {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Authorization,Content-Type');
}

function errorStatus(error) {
  return {
    IDEMPOTENCY_CONFLICT: 409,
    REPLAY_DETECTED: 409,
    INCOMPATIBLE_DISCOUNT: 409,
    RESERVATION_CONFIRMED: 409,
    BALANCE_CHANGED: 409,
    RESERVATION_NOT_FOUND: 404,
    RATE_LIMITED: 429
  }[error?.code] || 400;
}

function sendError(res, error) {
  const status = errorStatus(error);
  const code = error?.code || 'REQUEST_REJECTED';
  const message = status >= 500 ? 'Erreur interne RetroPoints.' : String(error?.message || 'Requete invalide.');
  const payload = { ok: false, error: message, code };
  if (code === 'INCOMPATIBLE_DISCOUNT') {
    payload.combinable = false;
    payload.combination_rules = { order_discounts: false, product_discounts: false, shipping_discounts: true };
  }
  res.status(status).json(payload);
}

function parseInteger(value, field, { min = 0, max = 100000000 } = {}) {
  if (value === '' || value === null || value === undefined || !/^\d+$/.test(String(value))) {
    const error = new Error(field + ' doit etre un entier.');
    error.code = 'INVALID_INPUT';
    throw error;
  }
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) {
    const error = new Error(field + ' est hors limites.');
    error.code = 'INVALID_INPUT';
    throw error;
  }
  return number;
}

function parseDiscountCodes(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 20) {
    const error = new Error('existing_discount_codes doit etre une liste courte.');
    error.code = 'INVALID_INPUT';
    throw error;
  }
  return value.map(code => String(code).trim()).filter(Boolean).map(code => {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(code)) {
      const error = new Error('Code promotionnel invalide.');
      error.code = 'INVALID_INPUT';
      throw error;
    }
    return code;
  });
}

function requireProxy(req, res, { mutation = false, idempotencyKey = null } = {}) {
  try {
    const auth = authenticateProxyRequest(req, { requireCustomer: true });
    const ip = getClientIp(req);
    const now = Date.now();
    const bucketWindow = config.proxyRateLimitWindowSeconds * 1000;

    for (const [key, bucket] of rateBuckets) {
      if (bucket.resetAt <= now) rateBuckets.delete(key);
    }

    const limits = [
      ['customer:' + auth.customerId, config.proxyRateLimitPerCustomer],
      ['ip:' + ip, config.proxyRateLimitPerIp]
    ];
    for (const [key, limit] of limits) {
      const bucket = rateBuckets.get(key) || { count: 0, resetAt: now + bucketWindow };
      if (bucket.resetAt <= now) {
        bucket.count = 0;
        bucket.resetAt = now + bucketWindow;
      }
      bucket.count += 1;
      rateBuckets.set(key, bucket);
      if (bucket.count > limit) {
        const error = new Error('Trop de requetes. Reessaie dans un instant.');
        error.code = 'RATE_LIMITED';
        throw error;
      }
    }

    if (mutation) {
      const key = validateIdempotencyKey(idempotencyKey);
      const replayKey = auth.signature + ':' + req.path;
      return { auth, key, replayKey, ip };
    }
    return { auth, ip };
  } catch (error) {
    sendError(res, error);
    return null;
  }
}

function redemptionResponse(reservation, { status = 200 } = {}) {
  return {
    ok: true,
    status: reservation.status,
    reservation_id: reservation.reservationId,
    discount_code: reservation.code,
    points_used: reservation.pointsUsed,
    discount_cents: reservation.discountCents,
    expires_at: reservation.expiresAt,
    combinable: true,
    combination_rules: {
      order_discounts: false,
      product_discounts: false,
      shipping_discounts: true
    }
  };
}

function incompatibleDiscountError() {
  const error = new Error('RetroPoints ne peut pas etre combine avec un code de reduction commande ou produit.');
  error.code = 'INCOMPATIBLE_DISCOUNT';
  return error;
}

app.use((req, res, next) => {
  if (req.path.startsWith('/proxy/')) noStore(res);
  next();
});

app.post('/webhooks/orders-paid', express.raw({ type: 'application/json', limit: '256kb' }), async (req, res) => {
  noStore(res);
  if (!verifyWebhookHmac(req)) return res.status(401).send('Invalid webhook HMAC');

  let order;
  try {
    order = JSON.parse(req.body.toString('utf8'));
  } catch {
    return res.status(400).send('Invalid JSON');
  }

  const orderId = String(order.admin_graphql_api_id || order.id || order.name || '').trim();
  const customerId = String(order.customer?.id || '').match(/\d+/)?.[0];
  if (!orderId || !customerId) return res.status(200).send('Ignored');

  if (processingOrderIds.has(orderId)) return res.status(200).send('Already processing');
  processingOrderIds.add(orderId);

  try {
    const processing = await startOrderProcessing(orderId, {
      orderName: order.name || '',
      customerId,
      totalPrice: String(order.total_price || '0')
    });
    if (!processing.started) return res.status(200).send('Already processed');

    const usedCode = (order.discount_codes || [])
      .map(discount => String(discount.code || ''))
      .find(code => code.startsWith('RP-'));
    const earnedPoints = calculatePointsFromCents(Math.round(Number(order.total_price || 0) * 100));

    await withCustomerLock(customerId, async () => {
      const current = await getCustomerPoints(customerId);
      const redemption = usedCode ? await findRedemptionByCode(usedCode) : null;
      let pointsUsed = 0;

      if (redemption && redemption.customerId !== customerId) {
        throw new Error('Le code RetroPoints ne correspond pas au client de la commande.');
      }
      if (redemption?.status === 'reserved') pointsUsed = redemption.pointsUsed;

      const newPoints = Math.max(0, current.points - pointsUsed) + earnedPoints;
      const newLifetime = current.lifetimePoints + earnedPoints;
      await setCustomerPoints(customerId, {
        points: newPoints,
        lifetimePoints: newLifetime,
        tier: tierFromLifetimePoints(newLifetime)
      });
      await markOrderPointsUpdated(orderId, { pointsBefore: current.points, pointsAfter: newPoints, earnedPoints, pointsUsed });

      if (redemption && pointsUsed > 0) {
        await confirmRedemption({ code: usedCode, customerId, orderId });
      }

      await finishOrderProcessing(orderId, {
        orderName: order.name || '',
        customerId,
        earnedPoints,
        pointsUsed,
        pointsAfter: newPoints,
        redemptionCode: usedCode || null
      });
    });

    res.status(200).send('OK');
  } catch (error) {
    await failOrderProcessing(orderId, error);
    console.error('RetroPoints orders-paid webhook error:', error.message);
    res.status(500).send('RetroPoints webhook error');
  } finally {
    processingOrderIds.delete(orderId);
  }
});


async function parseSignedWebhook(req) {
  if (!verifyWebhookHmac(req)) throw new Error('Invalid webhook HMAC');
  try { return JSON.parse(req.body.toString('utf8')); } catch { throw new Error('Invalid webhook JSON'); }
}

app.post('/webhooks/orders-cancelled', express.raw({ type: 'application/json', limit: '256kb' }), async (req, res) => {
  noStore(res);
  try {
    const order = await parseSignedWebhook(req);
    const orderId = String(order.admin_graphql_api_id || order.id || '').trim();
    const customerId = String(order.customer?.id || '').match(/\d+/)?.[0];
    if (!orderId || !customerId) return res.status(200).send('Ignored');

    const processed = await getProcessedOrder(orderId);
    if (!processed?.pointsUpdated) return res.status(200).send('No paid points to reverse');

    const claim = await claimOrderAdjustment('cancelled:' + orderId, { orderId, customerId, kind: 'cancelled' });
    if (!claim.claimed) return res.status(200).send('Already adjusted');

    await withCustomerLock(customerId, async () => {
      const current = await getCustomerPoints(customerId);
      const earnedPoints = Number(processed.earnedPoints || 0);
      const restoredPoints = Number(processed.pointsUsed || 0);
      const points = Math.max(0, current.points - earnedPoints + restoredPoints);
      const lifetimePoints = Math.max(0, current.lifetimePoints - earnedPoints);
      await setCustomerPoints(customerId, { points, lifetimePoints, tier: tierFromLifetimePoints(lifetimePoints) });
      await finishOrderAdjustment('cancelled:' + orderId, { pointsReversed: earnedPoints, pointsRestored: restoredPoints });
    });
    res.status(200).send('OK');
  } catch (error) {
    console.error('RetroPoints cancellation webhook error:', error.message);
    res.status(error.message === 'Invalid webhook HMAC' ? 401 : 400).send('Webhook rejected');
  }
});

app.post('/webhooks/refunds-create', express.raw({ type: 'application/json', limit: '256kb' }), async (req, res) => {
  noStore(res);
  try {
    const refund = await parseSignedWebhook(req);
    const orderId = String(refund.order_id || refund.order?.id || '').trim();
    const refundId = String(refund.admin_graphql_api_id || refund.id || '').trim();
    if (!orderId || !refundId) return res.status(200).send('Ignored');

    const processed = await getProcessedOrder(orderId);
    if (!processed?.pointsUpdated) return res.status(200).send('No paid points to reverse');
    const customerId = String(refund.customer?.id || refund.order?.customer?.id || processed.customerId || '').match(/\d+/)?.[0];
    if (!customerId) return res.status(200).send('Ignored');

    const refundCents = refund.subtotal != null
      ? Math.max(0, Math.round(Number(refund.subtotal) * 100))
      : (refund.refund_line_items || []).reduce((sum, item) => {
          const line = item.line_item || {};
          return sum + Math.max(0, Math.round(Number(line.price || 0) * Number(item.quantity || 0) * 100));
        }, 0);
    const pointsToReverse = calculatePointsFromCents(refundCents);
    if (pointsToReverse <= 0) return res.status(200).send('No points to reverse');

    const adjustmentId = 'refund:' + refundId;
    const claim = await claimOrderAdjustment(adjustmentId, { orderId, refundId, customerId, kind: 'refund' });
    if (!claim.claimed) return res.status(200).send('Already adjusted');

    await withCustomerLock(customerId, async () => {
      const current = await getCustomerPoints(customerId);
      const reversed = Math.min(pointsToReverse, current.lifetimePoints);
      const points = Math.max(0, current.points - reversed);
      const lifetimePoints = Math.max(0, current.lifetimePoints - reversed);
      await setCustomerPoints(customerId, { points, lifetimePoints, tier: tierFromLifetimePoints(lifetimePoints) });
      await finishOrderAdjustment(adjustmentId, { pointsReversed: reversed, refundCents });
    });
    res.status(200).send('OK');
  } catch (error) {
    console.error('RetroPoints refund webhook error:', error.message);
    res.status(error.message === 'Invalid webhook HMAC' ? 401 : 400).send('Webhook rejected');
  }
});

app.use(express.json({ limit: '16kb', strict: true }));

app.get('/health', (_req, res) => {
  noStore(res);
  res.json({
    ok: true,
    app: 'RetroPoints Code Engine',
    version: APP_VERSION,
    rules: {
      pointsPerEuro: config.pointsPerEuro,
      pointsPerEuroDiscount: config.pointsPerEuroDiscount,
      minRedeemPoints: config.minRedeemPoints,
      redeemStepPoints: config.redeemStepPoints
    }
  });
});

app.get('/', (req, res) => {
  noStore(res);
  if (req.query.shop && !req.query.code) return res.redirect('/auth/install?shop=' + encodeURIComponent(req.query.shop));
  res.type('html').send('<main style="font-family:system-ui,sans-serif;padding:32px"><h1>RetroPoints Code Engine</h1><p>Application active.</p></main>');
});

app.get('/auth/install', (req, res) => {
  const shop = String(req.query.shop || config.shop || '').trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9-]*\.myshopify\.com$/.test(shop)) return res.status(400).send('Shop invalide.');
  const redirectUri = 'https://' + req.get('host') + '/auth/callback';
  const state = createInstallState(shop);
  const url = new URL('https://' + shop + '/admin/oauth/authorize');
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
  if (!/^[a-zA-Z0-9][a-zA-Z0-9-]*\.myshopify\.com$/.test(shop)) return res.status(400).send('Shop invalide.');
  if (!verifyOAuthHmac(req)) return res.status(401).send('HMAC Shopify invalide.');
  if (!verifyInstallState(state, shop)) return res.status(401).send('Etat OAuth invalide.');

  const response = await fetch('https://' + shop + '/admin/oauth/access_token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({ client_id: config.clientId, client_secret: config.clientSecret, code })
  });
  const token = await response.json().catch(() => ({}));
  if (!response.ok || !token.access_token) return res.status(500).send('Installation impossible.');

  await saveInstallation({ shop, accessToken: token.access_token });
  let metafieldsStatus = 'Champs meta RetroPoints : non testes.';
  let webhookStatus = 'Webhook orders/paid : non teste.';
  try {
    const results = await createCustomerMetafieldDefinitions();
    metafieldsStatus = 'Champs meta RetroPoints : ' + results.map(result => result.key + ':' + result.status).join(', ');
  } catch { metafieldsStatus = 'Champs meta RetroPoints : erreur.'; }
  try {
    const webhooks = await createRequiredWebhooks(req);
    webhookStatus = 'Webhooks RetroPoints : ' + webhooks.map(webhook => webhook.status).join(', ');
  } catch { webhookStatus = 'Webhook orders/paid : erreur.'; }

  noStore(res);
  res.type('html').send('<main style="font-family:system-ui,sans-serif;padding:32px;line-height:1.5"><h1>RetroPoints installe</h1><p>Installation active sur ' + shop + '.</p><p>' + metafieldsStatus + '</p><p>' + webhookStatus + '</p><p>Version serveur : ' + APP_VERSION + '</p></main>');
});

app.options('/customer-account/points', (req, res) => {
  setCustomerAccountCors(res);
  res.status(204).send('');
});

app.get('/customer-account/points', async (req, res) => {
  setCustomerAccountCors(res);
  noStore(res);
  const token = String(req.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
  if (!token) return res.status(401).json({ ok: false, error: 'Connexion client requise.' });

  try {
    const claims = verifyCustomerAccountSessionToken(token);
    const customer = await getCustomerPoints(customerIdFromSessionClaims(claims));
    res.json({ ok: true, points: customer.points, lifetimePoints: customer.lifetimePoints, tier: customer.tier });
  } catch (error) {
    res.status(401).json({ ok: false, error: 'Session client invalide.' });
  }
});

app.get('/proxy/status', async (req, res) => {
  const context = requireProxy(req, res);
  if (!context) return;
  try {
    await cleanupExpiredRedemptions();
    const customer = await getCustomerPoints(context.auth.customerId);
    const reservation = await getCustomerRedemptionState(context.auth.customerId);
    const reservedPoints = await getActiveReservedPoints(context.auth.customerId);
    res.json({
      ok: true,
      customer_id: context.auth.customerId,
      points: { available: customer.points, reserved: reservedPoints, usable: Math.max(0, customer.points - reservedPoints), lifetime: customer.lifetimePoints, tier: customer.tier },
      reservation: reservation ? redemptionResponse(reservation) : null,
      confirmation: reservation?.status === 'confirmed' ? 'confirmed' : reservation ? 'pending' : null
    });
  } catch (error) {
    sendError(res, error);
  }
});

app.post('/proxy/redeem', async (req, res) => {
  const context = requireProxy(req, res, {
    mutation: true,
    idempotencyKey: req.get('X-RetroPoints-Idempotency-Key')
  });
  if (!context) return;

  try {
    const bodyHash = requestHash(req);
    const existing = await findRedemptionByIdempotency(context.auth.customerId, context.key);
    if (existing) {
      if (existing.requestHash !== bodyHash) {
        const error = new Error('Cette cle idempotence a deja ete utilisee avec une autre demande.');
        error.code = 'IDEMPOTENCY_CONFLICT';
        throw error;
      }
      return res.status(existing.status === 'creating' ? 202 : 200).json(redemptionResponse(existing));
    }

    const replay = await claimProxyReplay({
      key: context.replayKey,
      customerId: context.auth.customerId,
      endpoint: req.path,
      idempotencyKey: context.key,
      requestHash: bodyHash,
      expiresAt: new Date(Date.now() + config.proxyTimestampToleranceSeconds * 1000).toISOString()
    });
    if (replay.replayed) {
      const retryExisting = await findRedemptionByIdempotency(context.auth.customerId, context.key);
      if (retryExisting) return res.json(redemptionResponse(retryExisting));
      const error = new Error('Rejeu detecte avant la creation de la reservation.');
      error.code = 'REPLAY_DETECTED';
      throw error;
    }

    const cartTotalCents = parseInteger(req.body?.cart_total_cents, 'cart_total_cents', { min: 1 });
    const existingCodes = parseDiscountCodes(req.body?.existing_discount_codes);
    if (!evaluateDiscountCombination(existingCodes).combinable) throw incompatibleDiscountError();

    await cleanupExpiredRedemptions();

    const result = await withCustomerLock(context.auth.customerId, async () => {
      const customer = await getCustomerPoints(context.auth.customerId);
      const reservedPoints = await getActiveReservedPoints(context.auth.customerId);
      const redeemable = calculateRedeemable({
        availablePoints: Math.max(0, customer.points - reservedPoints),
        cartTotalCents
      });

      if (!redeemable.canRedeem) {
        const error = new Error('Solde insuffisant ou panier non eligible pour une conversion.');
        error.code = 'INSUFFICIENT_POINTS';
        throw error;
      }

      const expiresAt = new Date(Date.now() + config.discountExpirationMinutes * 60 * 1000).toISOString();
      const code = makeCode(context.auth.customerId, redeemable.discountCents);
      const reservationResult = await createRedemptionReservation({
        customerId: context.auth.customerId,
        idempotencyKey: context.key,
        requestHash: bodyHash,
        availablePoints: customer.points,
        pointsUsed: redeemable.pointsUsed,
        discountCents: redeemable.discountCents,
        cartTotalCents,
        code,
        expiresAt
      });
      const reservation = reservationResult.reservation;
      if (!reservationResult.created) return reservation;

      try {
        const discountNodeId = await createRetroPointsDiscount({
          customerId: context.auth.customerId,
          code: reservation.code,
          discountCents: reservation.discountCents,
          expiresAt: new Date(reservation.expiresAt)
        });
        return await attachDiscountToRedemption(reservation.reservationId, { discountNodeId });
      } catch (error) {
        await failRedemptionCreation(reservation.reservationId, error.message);
        throw error;
      }
    });

    res.status(result.status === 'creating' ? 202 : 200).json(redemptionResponse(result));
  } catch (error) {
    sendError(res, error);
  }
});

app.post('/proxy/release', async (req, res) => {
  const context = requireProxy(req, res, {
    mutation: true,
    idempotencyKey: req.get('X-RetroPoints-Idempotency-Key')
  });
  if (!context) return;

  try {
    const bodyHash = requestHash(req);
    const replay = await claimProxyReplay({
      key: context.replayKey,
      customerId: context.auth.customerId,
      endpoint: req.path,
      idempotencyKey: context.key,
      requestHash: bodyHash,
      expiresAt: new Date(Date.now() + config.proxyTimestampToleranceSeconds * 1000).toISOString()
    });
    if (replay.replayed) {
      return res.json({ ok: true, released: true, idempotent_replay: true });
    }

    const reservationId = req.body?.reservation_id ? String(req.body.reservation_id) : null;
    const code = req.body?.discount_code ? String(req.body.discount_code) : null;
    if (!reservationId && !code) {
      const error = new Error('reservation_id ou discount_code requis.');
      error.code = 'INVALID_INPUT';
      throw error;
    }

    const released = await withCustomerLock(context.auth.customerId, async () => {
      const reservation = code ? await findRedemptionByCode(code) : null;
      if (reservation && reservation.customerId !== context.auth.customerId) {
        const error = new Error('Reservation non autorisee.');
        error.code = 'RESERVATION_NOT_FOUND';
        throw error;
      }
      if (reservationId && reservation && reservation.reservationId !== reservationId) {
        const error = new Error('Reservation non autorisee.');
        error.code = 'RESERVATION_NOT_FOUND';
        throw error;
      }
      if (!reservation) {
        return await releaseRedemption({ reservationId, code, customerId: context.auth.customerId });
      }
      if (reservation.status === 'confirmed') return reservation;
      if (reservation.discountNodeId) await deleteRetroPointsDiscount(reservation.discountNodeId);
      return releaseRedemption({ reservationId: reservation.reservationId, code: reservation.code, customerId: context.auth.customerId });
    });

    res.json({
      ok: true,
      released: true,
      reservation_id: released.reservationId,
      discount_code: released.code,
      points_released: released.pointsUsed,
      status: released.status
    });
  } catch (error) {
    sendError(res, error);
  }
});

app.get('/proxy/health', (req, res) => {
  noStore(res);
  try {
    const auth = authenticateProxyRequest(req, { requireCustomer: false });
    res.json({ ok: true, app: 'RetroPoints Code Engine', proxy: 'connected', shop: auth.shop });
  } catch (error) {
    sendError(res, error);
  }
});

app.get('/setup/metafields', async (_req, res) => {
  if (!requireSetup(_req, res)) return;
  try {
    const results = await createCustomerMetafieldDefinitions();
    const hasError = results.some(result => result.status === 'error');
    res.status(hasError ? 500 : 200).json({ ok: !hasError, app: 'RetroPoints Code Engine', version: APP_VERSION, ownerType: 'CUSTOMER', definitions: results });
  } catch (error) {
    res.status(500).json({ ok: false, error: 'Setup impossible.' });
  }
});

app.get('/setup/webhooks', async (req, res) => {
  if (!requireSetup(req, res)) return;
  try {
    const webhooks = await createRequiredWebhooks(req);
    const hasError = webhooks.some(webhook => webhook.status === 'error');
    res.status(hasError ? 500 : 200).json({ ok: !hasError, app: 'RetroPoints Code Engine', version: APP_VERSION, webhooks });
  } catch {
    res.status(500).json({ ok: false, error: 'Setup impossible.' });
  }
});

app.use((error, _req, res, _next) => {
  noStore(res);
  if (error?.type === 'entity.too.large' || error?.type === 'entity.parse.failed') {
    return res.status(400).json({ ok: false, error: 'Corps de requete invalide.' });
  }
  res.status(500).json({ ok: false, error: 'Erreur interne RetroPoints.' });
});

export function startServer() {
  return app.listen(config.port, () => {
    console.log('RetroPoints Code Engine listening on port ' + config.port);
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  startServer();
}







