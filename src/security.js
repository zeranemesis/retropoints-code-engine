import crypto from 'node:crypto';
import { config } from './config.js';

function safeCompare(a, b) {
  const aBuffer = Buffer.from(a || '');
  const bBuffer = Buffer.from(b || '');
  return aBuffer.length === bBuffer.length && crypto.timingSafeEqual(aBuffer, bBuffer);
}

export function isValidShopDomain(shop) {
  return /^[a-zA-Z0-9][a-zA-Z0-9-]*\.myshopify\.com$/.test(String(shop || ''));
}

export function verifyAppProxySignature(req) {
  const url = new URL(req.originalUrl, `https://${req.headers.host || config.shop || 'localhost'}`);
  const signature = url.searchParams.get('signature');

  if (!signature || !config.appSecret) return false;

  const pairs = [];
  url.searchParams.forEach((value, key) => {
    if (key !== 'signature') pairs.push([key, value]);
  });

  const message = pairs
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join('');

  const computed = crypto
    .createHmac('sha256', config.appSecret)
    .update(message)
    .digest('hex');

  return safeCompare(computed, signature);
}

export function verifyOAuthHmac(req) {
  const url = new URL(req.originalUrl, `https://${req.headers.host || config.shop || 'localhost'}`);
  const hmac = url.searchParams.get('hmac');
  if (!hmac || !config.appSecret) return false;

  const message = [...url.searchParams.entries()]
    .filter(([key]) => key !== 'hmac' && key !== 'signature')
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join('&');

  const computed = crypto
    .createHmac('sha256', config.appSecret)
    .update(message)
    .digest('hex');

  return safeCompare(computed, hmac);
}

export function createInstallState(shop) {
  const payload = `${shop}:${Date.now()}:${crypto.randomBytes(8).toString('hex')}`;
  const signature = crypto
    .createHmac('sha256', config.appSecret)
    .update(payload)
    .digest('hex');

  return Buffer.from(JSON.stringify({ payload, signature })).toString('base64url');
}

export function verifyInstallState(state, expectedShop) {
  try {
    const parsed = JSON.parse(Buffer.from(String(state || ''), 'base64url').toString('utf8'));
    const expectedSignature = crypto
      .createHmac('sha256', config.appSecret)
      .update(parsed.payload)
      .digest('hex');

    if (!safeCompare(expectedSignature, parsed.signature)) return false;

    const [shop, timestamp] = parsed.payload.split(':');
    const age = Date.now() - Number(timestamp || 0);
    return shop === expectedShop && age >= 0 && age < 15 * 60 * 1000;
  } catch {
    return false;
  }
}

export function verifyWebhookHmac(req) {
  const hmac = req.get('X-Shopify-Hmac-Sha256');
  if (!hmac || !config.appSecret || !req.body) return false;

  const computed = crypto
    .createHmac('sha256', config.appSecret)
    .update(req.body)
    .digest('base64');

  return safeCompare(computed, hmac);
}

export function makeCode(customerId, amountCents) {
  const amount = Math.floor(amountCents / 100);
  const suffix = crypto.randomBytes(4).toString('hex').toUpperCase();
  return `RP-${amount}E-${customerId}-${suffix}`.replace(/[^A-Z0-9-]/g, '').slice(0, 48);
}
