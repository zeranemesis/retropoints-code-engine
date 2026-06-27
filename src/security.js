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

function decodeJwtPart(part) {
  return JSON.parse(Buffer.from(String(part || ''), 'base64url').toString('utf8'));
}

export function verifyCustomerAccountSessionToken(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3 || !config.appSecret) {
    throw new Error('Jeton client invalide.');
  }

  const [headerPart, payloadPart, signature] = parts;
  const header = decodeJwtPart(headerPart);
  if (header.alg !== 'HS256') {
    throw new Error('Signature du jeton client non supportee.');
  }

  const expectedSignature = crypto
    .createHmac('sha256', config.appSecret)
    .update(`${headerPart}.${payloadPart}`)
    .digest('base64url');

  if (!safeCompare(expectedSignature, signature)) {
    throw new Error('Signature du jeton client invalide.');
  }

  const claims = decodeJwtPart(payloadPart);
  const now = Math.floor(Date.now() / 1000);

  if (claims.aud && claims.aud !== config.clientId) {
    throw new Error('Jeton client destine a une autre application.');
  }

  if (claims.exp && Number(claims.exp) < now - 30) {
    throw new Error('Jeton client expire.');
  }

  if (claims.nbf && Number(claims.nbf) > now + 30) {
    throw new Error('Jeton client pas encore valide.');
  }

  return claims;
}

export function customerIdFromSessionClaims(claims) {
  const candidates = [
    claims?.sub,
    claims?.customer_id,
    claims?.customerId,
    claims?.customer?.id
  ].filter(Boolean);

  for (const candidate of candidates) {
    const value = String(candidate);
    const match = value.match(/Customer\/(\d+)/) || value.match(/^(\d+)$/);
    if (match) return match[1];
  }

  throw new Error('Client introuvable dans le jeton.');
}
export function makeCode(customerId, amountCents) {
  const amount = Math.floor(amountCents / 100);
  const suffix = crypto.randomBytes(4).toString('hex').toUpperCase();
  return `RP-${amount}E-${customerId}-${suffix}`.replace(/[^A-Z0-9-]/g, '').slice(0, 48);
}
