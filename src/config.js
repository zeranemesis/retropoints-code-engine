import 'dotenv/config';

export const config = {
  port: Number(process.env.PORT || 3000),
  shop: process.env.SHOPIFY_SHOP,
  apiVersion: process.env.SHOPIFY_API_VERSION || '2026-04',
  adminAccessToken: process.env.SHOPIFY_ADMIN_ACCESS_TOKEN,
  clientId: process.env.SHOPIFY_CLIENT_ID,
  clientSecret: process.env.SHOPIFY_CLIENT_SECRET,
  appSecret: process.env.SHOPIFY_APP_SECRET || process.env.SHOPIFY_CLIENT_SECRET,
  pointsPerEuro: Number(process.env.POINTS_PER_EURO || 5),
  pointsPerEuroDiscount: Number(process.env.POINTS_PER_EURO_DISCOUNT || 100),
  minRedeemPoints: Number(process.env.MIN_REDEEM_POINTS || 500),
  redeemStepPoints: Number(process.env.REDEEM_STEP_POINTS || 100),
  discountExpirationMinutes: Number(process.env.DISCOUNT_EXPIRATION_MINUTES || 30)
};

export function assertConfig() {
  const missing = [];
  if (!config.shop) missing.push('SHOPIFY_SHOP');
  if (!config.adminAccessToken && (!config.clientId || !config.clientSecret)) {
    missing.push('SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET');
  }
  if (!config.appSecret) missing.push('SHOPIFY_CLIENT_SECRET');

  if (missing.length) {
    throw new Error(`Missing environment variables: ${missing.join(', ')}`);
  }
}
