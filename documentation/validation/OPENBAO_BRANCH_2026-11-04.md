# Validation locale du premier incrément OpenBao/bucket

Date : 4 novembre 2026. Branche : fix/cloudrun-environment.

- Passage complet compatible sandbox : 354 tests / 49 suites réussis.
  Commande : npm test -- --runInBand --testPathIgnorePatterns
  'deployment-environment-routes|azure-route|index.test|mcp-user-access|argocd-sync-route'.
  Les cinq suites historiques qui ouvrent des sockets restent exclues localement.
- Après renforcement du contrôle LABEL sur l’étape finale du Dockerfile : les six
  tests du fournisseur repassent. Le dernier cas ajoute la non-acceptation d’une
  étiquette présente uniquement dans un build stage.
- npm run lint réussit et couvre désormais scripts/runtime et scripts/platform.
- Les 26 templates EJS compilent ; les deux workflows et documents YAML OpenBao
  sont syntaxiquement lisibles. Rendu Helm complet non exécuté : Helm absent et
  téléchargement du shell bloqué par la résolution DNS.
- sh scripts/runtime/smoke.sh réussit sur Node 26 local : arguments Node/Python,
  code 23 et SIGTERM. Les matrices CI Node 20/24 sont préparées, pas exécutées ici.
- YAML HA/PDB : valeurs placées dans server.ha.disruptionBudget conformément au
  chart officiel 0.29.6 consulté. Le chart et l’image ne sont pas déclarés testés
  dans Kubernetes simplement parce que le YAML est lisible.
- Rôle de contrôle GCS généré sans accès cloud : dix permissions, aucun payload.

Vérifications externes non concluantes, aucune mutation :
- kubectl pointe vers gke_cnp-terraform-512313_europe-west9-b_cnp-cluster-terraform,
  mais gcloud ne peut pas écrire credentials.db dans ce sandbox en lecture seule.
- Docker : accès au socket refusé.
- curl go.dev : résolution DNS échouée.
- Diagnostic GCS : available=false, VARIABLE_STORE_UNAVAILABLE. Pas de création
  d’identité, bucket, version, secret, ressource Kubernetes ou Cloud Run.

Ne sont donc pas prouvés : IAM réel et héritage, JWT Google/OpenBao, TLS/routage
privé, build/scan de l’image, Node 20/24, quorum, sauvegarde/restauration, canari et
rollback de trafic réel. Les commandes du guide doivent être exécutées sur une
machine/CI autorisée avant de généraliser. L’existant sans nouvelles variables
reste le chemin par défaut ; les nouveaux bundles prod restent désactivés.

Les tests transport sont simulés et n’embarquent aucun identifiant réel. Les
références GCS sont des générations chaînes, les références OpenBao des versions
KV v2 avec CAS=0 ; les snapshots de marqueurs CI empêchent de publier une
configuration différente de celle capturée dans le code scanné.
