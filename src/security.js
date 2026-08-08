import crypto from 'node:crypto';
import { config } from './config.js';

function safeCompare(a, b) {
  const aBuffer = Buffer.from(String(a || ''));
  const bBuffer = Buffer.from(String(b || ''));
  return aBuffer.length === bBuffer.length && crypto.timingSafeEqual(aBuffer, bBuffer);
}

function signedMessage(url, excludedKey, separator = '') {
  return [...url.searchParams.entries()]
    .filter(([key]) => key !== excludedKey)
    .sort(([a, av], [b, bv]) => a.localeCompare(b) || av.localeCompare(bv))
    .map(([key, value]) => key + '=' + value)
    .join(separator);
}

function normalizeCustomerId(value) {
  const match = String(value || '').match(/(?:Customer\/)?(\d+)/);
  if (!match || match[1] === '0') throw new Error('Client non connecte.');
  return match[1];
}

function validateOrigin(req) {
  const origin = req.get('origin');
  if (!origin) return;
  let hostname;
  try {
    hostname = new URL(origin).hostname.toLowerCase();
  } catch {
    throw new Error('Origine invalide.');
  }

  const allowed = new Set([
    String(config.shop || '').toLowerCase(),
    String(config.storefrontDomain || '').toLowerCase()
  ].filter(Boolean));

  if (!allowed.has(hostname)) throw new Error('Origine non autorisee.');
}

export function authenticateProxyRequest(req, { requireCustomer = true } = {}) {
  const url = new URL(req.originalUrl, 'https://' + (req.headers.host || config.shop || 'localhost'));
  const signature = url.searchParams.get('signature');
  const timestamp = Number(url.searchParams.get('timestamp'));
  const shop = String(url.searchParams.get('shop') || '');

  if (!signature || !config.appSecret) throw new Error('Signature App Proxy absente.');
  if (!Number.isInteger(timestamp)) throw new Error('Timestamp App Proxy absent.');
  if (Math.abs(Math.floor(Date.now() / 1000) - timestamp) > config.proxyTimestampToleranceSeconds) {
    throw new Error('Requete App Proxy expiree.');
  }
  if (shop !== config.shop) throw new Error('Boutique non autorisee.');

  const computed = crypto
    .createHmac('sha256', config.appSecret)
    .update(signedMessage(url, 'signature'))
    .digest('hex');

  if (!safeCompare(computed, signature)) throw new Error('Signature App Proxy invalide.');
  validateOrigin(req);

  const customerId = requireCustomer
    ? normalizeCustomerId(url.searchParams.get('logged_in_customer_id'))
    : null;

  return {
    customerId,
    shop,
    timestamp,
    signature,
    query: url.searchParams
  };
}

export function verifyAppProxySignature(req) {
  try {
    authenticateProxyRequest(req, { requireCustomer: false });
    return true;
  } catch {
    return false;
  }
}

export function requestHash(req) {
  const body = req.body && typeof req.body === 'object' ? JSON.stringify(req.body) : '';
  return crypto.createHash('sha256').update(req.method + '\n' + req.path + '\n' + body).digest('hex');
}

export function getClientIp(req) {
  const forwarded = String(req.get('x-forwarded-for') || '').split(',')[0].trim();
  return forwarded || req.ip || req.socket?.remoteAddress || 'unknown';
}

export function validateIdempotencyKey(value) {
  const key = String(value || '').trim();
  if (!/^[A-Za-z0-9._:-]{16,128}$/.test(key)) {
    throw new Error('En-tete X-RetroPoints-Idempotency-Key invalide ou absent.');
  }
  return key;
}

export function verifyOAuthHmac(req) {
  const url = new URL(req.originalUrl, 'https://' + (req.headers.host || config.shop || 'localhost'));
  const hmac = url.searchParams.get('hmac');
  if (!hmac || !config.appSecret) return false;
  // OAuth uses a conventional sorted query string. App Proxy uses the same
  // fields concatenated without separators, so its verification stays above.
  const computed = crypto.createHmac('sha256', config.appSecret)
    .update(signedMessage(url, 'hmac', '&'))
    .digest('hex');
  return safeCompare(computed, hmac);
}

export function createInstallState(shop) {
  const payload = shop + ':' + Date.now() + ':' + crypto.randomBytes(8).toString('hex');
  const signature = crypto.createHmac('sha256', config.appSecret).update(payload).digest('hex');
  return Buffer.from(JSON.stringify({ payload, signature })).toString('base64url');
}

export function verifyInstallState(state, expectedShop) {
  try {
    const parsed = JSON.parse(Buffer.from(String(state || ''), 'base64url').toString('utf8'));
    const expectedSignature = crypto.createHmac('sha256', config.appSecret).update(parsed.payload).digest('hex');
    if (!safeCompare(expectedSignature, parsed.signature)) return false;
    const [shop, timestamp] = String(parsed.payload).split(':');
    const age = Date.now() - Number(timestamp || 0);
    return shop === expectedShop && age >= 0 && age < 15 * 60 * 1000;
  } catch {
    return false;
  }
}

export function verifyWebhookHmac(req) {
  const hmac = req.get('X-Shopify-Hmac-Sha256');
  if (!hmac || !config.appSecret || !req.body) return false;
  const computed = crypto.createHmac('sha256', config.appSecret).update(req.body).digest('base64');
  return safeCompare(computed, hmac);
}

function decodeJwtPart(part) {
  return JSON.parse(Buffer.from(String(part || ''), 'base64url').toString('utf8'));
}

export function decodeCustomerAccountSessionToken(token) {
  const parts = String(token || '').split('.');
  if (parts.length < 2) throw new Error('Jeton client invalide.');
  return decodeJwtPart(parts[1]);
}

export function verifyCustomerAccountSessionToken(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3 || !config.appSecret) throw new Error('Jeton client invalide.');
  const [headerPart, payloadPart, signature] = parts;
  const header = decodeJwtPart(headerPart);
  if (header.alg !== 'HS256') throw new Error('Signature du jeton client non supportee.');

  const expectedSignature = crypto.createHmac('sha256', config.appSecret)
    .update(headerPart + '.' + payloadPart).digest('base64url');
  if (!safeCompare(expectedSignature, signature)) throw new Error('Signature du jeton client invalide.');

  const claims = decodeJwtPart(payloadPart);
  const now = Math.floor(Date.now() / 1000);
  if (claims.aud && claims.aud !== config.clientId) throw new Error('Jeton client destine a une autre application.');
  if (claims.exp && Number(claims.exp) < now - 30) throw new Error('Jeton client expire.');
  if (claims.nbf && Number(claims.nbf) > now + 30) throw new Error('Jeton client pas encore valide.');
  return claims;
}

export function customerIdFromSessionClaims(claims) {
  return normalizeCustomerId(claims?.sub || claims?.customer_id || claims?.customerId || claims?.customer?.id);
}

export function makeCode(customerId, amountCents) {
  const amount = Math.floor(amountCents / 100);
  const suffix = crypto.randomBytes(4).toString('hex').toUpperCase();
  return ('RP-' + amount + 'E-' + customerId + '-' + suffix).replace(/[^A-Z0-9-]/g, '').slice(0, 48);
}

