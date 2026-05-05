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

## Routes

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

## Important

Le fichier `data/retropoints-db.json` sert de stockage simple pour demarrer.
En production, il faudra remplacer ce fichier par une vraie base de donnees.
