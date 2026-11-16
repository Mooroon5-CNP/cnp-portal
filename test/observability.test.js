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
  test('le filtre de logs couvre Cloud Run (service) et ECS (flux de logs)', () => {
    expect(datadogClient.logsScopeQuery(['a-dev', 'b-prod']))
      .toBe('(service:(a-dev OR b-prod) OR @aws.awslogs.logStream:(a-dev\\/* OR b-prod\\/*))');
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
    expect(c).toEqual({ service: 'c-dev', cloudRun: null, ecs: null });
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
