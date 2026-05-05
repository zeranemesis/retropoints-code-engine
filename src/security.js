import crypto from 'node:crypto';
import { config } from './config.js';

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

  const computedBuffer = Buffer.from(computed);
  const signatureBuffer = Buffer.from(signature);
  return computedBuffer.length === signatureBuffer.length && crypto.timingSafeEqual(computedBuffer, signatureBuffer);
}

export function verifyWebhookHmac(req) {
  const hmac = req.get('X-Shopify-Hmac-Sha256');
  if (!hmac || !config.appSecret || !req.body) return false;

  const computed = crypto
    .createHmac('sha256', config.appSecret)
    .update(req.body)
    .digest('base64');

  const computedBuffer = Buffer.from(computed);
  const hmacBuffer = Buffer.from(hmac);
  return computedBuffer.length === hmacBuffer.length && crypto.timingSafeEqual(computedBuffer, hmacBuffer);
}

export function makeCode(customerId, amountCents) {
  const amount = Math.floor(amountCents / 100);
  const suffix = crypto.randomBytes(4).toString('hex').toUpperCase();
  return `RP-${amount}E-${customerId}-${suffix}`.replace(/[^A-Z0-9-]/g, '').slice(0, 48);
}
