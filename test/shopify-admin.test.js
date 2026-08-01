import assert from 'node:assert/strict';
import test from 'node:test';

process.env.SHOPIFY_SHOP = 'retroparty.myshopify.com';
process.env.SHOPIFY_ADMIN_ACCESS_TOKEN = 'test-admin-token';
process.env.SHOPIFY_API_VERSION = '2026-04';

test('la suppression RetroPoints utilise discountCodeDelete', async () => {
  const originalFetch = globalThis.fetch;
  let request;
  globalThis.fetch = async (url, options) => {
    request = { url: String(url), body: JSON.parse(options.body) };
    return {
      ok: true,
      json: async () => ({
        data: {
          discountCodeDelete: {
            deletedCodeDiscountId: 'gid://shopify/DiscountCodeNode/1',
            userErrors: []
          }
        }
      })
    };
  };

  try {
    const { deleteRetroPointsDiscount } = await import('../src/shopify-admin.js?delete-test');
    const result = await deleteRetroPointsDiscount('gid://shopify/DiscountCodeNode/1');

    assert.equal(result.deleted, true);
    assert.equal(result.reason, 'deleted');
    assert.match(request.url, /\/admin\/api\/2026-04\/graphql\.json$/);
    assert.match(request.body.query, /discountCodeDelete\(id: \$id\)/);
    assert.doesNotMatch(request.body.query, /discountCodeBasicDelete/);
    assert.equal(request.body.variables.id, 'gid://shopify/DiscountCodeNode/1');
  } finally {
    globalThis.fetch = originalFetch;
  }
});