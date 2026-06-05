# ADR-001 — Server-Side Rendering vs SPA

**Date :** 2026-06-05  
**Statut :** Accepté

## Contexte

Le CNP Portal est un outil interne destiné à des équipes techniques. Nous devons choisir entre SSR (EJS via Express) et une architecture SPA découplée (React/Vue + API REST).

## Décision

**SSR avec EJS** pour le MVP.

## Justification

- **Simplicité maximale** : pas de build pipeline frontend, pas de gestion du state côté client
- **Sécurité** : les tokens et données sensibles restent côté serveur, jamais exposés dans le JS du navigateur
- **Déploiement simplifié** : une seule image Docker, un seul processus
- **Cohérence** : le rendu côté serveur facilite l'implémentation du RBAC (on ne rend que ce que l'utilisateur est autorisé à voir)
- **Desktop only** : l'absence de responsive mobile réduit la contrainte sur le framework UI

## Conséquences

- Post-MVP : si l'équipe souhaite des mises à jour en temps réel (polling WebSocket pour les pipelines), il sera nécessaire d'ajouter une couche JS légère ou de passer à un SPA.
- L'interface sera moins réactive qu'un SPA (rechargements de page complets).

## Alternatives rejetées

- **React + API REST** : sur-ingénierie pour un MVP interne, complexité de sécurisation des tokens côté client.
- **Vue.js** : mêmes raisons.
