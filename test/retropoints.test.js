import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import test from 'node:test';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.SHOPIFY_SHOP = 'dc49d4-3.myshopify.com';
process.env.SHOPIFY_APP_SECRET = 'test-app-secret';
process.env.RETROPOINTS_DB_PATH = path.join(tmpdir(), 'retropoints-test-' + crypto.randomUUID() + '.json');

const { config } = await import('../src/config.js');
const security = await import('../src/security.js');
const points = await import('../src/retropoints.js');
const db = await import('../src/db.js');

function sign(url) {
  const parsed = new URL(url);
  const message = [...parsed.searchParams.entries()]
    .filter(([key]) => key !== 'signature')
    .sort(([a, av], [b, bv]) => a.localeCompare(b) || av.localeCompare(bv))
    .map(([key, value]) => key + '=' + value).join('');
  parsed.searchParams.set('signature', crypto.createHmac('sha256', config.appSecret).update(message).digest('hex'));
  return parsed.toString();
}

function request(originalUrl) {
  const parsed = new URL(originalUrl);
  return {
    originalUrl: parsed.pathname + parsed.search,
    headers: { host: config.shop },
    get(name) { return this.headers[String(name).toLowerCase()] || undefined; },
    path: parsed.pathname,
    method: 'GET',
    ip: '127.0.0.1',
    socket: { remoteAddress: '127.0.0.1' }
  };
}

function now() {
  return Math.floor(Date.now() / 1000);
}

test('signature App Proxy valide et identite client signee', () => {
  const url = sign('https://retroparty.shop/apps/retropoints/status?shop=' + config.shop + '&timestamp=' + now() + '&logged_in_customer_id=12345');
  assert.equal(security.authenticateProxyRequest(request(url)).customerId, '12345');
});

test('signature invalide, timestamp expire et client absent refuses', () => {
  const valid = 'https://retroparty.shop/apps/retropoints/status?shop=' + config.shop;
  assert.throws(() => security.authenticateProxyRequest(request(valid + '&timestamp=' + now() + '&logged_in_customer_id=123')));
  assert.throws(() => security.authenticateProxyRequest(request(sign(valid + '&timestamp=' + (now() - 999) + '&logged_in_customer_id=123'))));
  assert.throws(() => security.authenticateProxyRequest(request(sign(valid + '&timestamp=' + now()))));
});

test('calcul 100 euros = 500 points = 5 euros', () => {
  assert.equal(points.calculatePointsFromCents(8200), 410);
  const redeemable = points.calculateRedeemable({ availablePoints: 820, cartTotalCents: 8200 });
  assert.equal(redeemable.pointsUsed, 800);
  assert.equal(redeemable.discountCents, 800);
  assert.equal(redeemable.canRedeem, true);
});

test('anti-rejeu autorise la meme operation et refuse une variation', async () => {
  const args = {
    key: 'sig-a:/proxy/redeem',
    customerId: '1',
    endpoint: '/proxy/redeem',
    idempotencyKey: 'idem-replay-123456',
    requestHash: 'hash-a',
    expiresAt: new Date(Date.now() + 60_000).toISOString()
  };
  assert.equal((await db.claimProxyReplay(args)).replayed, false);
  assert.equal((await db.claimProxyReplay(args)).replayed, true);
  await assert.rejects(db.claimProxyReplay({ ...args, requestHash: 'hash-b' }), error => error.code === 'REPLAY_DETECTED');
});

test('deux conversions simultanees ne depensent pas le meme solde', async () => {
  const results = await Promise.allSettled([1, 2].map(index =>
    db.withCustomerLock('customer-concurrent', async () => {
      const result = await db.createRedemptionReservation({
        customerId: 'customer-concurrent',
        idempotencyKey: 'idem-concurrent-' + index + '-123456',
        requestHash: 'hash-' + index,
        availablePoints: 500,
        pointsUsed: 500,
        discountCents: 500,
        cartTotalCents: 10000,
        code: 'RP-5E-customer-concurrent-' + index,
        expiresAt: new Date(Date.now() + 60_000).toISOString()
      });
      await new Promise(resolve => setTimeout(resolve, 5));
      return result;
    })
  ));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter(result => result.status === 'rejected' && result.reason.code === 'BALANCE_CHANGED').length, 1);
});

test('meme cle idempotence retourne la meme reservation', async () => {
  const input = {
    customerId: 'customer-idem',
    idempotencyKey: 'idem-stable-123456',
    requestHash: 'stable-hash',
    availablePoints: 500,
    pointsUsed: 500,
    discountCents: 500,
    cartTotalCents: 10000,
    code: 'RP-5E-customer-idem',
    expiresAt: new Date(Date.now() + 60_000).toISOString()
  };
  const first = await db.createRedemptionReservation(input);
  const second = await db.createRedemptionReservation(input);
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(second.reservation.reservationId, first.reservation.reservationId);
});

test('release et confirmation sont idempotentes', async () => {
  const input = {
    customerId: 'customer-state',
    idempotencyKey: 'idem-state-123456',
    requestHash: 'state-hash',
    availablePoints: 500,
    pointsUsed: 500,
    discountCents: 500,
    cartTotalCents: 10000,
    code: 'RP-5E-customer-state',
    expiresAt: new Date(Date.now() + 60_000).toISOString()
  };
  const created = await db.createRedemptionReservation(input);
  await db.attachDiscountToRedemption(created.reservation.reservationId, { discountNodeId: 'gid://shopify/DiscountCodeNode/1' });
  assert.equal((await db.releaseRedemption({ reservationId: created.reservation.reservationId, customerId: 'customer-state' })).status, 'released');
  assert.equal((await db.releaseRedemption({ reservationId: created.reservation.reservationId, customerId: 'customer-state' })).status, 'released');

  const second = await db.createRedemptionReservation({ ...input, idempotencyKey: 'idem-confirm-123456', requestHash: 'confirm-hash', code: 'RP-5E-confirm' });
  await db.attachDiscountToRedemption(second.reservation.reservationId, { discountNodeId: 'gid://shopify/DiscountCodeNode/2' });
  assert.equal((await db.confirmRedemption({ code: second.reservation.code, customerId: 'customer-state', orderId: 'order-1' })).status, 'confirmed');
  assert.equal((await db.confirmRedemption({ code: second.reservation.code, customerId: 'customer-state', orderId: 'order-1' })).status, 'confirmed');
});

test('reservation expiree est liberee par le nettoyage', async () => {
  const created = await db.createRedemptionReservation({
    customerId: 'customer-expire',
    idempotencyKey: 'idem-expire-123456',
    requestHash: 'expire-hash',
    availablePoints: 500,
    pointsUsed: 500,
    discountCents: 500,
    cartTotalCents: 10000,
    code: 'RP-5E-expire',
    expiresAt: new Date(Date.now() - 1).toISOString()
  });
  await db.cleanupExpiredRedemptions();
  assert.equal((await db.findRedemptionByCode(created.reservation.code)).status, 'expired');
});

test.after(async () => {
  await fs.rm(process.env.RETROPOINTS_DB_PATH, { force: true });
});



test('combinaison de remises explicite', () => {
  assert.equal(points.evaluateDiscountCombination([]).combinable, true);
  assert.equal(points.evaluateDiscountCombination(['WELCOME10']).combinable, false);
  assert.equal(points.evaluateDiscountCombination(['RP-5E-abc']).combinable, true);
});

test('ajustement annulation/remboursement est idempotent', async () => {
  const first = await db.claimOrderAdjustment('refund:123', { orderId: 'order-1', kind: 'refund' });
  const second = await db.claimOrderAdjustment('refund:123', { orderId: 'order-1', kind: 'refund' });
  assert.equal(first.claimed, true);
  assert.equal(second.claimed, false);
  await db.finishOrderAdjustment('refund:123', { pointsReversed: 100 });
  assert.equal((await db.claimOrderAdjustment('refund:123')).claimed, false);
});

