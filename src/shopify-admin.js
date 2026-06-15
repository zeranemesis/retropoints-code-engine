import { config } from './config.js';
import { moneyFromCents } from './retropoints.js';
import { getInstallation, getLatestInstallation } from './db.js';

let cachedAccessToken = null;
let cachedAccessTokenExpiresAt = 0;
let cachedShop = null;

function customerGid(customerId) {
  const clean = String(customerId || '').replace(/\D/g, '');
  return `gid://shopify/Customer/${clean}`;
}

async function getAdminSession() {
  if (config.adminAccessToken) {
    return {
      shop: config.shop,
      accessToken: config.adminAccessToken
    };
  }

  if (cachedAccessToken && Date.now() < cachedAccessTokenExpiresAt - 60_000) {
    return {
      shop: cachedShop || config.shop,
      accessToken: cachedAccessToken
    };
  }

  const configuredInstallation = await getInstallation(config.shop);
  const latestInstallation = configuredInstallation?.accessToken
    ? configuredInstallation
    : await getLatestInstallation();

  if (latestInstallation?.accessToken) {
    cachedShop = latestInstallation.shop || config.shop;
    cachedAccessToken = latestInstallation.accessToken;
    cachedAccessTokenExpiresAt = Date.now() + 24 * 60 * 60 * 1000;

    return {
      shop: cachedShop,
      accessToken: cachedAccessToken
    };
  }

  const response = await fetch(`https://${config.shop}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: config.clientId,
      client_secret: config.clientSecret
    })
  });

  const json = await response.json().catch(() => ({}));
  if (!response.ok || !json.access_token) {
    throw new Error(`Aucune installation Shopify active trouvee. Relance /auth/install puis reessaie /setup/metafields. Reponse Shopify: ${JSON.stringify(json)}`);
  }

  cachedShop = config.shop;
  cachedAccessToken = json.access_token;
  cachedAccessTokenExpiresAt = Date.now() + Number(json.expires_in || 86399) * 1000;

  return {
    shop: cachedShop,
    accessToken: cachedAccessToken
  };
}

async function adminGraphql(query, variables = {}) {
  const session = await getAdminSession();
  const response = await fetch(`https://${session.shop}/admin/api/${config.apiVersion}/graphql.json`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': session.accessToken
    },
    body: JSON.stringify({ query, variables })
  });

  const json = await response.json();
  if (!response.ok || json.errors) {
    throw new Error(JSON.stringify(json.errors || json, null, 2));
  }
  return json.data;
}

export async function getCustomerPoints(customerId) {
  const data = await adminGraphql(
    `#graphql
    query CustomerPoints($id: ID!) {
      customer(id: $id) {
        id
        email
        points: metafield(namespace: "retroparty", key: "points") { value }
        lifetimePoints: metafield(namespace: "retroparty", key: "lifetime_points") { value }
        tier: metafield(namespace: "retroparty", key: "tier") { value }
      }
    }`,
    { id: customerGid(customerId) }
  );

  if (!data.customer) throw new Error('Client introuvable.');

  return {
    id: data.customer.id,
    email: data.customer.email,
    points: Number(data.customer.points?.value || 0),
    lifetimePoints: Number(data.customer.lifetimePoints?.value || 0),
    tier: data.customer.tier?.value || 'Bronze'
  };
}

export async function setCustomerPoints(customerId, { points, lifetimePoints, tier }) {
  const ownerId = customerGid(customerId);
  const data = await adminGraphql(
    `#graphql
    mutation SetCustomerPoints($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        metafields { id key value }
        userErrors { field message code }
      }
    }`,
    {
      metafields: [
        { ownerId, namespace: 'retroparty', key: 'points', type: 'number_integer', value: String(Math.max(0, points)) },
        { ownerId, namespace: 'retroparty', key: 'lifetime_points', type: 'number_integer', value: String(Math.max(0, lifetimePoints)) },
        { ownerId, namespace: 'retroparty', key: 'tier', type: 'single_line_text_field', value: tier }
      ]
    }
  );

  const errors = data.metafieldsSet.userErrors;
  if (errors.length) throw new Error(errors.map((error) => error.message).join(', '));
  return data.metafieldsSet.metafields;
}

export async function createCustomerMetafieldDefinitions() {
  const definitions = [
    {
      name: 'RetroPoints disponibles',
      namespace: 'retroparty',
      key: 'points',
      description: 'Solde de points fidelite disponibles pour le client.',
      type: 'number_integer',
      ownerType: 'CUSTOMER'
    },
    {
      name: 'RetroPoints cumules',
      namespace: 'retroparty',
      key: 'lifetime_points',
      description: 'Total des points fidelite cumules par le client.',
      type: 'number_integer',
      ownerType: 'CUSTOMER'
    },
    {
      name: 'Palier RetroPoints',
      namespace: 'retroparty',
      key: 'tier',
      description: 'Palier fidelite du client : Bronze, Silver ou Gold.',
      type: 'single_line_text_field',
      ownerType: 'CUSTOMER'
    }
  ];

  const results = [];

  for (const definition of definitions) {
    const data = await adminGraphql(
      `#graphql
      mutation CreateMetafieldDefinition($definition: MetafieldDefinitionInput!) {
        metafieldDefinitionCreate(definition: $definition) {
          createdDefinition {
            id
            name
            namespace
            key
          }
          userErrors {
            field
            message
            code
          }
        }
      }`,
      { definition }
    );

    const payload = data.metafieldDefinitionCreate;
    const alreadyExists = payload.userErrors.some((error) => {
      const message = String(error.message || '').toLowerCase();
      const code = String(error.code || '').toLowerCase();
      return message.includes('already') || message.includes('taken') || code.includes('taken');
    });

    if (payload.createdDefinition) {
      results.push({ key: definition.key, status: 'created', definition: payload.createdDefinition });
    } else if (alreadyExists) {
      results.push({ key: definition.key, status: 'already_exists' });
    } else {
      results.push({ key: definition.key, status: 'error', errors: payload.userErrors });
    }
  }

  return results;
}

export async function createRetroPointsDiscount({ customerId, code, discountCents, expiresAt }) {
  const amount = moneyFromCents(discountCents);
  const startsAt = new Date().toISOString();

  const data = await adminGraphql(
    `#graphql
    mutation CreateRetroPointsDiscount($basicCodeDiscount: DiscountCodeBasicInput!) {
      discountCodeBasicCreate(basicCodeDiscount: $basicCodeDiscount) {
        codeDiscountNode {
          id
          codeDiscount {
            ... on DiscountCodeBasic {
              title
              startsAt
              endsAt
            }
          }
        }
        userErrors { field message code }
      }
    }`,
    {
      basicCodeDiscount: {
        title: code,
        code,
        startsAt,
        endsAt: expiresAt.toISOString(),
        usageLimit: 1,
        appliesOncePerCustomer: true,
        context: { customers: { add: [customerGid(customerId)] } },
        customerGets: {
          items: { all: true },
          value: {
            discountAmount: {
              amount,
              appliesOnEachItem: false
            }
          }
        },
        minimumRequirement: {
          subtotal: { greaterThanOrEqualToSubtotal: amount }
        },
        combinesWith: {
          orderDiscounts: false,
          productDiscounts: false,
          shippingDiscounts: true
        },
        tags: ['retropoints']
      }
    }
  );

  const payload = data.discountCodeBasicCreate;
  if (payload.userErrors.length) {
    throw new Error(payload.userErrors.map((error) => error.message).join(', '));
  }

  return payload.codeDiscountNode.id;
}
