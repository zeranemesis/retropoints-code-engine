import 'dotenv/config';

export const config = {
  port: Number(process.env.PORT || 3000),
  shop: process.env.SHOPIFY_SHOP,
  storefrontDomain: process.env.SHOPIFY_STOREFRONT_DOMAIN || '',
  setupToken: process.env.RETROPOINTS_SETUP_TOKEN || '',
  apiVersion: process.env.SHOPIFY_API_VERSION || '2026-04',
  adminAccessToken: process.env.SHOPIFY_ADMIN_ACCESS_TOKEN,
  clientId: process.env.SHOPIFY_CLIENT_ID,
  clientSecret: process.env.SHOPIFY_CLIENT_SECRET,
  appSecret: process.env.SHOPIFY_APP_SECRET || process.env.SHOPIFY_CLIENT_SECRET,
  scopes: process.env.SHOPIFY_SCOPES || 'write_app_proxy,read_customers,write_customers,read_discounts,write_discounts,read_orders,write_orders',
  pointsPerEuro: Number(process.env.POINTS_PER_EURO || 5),
  pointsPerEuroDiscount: Number(process.env.POINTS_PER_EURO_DISCOUNT || 100),
  minRedeemPoints: Number(process.env.MIN_REDEEM_POINTS || 500),
  redeemStepPoints: Number(process.env.REDEEM_STEP_POINTS || 100),
  discountExpirationMinutes: Number(process.env.DISCOUNT_EXPIRATION_MINUTES || 30),
  proxyTimestampToleranceSeconds: Number(process.env.PROXY_TIMESTAMP_TOLERANCE_SECONDS || 300),
  proxyRateLimitWindowSeconds: Number(process.env.PROXY_RATE_LIMIT_WINDOW_SECONDS || 60),
  proxyRateLimitPerCustomer: Number(process.env.PROXY_RATE_LIMIT_PER_CUSTOMER || 30),
  proxyRateLimitPerIp: Number(process.env.PROXY_RATE_LIMIT_PER_IP || 60)
};

export function assertConfig() {
  const missing = [];
  if (!config.shop) missing.push('SHOPIFY_SHOP');
  if (!config.adminAccessToken && (!config.clientId || !config.clientSecret)) {
    missing.push('SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET');
  }
  if (!config.appSecret) missing.push('SHOPIFY_CLIENT_SECRET');

  if (missing.length) {
    throw new Error('Missing environment variables: ' + missing.join(', '));
  }

  for (const [name, value] of [
    ['POINTS_PER_EURO', config.pointsPerEuro],
    ['POINTS_PER_EURO_DISCOUNT', config.pointsPerEuroDiscount],
    ['MIN_REDEEM_POINTS', config.minRedeemPoints],
    ['REDEEM_STEP_POINTS', config.redeemStepPoints]
  ]) {
    if (!Number.isInteger(value) || value <= 0) {
      throw new Error(name + ' must be a positive integer.');
    }
  }
}


