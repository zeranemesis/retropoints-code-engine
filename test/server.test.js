import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import test from 'node:test';

process.env.SHOPIFY_SHOP = 'dc49d4-3.myshopify.com';
process.env.SHOPIFY_APP_SECRET = 'test-app-secret';
process.env.SHOPIFY_CLIENT_ID = 'test-client-id';
process.env.SHOPIFY_CLIENT_SECRET = 'test-client-secret';
process.env.RETROPOINTS_DB_PATH = 'data/server-test.json';

const { config } = await import('../src/config.js');
const { app } = await import('../src/server.js');

function sign(path) {
  const parsed = new URL('https://retroparty.shop' + path);
  const message = [...parsed.searchParams.entries()]
    .filter(([key]) => key !== 'signature')
    .sort(([a, av], [b, bv]) => a.localeCompare(b) || av.localeCompare(bv))
    .map(([key, value]) => key + '=' + value).join('');
  parsed.searchParams.set('signature', crypto.createHmac('sha256', config.appSecret).update(message).digest('hex'));
  return parsed.pathname + parsed.search;
}

function call(path, options = {}) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const req = http.request({
        hostname: '127.0.0.1',
        port: server.address().port,
        path,
        method: options.method || 'GET',
        headers: options.headers || {}
      }, response => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', chunk => { body += chunk; });
        response.on('end', () => { server.close(); resolve({ status: response.statusCode, body, headers: response.headers }); });
      });
      req.on('error', error => { server.close(); reject(error); });
      if (options.body) req.write(options.body);
      req.end();
    });
  });
}

test('status refuse une requete non signee et ne se met pas en cache', async () => {
  const response = await call('/proxy/status?shop=' + config.shop);
  assert.equal(response.status, 400);
  assert.equal(response.headers['cache-control'], 'private, no-store');
});

test('redeem refuse une signature invalide', async () => {
  const body = JSON.stringify({ cart_total_cents: 10000 });
  const response = await call('/proxy/redeem?shop=' + config.shop + '&timestamp=' + Math.floor(Date.now() / 1000) + '&signature=invalid', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body),
      'x-retropoints-idempotency-key': 'idem-server-123456'
    },
    body
  });
  assert.equal(response.status, 400);
});


test('les routes de provisioning refusent un appel sans jeton', async () => {
  const metafields = await call('/setup/metafields');
  const webhooks = await call('/setup/webhooks');
  assert.equal(metafields.status, 404);
  assert.equal(webhooks.status, 404);
  assert.equal(metafields.headers['cache-control'], 'private, no-store');
});
