'use strict';

// Gabarits du cloud privé k3s : objets enveloppés dans des Object de provider-kubernetes, isolation par namespace,
// mots de passe générés dans k3s, Deployment sans replicas (HPA), état dérivé des Object observés.

const yaml = require('js-yaml');
const t = require('../src/services/private-templates');

const priv = { ecrRegistry: '111.dkr.ecr.eu-west-3.amazonaws.com', appsDomain: 'prive.apps.example.fr',
  providerConfig: 'cnp-prive', certIssuer: 'letsencrypt-prod' };
const revision = 'a'.repeat(40);
const load = text => yaml.loadAll(text).filter(Boolean);
const files = env => t.privateCrossplaneFiles('todo', 8080, priv, env, revision);
const all = env => Object.entries(files(env)).filter(([n]) => n !== 'kustomization.yaml').flatMap(([, c]) => load(c));
const inner = (objects, kind, name) => objects.map(o => o.spec.forProvider.manifest)
  .find(m => m.kind === kind && (!name || m.metadata.name === name));

describe('enveloppe et chemin', () => {
  test('chaque objet est un Object cluster-scoped vers la ProviderConfig cnp-prive, labellisé par app et environnement', () => {
    const objects = all('dev');
    expect(objects.length).toBeGreaterThan(15);
    for (const o of objects) {
      expect(o).toMatchObject({ apiVersion: 'kubernetes.crossplane.io/v1alpha2', kind: 'Object',
        spec: { providerConfigRef: { name: 'cnp-prive' } } });
      expect(o.metadata.namespace).toBeUndefined();
      expect(o.metadata.labels).toEqual({ 'cnp.io/application': 'todo', 'cnp.io/environment': 'dev', 'cnp.io/tier': 'prive' });
      expect(o.metadata.name.startsWith('todo-dev-')).toBe(true);
    }
    expect(new Set(objects.map(o => o.metadata.name)).size).toBe(objects.length);
  });

  test('dev et prod ont des namespaces, des noms d\'Object et des adresses distincts', () => {
    const dev = all('dev'); const prod = all('prod');
    expect(inner(dev, 'Namespace').metadata.name).toBe('todo-dev');
    expect(inner(prod, 'Namespace').metadata.name).toBe('todo-prod');
    expect(dev.some(o => prod.some(p => p.metadata.name === o.metadata.name))).toBe(false);
    expect(inner(dev, 'Ingress').spec.rules[0].host).toBe('todo-dev.prive.apps.example.fr');
    expect(inner(prod, 'Ingress').spec.rules[0].host).toBe('todo.prive.apps.example.fr');
    expect(t.privateAppUrl('todo', priv, 'prod')).toBe('https://todo.prive.apps.example.fr');
  });

  test('vagues Argo : namespace, puis politiques et secrets, puis base, puis app', () => {
    const wave = file => load(files('dev')[file]).map(o => o.metadata.annotations['argocd.argoproj.io/sync-wave']);
    expect(new Set(wave('namespace.yaml'))).toEqual(new Set(['0']));
    expect(new Set([...wave('policies.yaml'), ...wave('secrets.yaml')])).toEqual(new Set(['1']));
    expect(new Set(wave('database.yaml'))).toEqual(new Set(['2']));
    expect(new Set(wave('app.yaml'))).toEqual(new Set(['3']));
    expect(yaml.load(files('dev')['kustomization.yaml']).resources)
      .toEqual(['namespace.yaml', 'policies.yaml', 'secrets.yaml', 'database.yaml', 'app.yaml']);
  });
});

describe('isolation', () => {
  test('Pod Security restricted sur le namespace ; conteneurs non root, sans privilège ni jeton monté', () => {
    const objects = all('prod');
    expect(inner(objects, 'Namespace').metadata.labels['pod-security.kubernetes.io/enforce']).toBe('restricted');
    for (const kind of ['Deployment', 'StatefulSet']) {
      const pod = inner(objects, kind).spec.template.spec;
      expect(pod.automountServiceAccountToken).toBe(false);
      expect(pod.securityContext).toMatchObject({ runAsNonRoot: true, seccompProfile: { type: 'RuntimeDefault' } });
      expect(pod.hostNetwork).toBeUndefined();
      for (const c of pod.containers) expect(c.securityContext).toEqual({ allowPrivilegeEscalation: false, capabilities: { drop: ['ALL'] } });
    }
  });

  test('réseau en refus par défaut ; ouvertures limitées au DNS, à Traefik vers l\'app et à l\'app vers sa base', () => {
    const policies = all('dev').map(o => o.spec.forProvider.manifest).filter(m => m.kind === 'NetworkPolicy');
    expect(policies.map(p => p.metadata.name).sort()).toEqual(['app-vers-base', 'base-depuis-app', 'dns', 'refus-par-defaut', 'traefik-vers-acme', 'traefik-vers-app']);
    expect(policies.find(p => p.metadata.name === 'refus-par-defaut').spec).toEqual({ podSelector: {}, policyTypes: ['Ingress', 'Egress'] });
    // Aucune ouverture par plage d'adresses (donc ni Internet ni l'IMDS 169.254.169.254).
    expect(JSON.stringify(policies)).not.toContain('ipBlock');
  });

  test('quotas et valeurs par défaut des conteneurs par environnement', () => {
    expect(inner(all('dev'), 'ResourceQuota').spec.hard['limits.cpu']).toBe('1500m');
    expect(inner(all('prod'), 'ResourceQuota').spec.hard['limits.memory']).toBe('2Gi');
    expect(inner(all('dev'), 'LimitRange').spec.limits[0].type).toBe('Container');
  });
});

describe('base et secrets', () => {
  test('mots de passe générés une seule fois dans k3s (générateur Password), jamais écrits dans Git', () => {
    const text = files('dev')['secrets.yaml'];
    const secrets = load(text).map(o => o.spec.forProvider.manifest);
    expect(secrets.find(m => m.kind === 'Password')).toBeTruthy();
    const externals = secrets.filter(m => m.kind === 'ExternalSecret');
    expect(externals.map(e => e.metadata.name).sort()).toEqual(['db-admin', 'db-runtime']);
    for (const e of externals) {
      expect(e.spec.refreshPolicy).toBe('CreatedOnce');
      expect(e.spec.secretStoreRef).toBeUndefined();
      expect(e.spec.data).toBeUndefined();
      expect(e.spec.dataFrom).toEqual([{ sourceRef: { generatorRef: {
        apiVersion: 'generators.external-secrets.io/v1alpha1', kind: 'Password', name: 'mot-de-passe' } } }]);
    }
    expect(Object.values(files('dev')).some(c => /kind: Secret\n/.test(c))).toBe(false);
  });

  test('l\'app se connecte en cnp_runtime avec son propre mot de passe, sans TLS vers la base du namespace', () => {
    const env = inner(all('dev'), 'Deployment').spec.template.spec.containers[0].env;
    const get = name => env.find(e => e.name === name);
    expect(get('DB_USER').value).toBe('cnp_runtime');
    expect(get('DB_HOST').value).toBe('db');
    expect(get('DB_PASSWORD').valueFrom.secretKeyRef).toEqual({ name: 'db-runtime', key: 'password' });
    expect(get('DB_SSLMODE').value).toBe('disable');
    const init = inner(all('dev'), 'ConfigMap', 'db-init').data['10-cnp-runtime.sh'];
    expect(init).toContain('NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION');
    expect(init).toContain(":'pw'");
  });

  test('PostgreSQL épinglé, utilisateur postgres de l\'image alpine, volume local', () => {
    const sts = inner(all('prod'), 'StatefulSet');
    expect(sts.spec.template.spec.containers[0].image).toBe(t.POSTGRES_IMAGE);
    expect(sts.spec.template.spec.securityContext).toMatchObject({ runAsUser: 70, fsGroup: 70 });
    expect(sts.spec.volumeClaimTemplates[0].spec.storageClassName).toBe('local-path');
    // La base ne va jamais sur le nœud bonus (son volume est local au serveur).
    expect(sts.spec.template.spec.nodeSelector).toEqual({ 'node-role.kubernetes.io/control-plane': 'true' });
  });
});

describe('application', () => {
  test('image ECR à la révision exacte, sans replicas (le HPA décide), HPA par environnement', () => {
    const dev = all('dev'); const prod = all('prod');
    const deployment = inner(dev, 'Deployment');
    expect(deployment.spec.replicas).toBeUndefined();
    // Suivi en direct de l'état observé (sinon le statut du portail a 10 min de retard).
    expect(dev.find(o => o.spec.forProvider.manifest.kind === 'Deployment').spec.watch).toBe(true);
    // L'app PRÉFÈRE la machine de sa base (préférence, pas obligation : sinon le nœud bonus ne servirait à rien).
    const affinity = deployment.spec.template.spec.affinity.podAffinity;
    expect(affinity.requiredDuringSchedulingIgnoredDuringExecution).toBeUndefined();
    expect(affinity.preferredDuringSchedulingIgnoredDuringExecution[0].podAffinityTerm).toEqual({
      labelSelector: { matchLabels: { 'app.kubernetes.io/name': 'todo', 'cnp.io/role': 'db' } },
      topologyKey: 'kubernetes.io/hostname' });
    expect(deployment.spec.template.spec.containers[0].image).toBe(`111.dkr.ecr.eu-west-3.amazonaws.com/todo:${revision}`);
    expect(inner(dev, 'HorizontalPodAutoscaler').spec).toMatchObject({ minReplicas: 1, maxReplicas: 3 });
    expect(inner(prod, 'HorizontalPodAutoscaler').spec).toMatchObject({ minReplicas: 2, maxReplicas: 5 });
  });

  test('HTTPS par cert-manager, redirection HTTP, sondes /health', () => {
    const objects = all('dev');
    const ingress = inner(objects, 'Ingress');
    expect(ingress.metadata.annotations['cert-manager.io/cluster-issuer']).toBe('letsencrypt-prod');
    expect(ingress.metadata.annotations['traefik.ingress.kubernetes.io/router.middlewares']).toBe('todo-dev-vers-https@kubernetescrd');
    expect(ingress.spec.tls[0]).toEqual({ hosts: ['todo-dev.prive.apps.example.fr'], secretName: 'todo-tls' });
    expect(inner(objects, 'Middleware').spec.redirectScheme.scheme).toBe('https');
    const container = inner(objects, 'Deployment').spec.template.spec.containers[0];
    expect(container.readinessProbe.httpGet.path).toBe('/health');
    expect(container.readinessProbe.timeoutSeconds).toBe(5);
  });

  test('révision invalide, nom réservé ou registre absent : refus avant toute génération', () => {
    expect(() => t.privateCrossplaneFiles('todo', 8080, priv, 'dev', 'main')).toThrow('Révision CI invalide');
    expect(() => t.privateCrossplaneFiles('k3s-api', 8080, priv, 'prod', revision)).toThrow('réservé');
    expect(() => t.privateCrossplaneFiles('todo', 8080, { ...priv, ecrRegistry: '' }, 'dev', revision)).toThrow('Registre');
    expect(() => t.privateCrossplaneFiles('todo', 8080, priv, 'staging', revision)).toThrow('Environnement invalide');
  });
});

describe('état observé', () => {
  const object = (kind, { synced = 'True', ready = 'True', observed, deleting } = {}) => ({
    metadata: { name: `todo-dev-${kind.toLowerCase()}`, ...(deleting ? { deletionTimestamp: '2026-11-17T00:00:00Z' } : {}) },
    spec: { forProvider: { manifest: { kind } } },
    status: { conditions: [{ type: 'Synced', status: synced, message: synced === 'True' ? undefined : 'namespace "todo-dev" not found' },
      { type: 'Ready', status: ready }], ...(observed ? { atProvider: { manifest: observed } } : {}) },
  });
  const image = `111.dkr.ecr.eu-west-3.amazonaws.com/todo:${revision}`;
  const deployment = (img, status, generation = 2) => ({ metadata: { generation },
    spec: { template: { spec: { containers: [{ image: img }] } } }, status });

  test('aucun Object : en attente d\'Argo ; Object non appliqués : création en cours, avec la cause', () => {
    expect(t.privateAppStatusFrom([], { expectedImage: image })).toMatchObject({ phase: 'waiting-argocd', exists: false });
    const s = t.privateAppStatusFrom([object('Namespace'), object('Deployment', { synced: 'False', ready: 'False' })], { expectedImage: image });
    expect(s).toMatchObject({ phase: 'applying', pending: 1, exists: true });
    expect(s.detail).toContain('not found');
  });

  test('« ready » seulement sur la bonne image, déploiement progressif terminé', () => {
    const done = { observedGeneration: 2, replicas: 2, updatedReplicas: 2, availableReplicas: 2 };
    expect(t.privateAppStatusFrom([object('Deployment', { observed: deployment(image.replace('a', 'b'), done) })], { expectedImage: image }).phase).toBe('rollout');
    expect(t.privateAppStatusFrom([object('Deployment', { observed: deployment(image, { ...done, availableReplicas: 1 }) })], { expectedImage: image }).phase).toBe('rollout');
    expect(t.privateAppStatusFrom([object('Deployment', { observed: deployment(image, done) })], { expectedImage: image }).phase).toBe('ready');
  });

  test('un délai de déploiement dépassé est un échec ; un Object en suppression est signalé', () => {
    const stuck = { observedGeneration: 2, replicas: 2, updatedReplicas: 1, availableReplicas: 1,
      conditions: [{ type: 'Progressing', status: 'False', reason: 'ProgressDeadlineExceeded' }] };
    expect(t.privateAppStatusFrom([object('Deployment', { observed: deployment(image, stuck) })], { expectedImage: image }).phase).toBe('failed');
    expect(t.privateAppStatusFrom([object('Namespace', { deleting: true })])).toMatchObject({ exists: true, deleting: true });
  });
});
