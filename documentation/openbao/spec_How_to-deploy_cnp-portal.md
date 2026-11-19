# SPEC — Déployer `cnp-portal` avec l'accès OpenBao GCP

## Objectif

Le portail doit accéder à OpenBao avec son identité Kubernetes fédérée vers
Google Cloud. Il ne reçoit ni token OpenBao permanent, ni clé JSON de service
account, ni recovery key. Les variables applicatives restent des données de
runtime et ne transitent pas par le pipeline de construction des images.

## Identité requise

Le workload est déployé dans le namespace `cnp-portal` avec le Kubernetes
ServiceAccount `cnp-portal` :

```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: cnp-portal
  namespace: cnp-portal
  annotations:
    iam.gke.io/gcp-service-account: cnp-portal@cnp-terraform-512313.iam.gserviceaccount.com
```

Le Google Service Account doit autoriser cette identité Workload Identity :

```text
serviceAccount:cnp-terraform-512313.svc.id.goog[cnp-portal/cnp-portal]
```

avec `roles/iam.workloadIdentityUser` sur le seul GSA du portail. Vérifier la
liaison avant le déploiement ; ne jamais créer de clé JSON.

## Paramètres OpenBao non secrets

Le conteneur du portail reçoit les paramètres suivants :

| Variable | Valeur GCP actuelle |
| --- | --- |
| `CNP_OPENBAO_GCP_ADDR` | `https://openbao.openbao.svc:8200` |
| `CNP_OPENBAO_GCP_AUDIENCE` | `https://openbao.openbao.svc:8200` |
| `CNP_OPENBAO_GCP_ROLE` | `cnp-control` |
| `CNP_OPENBAO_GCP_MOUNT` | `cnp-runtime` |
| `CNP_OPENBAO_GCP_CA_FILE` | `/etc/openbao-ca/ca.crt` |

L'adresse et l'audience doivent rester strictement identiques à celles du rôle
JWT OpenBao. Ces valeurs ne sont pas secrètes.

## Autorité de certification

La CA publique du certificat OpenBao est publiée dans la ConfigMap
`cnp-portal/openbao-ca`, sous la clé `ca.crt`. Seul le certificat public est
monté dans le portail ; la clé privée de la CA ne doit jamais se trouver dans
ce namespace.

## Extrait du Deployment

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: cnp-portal
  namespace: cnp-portal
spec:
  selector:
    matchLabels:
      app.kubernetes.io/name: cnp-portal
  template:
    metadata:
      labels:
        app.kubernetes.io/name: cnp-portal
    spec:
      serviceAccountName: cnp-portal
      containers:
        - name: portal
          image: IMAGE_IMMUABLE_A_RENSEIGNER
          env:
            - name: CNP_OPENBAO_GCP_ADDR
              value: https://openbao.openbao.svc:8200
            - name: CNP_OPENBAO_GCP_AUDIENCE
              value: https://openbao.openbao.svc:8200
            - name: CNP_OPENBAO_GCP_ROLE
              value: cnp-control
            - name: CNP_OPENBAO_GCP_MOUNT
              value: cnp-runtime
            - name: CNP_OPENBAO_GCP_CA_FILE
              value: /etc/openbao-ca/ca.crt
          volumeMounts:
            - name: openbao-ca
              mountPath: /etc/openbao-ca
              readOnly: true
      volumes:
        - name: openbao-ca
          configMap:
            name: openbao-ca
```

Le vrai Deployment doit conserver ses probes, ressources, ports et autres
paramètres existants. `IMAGE_IMMUABLE_A_RENSEIGNER` doit être remplacé par
l'image validée et épinglée utilisée par la plateforme.

## Flux réseau nécessaires

Le pod doit pouvoir joindre :

- `openbao.openbao.svc:8200/TCP` pour l'API HTTPS OpenBao ;
- le serveur de métadonnées GKE pour obtenir un jeton d'identité Google ;
- DNS Kubernetes pour résoudre le Service OpenBao ;
- les autres APIs déjà nécessaires au portail.

Une NetworkPolicy doit autoriser explicitement ces flux si le namespace passe
en mode deny-by-default. Le port Raft `8201` reste réservé aux pods OpenBao et
n'est pas requis par le portail.

## Séquence d'authentification

1. Le pod demande au metadata server un JWT Google pour l'audience OpenBao.
2. Le client envoie ce JWT à `auth/jwt/login` avec le rôle `cnp-control`.
3. OpenBao vérifie l'issuer, l'audience et le `sub` numérique du GSA du portail.
4. OpenBao délivre un token court, sans policy par défaut.
5. Le portail utilise ce token pour les opérations KV v2 autorisées.

Le rôle actuel doit garder une durée courte de cinq minutes. Le portail ne doit
ni journaliser le JWT ou le token OpenBao, ni les persister en base ou dans un
Secret Kubernetes.

## Vérifications après déploiement

1. Confirmer que le pod utilise `serviceAccountName: cnp-portal`.
2. Confirmer que la CA est montée et que la vérification TLS réussit.
3. Vérifier une connexion JWT depuis le pod, sans afficher le jeton.
4. Écrire deux versions fictives avec CAS, puis relire chaque version.
5. Vérifier qu'un rôle runtime borné ne lit ni une autre application ni l'autre
   environnement.
6. Redémarrer le pod du portail et confirmer qu'aucun token statique n'était
   nécessaire.
7. Vérifier qu'aucune valeur n'apparaît dans Git, les événements Kubernetes,
   les logs ou les réponses utilisateur.

## Limites actuelles

- OpenBao est exposé par un Service `ClusterIP` : le portail doit donc tourner
  dans ce cluster, ou l'architecture réseau et le certificat devront être revus.
- Le cluster GKE n'a que deux nœuds dans une zone ; les trois membres Raft ne
  constituent pas une protection contre la perte de la zone.
- L'installation live Helm devra être reprise par ArgoCD après correction des
  anciennes références KMS/GSA dans `config-repo`, sans créer une seconde
  installation.
