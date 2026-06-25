# RetroPoints Code Engine

Mini-app RetroParty pour automatiser les points sans Shopify Plus.

## Ce que fait l'app

- Recoit la demande du panier via App Proxy.
- Verifie le client connecte.
- Lit le solde `retroparty.points`.
- Calcule la reduction utilisable.
- Cree un code promo Shopify unique, limite a 1 utilisation.
- Renvoie le code au theme.
- Le theme applique le code au panier via `/cart/update.js`.
- Le webhook `orders/paid` deduit les points utilises et ajoute les points gagnes.

## Regle RetroPoints

- 1 EUR achete = 5 points.
- 100 EUR achetes = 500 points.
- 500 points = 5 EUR de remise.
- Le premier bon est utilisable a partir de 500 points.

## Routes

- `GET /auth/install?shop=your-shop.myshopify.com`
  - Lance l'installation Shopify de l'app sur la boutique
- `GET /auth/callback`
  - Callback OAuth autorise dans le Dev Dashboard
- `GET /setup/metafields`
  - Cree les definitions de champs meta clients RetroPoints
- `POST /proxy/redeem`
  - App Proxy cible depuis le theme : `/apps/retropoints/redeem`
- `POST /proxy/release`
  - App Proxy cible depuis le theme : `/apps/retropoints/release`
- `POST /webhooks/orders-paid`
  - Webhook Shopify `orders/paid`
- `GET /health`
  - Test serveur

## Configuration Shopify app

App Proxy :

- Proxy URL backend : `/proxy`
- Storefront path : `/apps/retropoints`

Scopes conseilles :

- `read_customers`
- `write_customers`
- `read_discounts`
- `write_discounts`
- `read_orders`
- `write_app_proxy`

Webhook :

- Topic : `orders/paid`
- URL : `https://ton-domaine.com/webhooks/orders-paid`

## Installation locale

```bash
cp .env.example .env
npm install
npm run dev
```

Remplir `.env` avec les valeurs de l'app Shopify.

Avec les apps du Dev Dashboard Shopify, l'Admin API access token n'est pas affiche dans l'interface.
L'app genere automatiquement ce token avec :

- `SHOPIFY_CLIENT_ID`
- `SHOPIFY_CLIENT_SECRET`

Installation manuelle :

```txt
https://ton-app-render.onrender.com/auth/install?shop=your-shop.myshopify.com
```

## Important

Le fichier `data/retropoints-db.json` sert de stockage simple pour demarrer.
En production, il faudra remplacer ce fichier par une vraie base de donnees.
