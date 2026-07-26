# Runbook RetroPoints

## Deploiement

1. Deployer le backend.
2. Ouvrir `https://<render-app>/health`.
3. Verifier la version `2026-07-26-production-hardening`.
4. Verifier les regles : 5 points par euro, 100 points par euro de remise.
5. Tester une requete App Proxy depuis une session client reelle.
6. Ne pas tester `/proxy/redeem` en ouvrant directement l'URL Render : une URL non signee doit etre refusee.

## Test fonctionnel

- Un client avec 500 points et un panier de 100 EUR doit recevoir 5 EUR de remise.
- Deux clics rapides doivent retourner la meme reservation et le meme code.
- Deux onglets ne doivent pas creer deux codes.
- Le bouton desactive doit appeler `release` avec une cle d'idempotence.
- Une commande payee doit confirmer la reservation une seule fois.
- Une commande annulee doit retirer les points gagnes et restituer les points utilises.
- Un remboursement doit retirer les points correspondant au montant rembourse une seule fois.

## Incident de points doubles

1. Verifier `/health`.
2. Verifier les logs du webhook.
3. Verifier l'identifiant de commande dans le journal `processedOrders`.
4. Comparer le metafield client avec le montant net de la commande.
5. Corriger manuellement uniquement apres rapprochement.
6. Ne jamais rejouer un webhook sans verifier son statut idempotent.

## Migration obligatoire avant plusieurs instances

Remplacer le JSON local par PostgreSQL :

- table `redemptions` avec unique `(customer_id, idempotency_key)` ;
- table `processed_orders` avec unique `order_id` ;
- table `adjustments` avec unique `adjustment_id` ;
- verrou transactionnel par `customer_id` ;
- expiration via tache periodique ;
- conservation des journaux sans secrets ni tokens.



## Provisioning protege

Dans Render, definir `RETROPOINTS_SETUP_TOKEN` avec une valeur aleatoire longue, puis redéployer. Les routes `/setup/metafields` et `/setup/webhooks` renvoient 404 sans l'en-tete `X-RetroPoints-Setup-Token`. Ne jamais placer ce jeton dans Shopify Liquid ou dans le navigateur.

```powershell
$h = @{ 'X-RetroPoints-Setup-Token' = 'VOTRE_JETON_RENDER' }
Invoke-RestMethod -Headers $h https://<render-app>/setup/metafields
Invoke-RestMethod -Headers $h https://<render-app>/setup/webhooks
```
