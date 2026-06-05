# ADR-002 — Store de sessions en mémoire (MVP)

**Date :** 2026-06-05  
**Statut :** Accepté (temporaire — MVP uniquement)

## Contexte

`express-session` nécessite un store persistant. Les options sont : mémoire (défaut), Redis, base de données.

## Décision

**In-memory store** pour le MVP. Migration vers **Redis** post-MVP.

## Justification

- Aucune dépendance externe supplémentaire à déployer
- Suffisant pour 1 réplica (environnement de démonstration)
- Délai de livraison réduit

## Conséquences

- **Limitation critique** : les sessions sont perdues au redémarrage du pod ou lors d'un RollingUpdate
- **Pas compatible** avec plusieurs réplicas (sticky sessions seraient nécessaires, ou Redis)
- En production réelle, **Redis est obligatoire** pour la HA

## Migration post-MVP

```
npm install connect-redis ioredis
```

Remplacer le store par :
```js
const RedisStore = require('connect-redis')(session);
const client = new Redis(process.env.REDIS_URL);
app.use(session({ store: new RedisStore({ client }), ... }));
```

## Alternatives rejetées

- **Redis (MVP)** : nécessite un déploiement supplémentaire, complexifie le MVP.
- **Store PostgreSQL** : même raison.
