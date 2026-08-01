# RetroPoints Code Engine

Backend de fidélité RetroParty pour Shopify App Proxy.

## Règles

- 1 EUR payé = 5 points.
- 100 points = 1 EUR de remise.
- 100 EUR payé = 500 points = 5 EUR de remise.
- Première conversion à partir de 500 points.
- Conversion par pas de 100 points.
- Un code RetroPoints est utilisable une seule fois, uniquement par le client qui l'a obtenu.
- Le débit définitif intervient au webhook Shopify `orders/paid`.

## Endpoints App Proxy

Shopify transmet les URLs storefront suivantes vers le backend :

| Storefront | Backend | Usage |
| --- | --- | --- |
| `GET /apps/retropoints/status` | `GET /proxy/status` | Reconstituer le solde et la réservation |
| `POST /apps/retropoints/redeem` | `POST /proxy/redeem` | Réserver les points et créer le code |
| `POST /apps/retropoints/release` | `POST /proxy/release` | Libérer une réservation abandonnée |

Chaque requête App Proxy doit contenir les paramètres Shopify signés `shop`, `timestamp`, `logged_in_customer_id` et `signature`. Le client ne doit jamais être pris depuis le JSON envoyé par le navigateur.

Les requêtes `POST` doivent contenir un en-tête unique :

```
X-RetroPoints-Idempotency-Key: panier-<identifiant-stable>
```

La même clé avec le même corps retourne la même réservation. La même clé avec un autre corps est refusée.

### POST /proxy/redeem

Corps minimal :

```json
{
  "cart_total_cents": 8200,
  "existing_discount_codes": []
}
```

`cart_total_cents` est une indication de panier contrôlée côté serveur et bornée par le code Shopify créé. Le serveur recalcule toujours les points depuis le metafield client et applique une limite de sous-total au code de remise.

Réponse :

```json
{
  "ok": true,
  "status": "reserved",
  "reservation_id": "uuid",
  "discount_code": "RP-8E-...",
  "points_used": 800,
  "discount_cents": 800,
  "expires_at": "2026-07-26T12:00:00.000Z",
  "combinable": true,
  "combination_rules": {
    "order_discounts": false,
    "product_discounts": false,
    "shipping_discounts": true
  }
}
```

Le thème doit conserver les autres codes promotionnels et afficher l'erreur `combinable: false` si un code commande ou produit incompatible est déjà présent. Aucun code n'est supprimé silencieusement.

### POST /proxy/release

Corps :

```json
{
  "reservation_id": "uuid",
  "discount_code": "RP-8E-..."
}
```

Un seul des deux identifiants est nécessaire. Le serveur vérifie qu'il appartient au client signé, supprime le code Shopify concerné, puis libère uniquement cette réservation. L'opération est idempotente.

### GET /proxy/status

La réponse contient :

- le solde Shopify réel ;
- les points réservés ;
- les points utilisables ;
- le palier ;
- la réservation active ;
- le code, le montant, l'expiration et l'état `creating`, `reserved`, `released`, `expired` ou `confirmed`.

Le thème doit appeler cette route après un rechargement, un changement d'onglet, une erreur réseau ou une réponse timeout.

## Etats

```text
(absente)
   |
   v
creating -- erreur de création --> failed
   |
   v
reserved -- expiration/release --> expired/released
   |
   v
confirmed -- orders/paid --> débit définitif + points gagnés
```

Le débit du metafield client n'est jamais effectué dans `redeem`. Il est effectué une seule fois quand la commande payée contient le code RetroPoints.

Une réservation expirée est marquée automatiquement lors du prochain appel `status`, `redeem` ou `release`. Le code Shopify possède également une expiration courte.

## Combinaisons

RetroPoints est :

- incompatible avec les remises de commande ;
- incompatible avec les remises produit ;
- compatible avec les remises d'expédition.

Le code Shopify applique ces contraintes dans `combinesWith`. Le champ `existing_discount_codes` sert uniquement à fournir un retour immédiat au thème ; la décision finale appartient à Shopify.

## Webhooks

- `orders/paid` : débit de la réservation, ajout des points gagnés et confirmation idempotente.
- `orders/cancelled` : retrait des points gagnés et restitution des points utilisés quand la commande avait été confirmée.
- `refunds/create` : retrait idempotent des points correspondant au montant remboursé.

Les webhooks doivent être configurés avec leur signature Shopify et ne sont jamais accessibles depuis le navigateur.

## Tests

```bash
npm install
npm test
```

La suite couvre signature invalide/valide, client absent, timestamp expiré, anti-rejeu, idempotence, double requête concurrente, solde insuffisant, conversion, incompatibilité de remise, confirmation, libération, expiration et ajustements de commande.

## Surveillance

1. Vérifier `GET /health` après chaque déploiement.
2. Vérifier la version et les règles retournées.
3. Surveiller les logs Render contenant :
   - `orders-paid webhook error`
   - `cancellation webhook error`
   - `refund webhook error`
   - `manual_review`
4. Vérifier régulièrement les réservations `creating` ou `reserved` âgées de plus de 30 minutes.
5. Comparer les commandes payées, les codes `RP-` utilisés et les variations des metafields clients.

Réponse de santé attendue :

```json
{
  "ok": true,
  "version": "2026-08-01-discount-release-fix",
  "rules": {
    "pointsPerEuro": 5,
    "pointsPerEuroDiscount": 100,
    "minRedeemPoints": 500,
    "redeemStepPoints": 100
  }
}
```

## Variables de production

Variables existantes :

- `SHOPIFY_SHOP`
- `SHOPIFY_API_VERSION`
- `SHOPIFY_CLIENT_ID`
- `SHOPIFY_CLIENT_SECRET`
- `SHOPIFY_APP_SECRET`
- `SHOPIFY_ADMIN_ACCESS_TOKEN` si utilisé
- `POINTS_PER_EURO=5`
- `POINTS_PER_EURO_DISCOUNT=100`
- `MIN_REDEEM_POINTS=500`
- `REDEEM_STEP_POINTS=100`
- `DISCOUNT_EXPIRATION_MINUTES=30`

Variables de sécurité optionnelles :

- `PROXY_TIMESTAMP_TOLERANCE_SECONDS=300`
- `PROXY_RATE_LIMIT_WINDOW_SECONDS=60`
- `PROXY_RATE_LIMIT_PER_CUSTOMER=30`
- `PROXY_RATE_LIMIT_PER_IP=60`
- `SHOPIFY_STOREFRONT_DOMAIN=retroparty.shop`

## Risques restants

Le fichier `data/retropoints-db.json` est protégé par un verrou dans un processus Node et par des écritures atomiques. Il reste un stockage de démarrage : pour plusieurs instances Render, il faut migrer les réservations, les clés d'idempotence et les journaux vers PostgreSQL avec transactions et contraintes uniques.

Le montant du panier arrive nécessairement depuis le thème App Proxy. Le backend le valide, le borne et fait respecter le minimum du code Shopify, mais une validation parfaitement indépendante du panier nécessite une intégration Storefront Cart côté serveur. Le paiement final et l'application réelle de la remise restent la source de vérité Shopify.

Les erreurs après mise à jour du metafield mais avant l'écriture du journal de traitement passent en `manual_review` pour éviter un double crédit. Elles doivent être réconciliées depuis les logs et l'administration Shopify.



## Provisioning securise

Les routes de maintenance suivantes ne sont pas publiques :

- `GET /setup/metafields`
- `GET /setup/webhooks`

Elles exigent l'en-tete `X-RetroPoints-Setup-Token`, dont la valeur est `RETROPOINTS_SETUP_TOKEN` dans Render. Utiliser un jeton aleatoire long, ne jamais le mettre dans le theme ou dans une URL, puis appeler les routes depuis un outil serveur. Une reinstallation OAuth relance aussi automatiquement le provisioning.

Exemple PowerShell apres redeploiement :

```powershell
$h = @{ 'X-RetroPoints-Setup-Token' = 'VOTRE_JETON_RENDER' }
Invoke-RestMethod -Headers $h https://<render-app>/setup/metafields
Invoke-RestMethod -Headers $h https://<render-app>/setup/webhooks
```
