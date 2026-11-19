'use strict';

// Observabilité par équipe : un utilisateur ne voit les logs, métriques et alertes que des apps
// de son équipe (manager : toutes). Datadog est toujours simulé ici : aucun appel réseau.

const bcrypt = require('bcryptjs');
const app = require('../src/index');
const { request, cookie } = require('./helpers/in-memory-http');
const userModel = require('../src/models/user');
const teamService = require('../src/services/teams');
const deploymentModel = require('../src/models/deployment');
const scope = require('../src/services/observability-scope');
const datadogService = require('../src/services/datadog');
const datadogClient = require('../src/clients/datadog');
const { queryTargetsOnly } = require('../src/routes/observability');

const PASSWORD = 'observability-test-password';
let alice, bob, boss, teamA, teamB;

beforeAll(() => {
  const hash = bcrypt.hashSync(PASSWORD, 4);
  alice = userModel.create({ username: 'obs-alice', passwordHash: hash, role: 'dev', active: 1, approved: 1 });
  bob = userModel.create({ username: 'obs-bob', passwordHash: hash, role: 'devops', active: 1, approved: 1 });
  boss = userModel.create({ username: 'obs-boss', passwordHash: hash, role: 'manager', active: 1, approved: 1 });
  teamA = teamService.createTeam('obs-team-a');
  teamB = teamService.createTeam('obs-team-b');
  teamService.addMember(teamA.id, alice.id);
  teamService.addMember(teamB.id, bob.id);
  const base = { githubRepoUrl: 'https://github.com/example/app', appPort: 8080 };
  deploymentModel.create({ ...base, appName: 'obs-alpha', ownerUserId: alice.id, ownerTeamId: teamA.id, environment: 'dev' });
  deploymentModel.create({ ...base, appName: 'obs-alpha', ownerUserId: alice.id, ownerTeamId: teamA.id, environment: 'prod', targetCluster: 'gcp' });
  deploymentModel.create({ ...base, appName: 'obs-beta', ownerUserId: bob.id, ownerTeamId: teamB.id, environment: 'dev' });
  const shared = deploymentModel.create({ ...base, appName: 'obs-shared', ownerUserId: bob.id, ownerTeamId: teamB.id, environment: 'dev' });
  deploymentModel.grantTeamAccess(shared.id, teamA.id, 'read');
});

afterEach(() => jest.restoreAllMocks());

const names = user => scope.listObservableServices(user).map(s => s.service).filter(s => s.startsWith('obs-'));

describe('périmètre d\'observabilité', () => {
  test('un dev voit les apps de son équipe et celles partagées avec elle, jamais les autres', () => {
    expect(names(alice)).toEqual(['obs-alpha-dev', 'obs-alpha-prod', 'obs-shared-dev']);
  });

  test('un devops est lui aussi limité à son équipe', () => {
    expect(names(bob)).toEqual(['obs-beta-dev', 'obs-shared-dev']);
  });

  test('un manager voit toutes les apps, comme sur la page Déploiements', () => {
    expect(names(boss)).toEqual(['obs-alpha-dev', 'obs-alpha-prod', 'obs-beta-dev', 'obs-shared-dev']);
  });

  test('demander une app d\'une autre équipe est refusé, pas ignoré', () => {
    expect(() => scope.resolveServices(alice, 'obs-beta-dev')).toThrow(scope.ScopeError);
    expect(scope.resolveServices(alice, 'obs-alpha-dev').selected).toEqual(['obs-alpha-dev']);
  });
});

describe('requêtes Datadog', () => {
  test('le filtre de logs couvre Cloud Run (service), ECS (flux de logs) et k3s (namespace du cluster privé)', () => {
    expect(datadogClient.logsScopeQuery(['a-dev', 'b-prod']))
      .toBe('(service:(a-dev OR b-prod) OR @aws.awslogs.logStream:(a-dev\\/* OR b-prod\\/*)'
        + ' OR (kube_cluster_name:cnp-prive kube_namespace:(a-dev OR b-prod) -source:kubernetes.audit))');
  });

  test.each([[[]], [['a OR service:*']], [['a)']], [['*']]])('un nom de service hors format est refusé : %j', services => {
    expect(() => datadogClient.logsScopeQuery(services)).toThrow('INVALID_SERVICES');
  });

  test('aucune app visible : aucun appel Datadog', async () => {
    const spy = jest.spyOn(datadogClient, 'searchServiceLogs');
    const metrics = jest.spyOn(datadogClient, 'getServiceMetrics');
    expect(await datadogService.getLogs([])).toEqual([]);
    expect(await datadogService.getMetrics([])).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
    expect(metrics).not.toHaveBeenCalled();
  });
});

describe('mise en forme des logs', () => {
  test('Cloud Run, ECS et logs non rattachables', async () => {
    jest.spyOn(datadogClient, 'searchServiceLogs').mockResolvedValue([
      { attributes: { timestamp: '2026-11-10T10:00:00Z', service: 'obs-alpha-dev', status: 'info', tags: ['source:gcp.cloud.run.revision'],
        attributes: { data: { severity: 'ERROR', textPayload: 'boom' } } } },
      { attributes: { timestamp: '2026-11-10T10:00:01Z', service: 'pixelcalm', status: 'info', message: 'request',
        attributes: { aws: { awslogs: { logStream: 'obs-alpha-prod/app/123' } } } } },
      { attributes: { timestamp: '2026-11-10T10:00:02Z', service: 'someone-else', message: 'secret' } },
    ]);
    const logs = await datadogService.getLogs(['obs-alpha-dev', 'obs-alpha-prod']);
    expect(logs).toEqual([
      expect.objectContaining({ service: 'obs-alpha-dev', level: 'ERROR', message: 'boom', source: 'Cloud Run' }),
      expect.objectContaining({ service: 'obs-alpha-prod', level: 'INFO', message: 'request', source: 'ECS' }),
    ]);
  });

  test('log Azure Container Apps : source « Azure »', async () => {
    jest.spyOn(datadogClient, 'searchServiceLogs').mockResolvedValue([
      { attributes: { timestamp: '2026-11-17T10:17:38Z', service: 'obs-beta-dev', status: 'info', message: 'scaling',
        tags: ['source:azure.containerapps'], attributes: { azure: { ContainerAppName: 'obs-beta-dev' } } } },
    ]);
    const logs = await datadogService.getLogs(['obs-beta-dev']);
    expect(logs).toEqual([expect.objectContaining({ service: 'obs-beta-dev', message: 'scaling', source: 'Azure' })]);
  });

  test('logs des bases de données : Cloud SQL, RDS et PostgreSQL Azure', async () => {
    jest.spyOn(datadogClient, 'searchServiceLogs').mockResolvedValue([
      { attributes: { service: 'obs-alpha-dev', message: 'checkpoint', tags: ['source:gcp.cloudsql.database'], attributes: { data: { textPayload: 'checkpoint' } } } },
      { attributes: { service: 'obs-alpha-prod', message: 'FATAL', tags: ['source:postgresql'],
        attributes: { aws: { awslogs: { logGroup: '/aws/rds/instance/obs-alpha-prod-db/postgresql' } } } } },
      { attributes: { service: 'obs-alpha-dev', message: 'connection', tags: ['source:postgresql'], attributes: { azure: {}, postgres: {} } } },
    ]);
    const logs = await datadogService.getLogs(['obs-alpha-dev', 'obs-alpha-prod']);
    expect(logs.map(l => l.source)).toEqual(['Cloud SQL', 'RDS', 'Azure DB']);
  });

  test('k3s : rattaché par namespace (le log de prod porte service:<app> sans l\'environnement)', async () => {
    jest.spyOn(datadogClient, 'searchServiceLogs').mockResolvedValue([
      { attributes: { service: 'obs-alpha', message: 'GET / 200',
        tags: ['kube_cluster_name:cnp-prive', 'kube_namespace:obs-alpha-prod', 'source:obs-alpha'] } },
      { attributes: { service: 'postgres', message: 'checkpoint',
        tags: ['kube_cluster_name:cnp-prive', 'kube_namespace:obs-alpha-prod', 'source:postgres'] } },
      // Un namespace homonyme sur un autre cluster n'est pas rattaché.
      { attributes: { service: 'x', message: 'secret', tags: ['kube_cluster_name:autre', 'kube_namespace:obs-alpha-prod'] } },
    ]);
    const logs = await datadogService.getLogs(['obs-alpha-prod']);
    expect(logs).toEqual([
      expect.objectContaining({ service: 'obs-alpha-prod', source: 'k3s', message: 'GET / 200' }),
      expect.objectContaining({ service: 'obs-alpha-prod', source: 'k3s DB' }),
    ]);
  });

  test('entrée de requête HTTP Cloud Run', () => {
    expect(datadogService.messageOf({ attributes: { data: { httpRequest: { requestMethod: 'GET', requestUrl: '/x', status: 200 } } } }))
      .toBe('GET /x 200');
  });
});

describe('métriques', () => {
  test('agrégation par service, pics, taille d\'instance et séparation Cloud Run / ECS', async () => {
    const get = jest.spyOn(datadogClient, 'getServiceMetrics').mockResolvedValue({
      requests: { 'a-dev': [[1, 90], [2, 10]] }, errors: { 'a-dev': [[1, 5]] }, latency: { 'a-dev': [[1, 20], [2, 40]] },
      cpu: { 'a-dev': [[1, 0.1], [2, 0.3]] }, cpuPeak: { 'a-dev': [[1, 0.6]] },
      memory: { 'a-dev': [[1, 0.5]] }, memoryPeak: { 'a-dev': [[1, 0.7]] },
      instances: { 'a-dev': [[1, 0.1], [2, 2]] },
      cpuAlloc: { 'a-dev': [[1, 1000]] }, memAlloc: { 'a-dev': [[1, 500]] }, billable: { 'a-dev': [[1, 1000]] },
      ecsCpu: { 'b-prod': [[1, 4]] }, ecsCpuPeak: { 'b-prod': [[1, 12]] },
      ecsMemory: { 'b-prod': [[1, 8]] }, ecsMemoryPeak: { 'b-prod': [[1, 9]] }, ecsRunning: { 'b-prod': [[1, 1]] },
    });
    const window = datadogService.resolveWindow({ range: '7d' });
    const [a, b, c] = await datadogService.getMetrics(['a-dev', 'b-prod', 'c-dev'], window);
    expect(get).toHaveBeenCalledWith(['a-dev', 'b-prod', 'c-dev'], window.from, window.to);
    expect(a.cloudRun).toEqual({ requests: 100, errors: 5, errorRate: 5, latencyP95: 40, cpu: 20, cpuPeak: 60,
      memory: 50, memoryPeak: 70, instances: 1.1, instancesMax: 2, size: { vcpu: 1, memoryMiB: 512 } });
    expect(a.ecs).toBeNull();
    expect(b.cloudRun).toBeNull();
    expect(b.ecs).toEqual({ cpu: 4, cpuPeak: 12, memory: 8, memoryPeak: 9, running: 1 });
    expect(c).toEqual({ service: 'c-dev', cloudRun: null, ecs: null, azure: null, k3s: null });
  });

  test('k3s : CPU en millicœurs, mémoire en Mio, pods disponibles', async () => {
    jest.spyOn(datadogClient, 'getServiceMetrics').mockResolvedValue({
      k3sCpu: { 'p-dev': [[1, 2e6], [2, 4e6]] }, k3sMemory: { 'p-dev': [[1, 100 * 1048576], [2, 140 * 1048576]] },
      k3sPods: { 'p-dev': [[1, 1], [2, 0]] },
    });
    const [p] = await datadogService.getMetrics(['p-dev'], datadogService.resolveWindow({ range: '24h' }));
    expect(p.k3s).toEqual({ cpu: 3, cpuPeak: 4, memory: 120, memoryPeak: 140, pods: 0 });
  });

  test('Azure Container Apps : requêtes, erreurs, temps de réponse, CPU, mémoire, réplicas', async () => {
    jest.spyOn(datadogClient, 'getServiceMetrics').mockResolvedValue({
      azRequests: { 'z-dev': [[1, 150], [2, 50]] }, azErrors: { 'z-dev': [[1, 4]] },
      azLatency: { 'z-dev': [[1, 50], [2, 70]] }, azLatencyPeak: { 'z-dev': [[1, 112]] },
      azCpu: { 'z-dev': [[1, 0.2], [2, 0.4]] }, azCpuPeak: { 'z-dev': [[1, 0.4]] },
      azMemory: { 'z-dev': [[1, 4]] }, azMemoryPeak: { 'z-dev': [[1, 4]] },
      azReplicas: { 'z-dev': [[1, 0], [2, 1]] },
    });
    const [z] = await datadogService.getMetrics(['z-dev'], datadogService.resolveWindow({ range: '24h' }));
    expect(z.cloudRun).toBeNull();
    expect(z.azure).toEqual({ requests: 200, errors: 4, errorRate: 2, latency: 60, latencyPeak: 112,
      cpu: 0.3, cpuPeak: 0.4, memory: 4, memoryPeak: 4, replicas: 0.5, replicasMax: 1 });
  });
});

describe('période, recherche et export', () => {
  const now = new Date('2026-11-11T12:00:00').getTime();

  test('périodes glissantes et dates précises', () => {
    const day = datadogService.resolveWindow({ range: '24h' }, now);
    expect(day.to - day.from).toBe(86400);
    const custom = datadogService.resolveWindow({ range: 'custom', from: '2026-11-01', to: '2026-11-07' }, now);
    expect(custom).toMatchObject({ range: 'custom', error: null, label: 'du 01/11/2026 au 07/11/2026' });
    expect(custom.to - custom.from).toBe(7 * 86400);
  });

  test.each([
    ['2026-12-01', '2026-12-07', 'futur'],
    ['2026-11-07', '2026-11-01', 'précéder'],
    ['2026-09-01', '2026-11-01', '31 jours'],
    ['hier', '2026-11-01', 'invalides'],
  ])('dates refusées (%s → %s) : retour aux 24 dernières heures', (from, to, message) => {
    const w = datadogService.resolveWindow({ range: 'custom', from, to }, now);
    expect(w.error).toContain(message);
    expect(w.range).toBe('24h');
  });

  test('le jour de fin ne dépasse jamais maintenant', () => {
    const w = datadogService.resolveWindow({ range: 'custom', from: '2026-11-10', to: '2026-11-11' }, now);
    expect(w.to).toBe(Math.floor(now / 1000));
  });

  test('la recherche ne peut pas sortir des guillemets ni ajouter d\'opérateur de périmètre', () => {
    expect(datadogService.normalizeSearch('timeout" OR service:(*)')).toBe('timeout OR service:');
    expect(datadogService.normalizeSearch('   ')).toBeNull();
    expect(datadogService.normalizeSearch('x'.repeat(300))).toHaveLength(100);
  });

  test.each([
    ['app', ' -source:(gcp.cloudsql.database OR postgresql OR postgres)'],
    ['db', ' source:(gcp.cloudsql.database OR postgresql OR postgres)'],
    ['source:*', ''],
  ])('filtre d\'origine %s : fragment fixe ajouté à la requête Datadog, valeur inconnue ignorée', async (origin, fragment) => {
    const spy = jest.spyOn(datadogClient, 'searchServiceLogs').mockResolvedValue([]);
    await datadogService.getLogs(['obs-alpha-dev'], { origin });
    expect(spy.mock.calls[0][0].origin).toBe(datadogService.normalizeOrigin(origin));
    spy.mockRestore();
    const post = jest.fn().mockResolvedValue({ data: { data: [] } });
    jest.spyOn(require('axios'), 'create').mockReturnValue({ post, get: jest.fn() });
    const dd = require('../src/config/env').config.datadog;
    const keys = { apiKey: dd.apiKey, appKey: dd.appKey };
    Object.assign(dd, { apiKey: 'k', appKey: 'k' });
    try {
      await datadogClient.searchServiceLogs({ services: ['obs-alpha-dev'], origin: datadogService.normalizeOrigin(origin) });
    } finally {
      Object.assign(dd, keys);
    }
    expect(post.mock.calls[0][1].filter.query).toBe(datadogClient.logsScopeQuery(['obs-alpha-dev']) + fragment);
  });

  test('le CSV neutralise les formules de tableur et échappe les guillemets', () => {
    const csv = datadogService.logsToCsv([{ timestamp: 't', level: 'INFO', service: 'a-dev', source: 'ECS', message: '=HYPERLINK("x")' }]);
    expect(csv).toContain('"\'=HYPERLINK(""x"")"');
    expect(csv.split('\r\n')[0]).toBe('\uFEFF"horodatage";"niveau";"application";"source";"message"');
  });

  test('le lien Datadog reprend exactement le périmètre et la période', () => {
    const w = datadogService.resolveWindow({ range: '1h' }, now);
    const url = new URL(datadogService.logsExplorerUrl('us5.datadoghq.com', ['a-dev'], w));
    expect(url.origin).toBe('https://us5.datadoghq.com');
    expect(url.searchParams.get('query')).toBe(datadogClient.logsScopeQuery(['a-dev']));
    expect(url.searchParams.get('from_ts')).toBe(String(w.from * 1000));
  });
});

describe('alertes', () => {
  const monitors = [
    { id: 1, name: 'mine', tags: ['service:obs-alpha-dev'], overall_state: 'Alert' },
    { id: 2, name: 'theirs', tags: ['service:obs-beta-dev'], overall_state: 'OK' },
    { id: 3, name: 'untagged', tags: [], overall_state: 'OK' },
  ];

  test('seuls les moniteurs tagués avec une app autorisée sont listés', async () => {
    jest.spyOn(datadogClient, 'listMonitors').mockResolvedValue(monitors);
    const alerts = await datadogService.getAlerts(['obs-alpha-dev']);
    expect(alerts.map(a => a.name)).toEqual(['mine']);
  });

  test('silencer le moniteur d\'une autre équipe est refusé', async () => {
    jest.spyOn(datadogClient, 'getMonitor').mockResolvedValue(monitors[1]);
    const mute = jest.spyOn(datadogClient, 'silenceMonitor').mockResolvedValue({});
    await expect(datadogService.silenceAlert('2', ['obs-alpha-dev'])).rejects.toThrow('Accès refusé');
    expect(mute).not.toHaveBeenCalled();
  });

  test('une requête de moniteur ne cible que l\'app choisie', () => {
    expect(queryTargetsOnly('avg(last_5m):avg:gcp.run.container.cpu.utilizations.avg{service_name:a-dev} > 0.8', 'a-dev')).toBe(true);
    expect(queryTargetsOnly('avg(last_5m):avg:x{service_name:a-dev} + avg:x{service_name:b-dev} > 1', 'a-dev')).toBe(false);
    expect(queryTargetsOnly('avg(last_5m):avg:x{*} > 1', 'a-dev')).toBe(false);
  });
});

describe('pages', () => {
  async function login(username) {
    const res = await request(app, { method: 'POST', url: '/auth/login',
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'http://localhost:3001' },
      body: new URLSearchParams({ username, password: PASSWORD }).toString() });
    expect(res.headers.location).toBe('/');
    return cookie(res);
  }

  test('la page Logs n\'interroge que les apps de l\'équipe', async () => {
    const search = jest.spyOn(datadogClient, 'searchServiceLogs').mockResolvedValue([]);
    const page = await request(app, { url: '/observability/logs', headers: { cookie: await login('obs-alice') } });
    expect(page.status).toBe(200);
    const services = search.mock.calls[0][0].services;
    expect(services).toEqual(expect.arrayContaining(['obs-alpha-dev', 'obs-alpha-prod', 'obs-shared-dev']));
    expect(services).not.toContain('obs-beta-dev');
    expect(page.text).toContain('obs-alpha-dev');
    expect(page.text).not.toContain('obs-beta-dev');
  });

  test.each(['logs', 'logs.csv', 'metrics', 'alerts'])('/observability/%s?service=<autre équipe> renvoie 403 sans appeler Datadog', async (path) => {
    const search = jest.spyOn(datadogClient, 'searchServiceLogs');
    const metrics = jest.spyOn(datadogClient, 'getServiceMetrics');
    const list = jest.spyOn(datadogClient, 'listMonitors');
    const page = await request(app, { url: `/observability/${path}?service=obs-beta-dev`, headers: { cookie: await login('obs-alice') } });
    expect(page.status).toBe(403);
    expect(search).not.toHaveBeenCalled();
    expect(metrics).not.toHaveBeenCalled();
    expect(list).not.toHaveBeenCalled();
  });

  test('la page Métriques affiche les valeurs d\'une app de l\'équipe', async () => {
    jest.spyOn(datadogClient, 'getServiceMetrics').mockResolvedValue({
      requests: { 'obs-alpha-dev': [[1, 42]] }, errors: {}, latency: {}, cpu: {}, memory: {}, instances: {},
      ecsCpu: {}, ecsMemory: {}, ecsRunning: {},
    });
    const page = await request(app, { url: '/observability/metrics?service=obs-alpha-dev', headers: { cookie: await login('obs-alice') } });
    expect(page.status).toBe(200);
    expect(page.text).toContain('obs-alpha-dev');
    expect(page.text).toContain('42');
  });

  test('le CSV contient les logs de l\'équipe, en pièce jointe', async () => {
    const search = jest.spyOn(datadogClient, 'searchServiceLogs').mockResolvedValue([
      { attributes: { timestamp: '2026-11-10T10:00:00Z', service: 'obs-alpha-dev', message: 'hello' } },
    ]);
    const res = await request(app, { url: '/observability/logs.csv?service=obs-alpha-dev&q=hel', headers: { cookie: await login('obs-alice') } });
    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toMatch(/^attachment; filename="logs-obs-alpha-dev-/);
    expect(res.text).toContain('"obs-alpha-dev"');
    expect(search.mock.calls[0][0]).toMatchObject({ services: ['obs-alpha-dev'], text: 'hel', limit: 1000 });
  });

  test('créer une alerte pour l\'app d\'une autre équipe est refusé', async () => {
    const create = jest.spyOn(datadogClient, 'createMonitor').mockResolvedValue({});
    const res = await request(app, { method: 'POST', url: '/observability/alerts',
      headers: { cookie: await login('obs-bob'), 'content-type': 'application/x-www-form-urlencoded', origin: 'http://localhost:3001' },
      body: new URLSearchParams({ name: 'x', app: 'obs-alpha-dev', query: 'avg(last_5m):avg:x{service_name:obs-alpha-dev} > 1' }).toString() });
    expect(res.status).toBe(302);
    expect(create).not.toHaveBeenCalled();
  });

  test('un refus de périmètre affiche la page d\'erreur du portail, sauf pour l\'export CSV', async () => {
    const headers = { cookie: await login('obs-alice') };
    const page = await request(app, { url: '/observability/logs?service=obs-beta-dev', headers });
    expect(page.status).toBe(403);
    expect(page.text).toContain('Retour au dashboard');
    expect(page.text).toContain('appartient pas à votre équipe'); // l'apostrophe est échappée en HTML
    const csv = await request(app, { url: '/observability/logs.csv?service=obs-beta-dev', headers });
    expect(csv.status).toBe(403);
    expect(csv.text).not.toContain('<html');
  });

  test('une demande d\'accès n\'est visible et approuvable que par un manager de la même équipe', async () => {
    // La demande de bob (équipe B) est créée en premier : avec l'ancienne approbation par position,
    // le manager de l'équipe A aurait approuvé celle-ci en cliquant sur la seule ligne qu'il voit.
    await datadogService.requestAccess(bob.id, 'demande équipe B');
    await datadogService.requestAccess(alice.id, 'demande équipe A');
    const all = await datadogService.getAccessRequests();
    const ofBob = all.find(r => r.userId === bob.id), ofAlice = all.find(r => r.userId === alice.id);
    const headers = { cookie: await login('obs-boss'), 'content-type': 'application/x-www-form-urlencoded', origin: 'http://localhost:3001' };
    const approve = id => request(app, { method: 'POST', url: `/observability/access-request/${id}/approve`, headers, body: '' });

    // Le manager ne partage encore aucune équipe avec les demandeurs.
    await approve(ofAlice.id);
    expect(ofAlice.approved).toBe(false);

    teamService.addMember(teamA.id, boss.id);
    try {
      for (const url of ['/observability/datadog', '/observability/alerts']) {
        jest.spyOn(datadogClient, 'listMonitors').mockResolvedValue([]);
        const page = await request(app, { url, headers: { cookie: headers.cookie } });
        expect(page.text).toContain(`/observability/access-request/${ofAlice.id}/approve`);
        expect(page.text).not.toContain(ofBob.id);
      }
      await approve(ofBob.id);
      await approve('0');
      expect(ofBob.approved).toBe(false);
      await approve(ofAlice.id);
      expect(ofAlice.approved).toBe(true);
    } finally {
      teamService.removeMember(teamA.id, boss.id);
    }
  });
});
