'use strict';

const { runFleetTurn, fleetPlan, MAX_TARGETS } = require('../apps/orchestrator/src/chat/fleet');
const { inputSchemas, responseSchemas, chatEventSchema } = require('../packages/contracts/src');

const NOW = '2026-11-24T14:00:00.000Z';
const correlationId = '00000000-0000-4000-8000-000000000001';
const meta = (tool, sources) => ({ schemaVersion: '1.0', tool, correlationId, generatedAt: NOW, sources });
const app = (id, envs = ['dev', 'prod']) => ({ applicationId: id, name: id, team: 't', repositoryUrl: 'https://x/' + id,
  environments: envs.map(name => ({ name, enabled: true })) });
const status = ({ applicationId, environment }, sync = 'Synced', health = 'Healthy') => ({ status: 'success', warnings: [], errors: [],
  meta: meta('get_deployment_status', [{ source: 'argo', status: 'available', retrievedAt: NOW }]),
  data: { applicationId, environment, desiredState: { version: 'abcdef1', imageDigest: null, sourceRevision: null },
    observedState: { version: 'abcdef1', imageDigest: null, syncStatus: sync, healthStatus: health }, driftDetected: false, lastDeploymentAt: null } });

function client(apps, statusFor) {
  return { callTool: jest.fn(async (tool, args) => {
    if (tool === 'list_applications') return { status: 'success', warnings: [], errors: [],
      meta: meta(tool, [{ source: 'platform', status: 'available', retrievedAt: NOW }]), data: { applications: apps, nextCursor: null } };
    return statusFor(args);
  }) };
}
async function run(plan, mcpClient) {
  const events = [];
  for await (const e of runFleetTurn({ message: 'test', plan, correlationId },
    { mcpClient, inputSchemas, responseSchemas, now: () => new Date(NOW) }, value => chatEventSchema.parse(value))) events.push(e);
  return events;
}

test('only problems are shown; an unavailable source is reported, never hidden', async () => {
  const mcpClient = client([app('ok-app'), app('bad-app', ['prod']), app('down-app', ['dev'])], (args) => {
    if (args.applicationId === 'down-app') throw new Error('MCP_TIMEOUT');
    return args.applicationId === 'bad-app' ? status(args, 'OutOfSync', 'Degraded') : status(args);
  });
  const events = await run({ tool: 'get_deployment_status', onlyProblems: true, scope: {} }, mcpClient);
  const results = events.filter(e => e.type === 'tool_result');
  expect(results.map(e => e.result.data.applicationId)).toEqual(['bad-app']);
  const text = events.find(e => e.type === 'answer_delta').text;
  expect(text).toMatch(/1 environnement\(s\) désynchronisé\(s\)[\s\S]*bad-app\/prod : OutOfSync\/Degraded/);
  expect(text).toMatch(/Sources indisponibles pour : down-app\/dev/);
  expect(events.find(e => e.type === 'tool_completed' && e.tool === 'get_deployment_status').status).toBe('partial');
});

test('at most MAX_TARGETS environments are queried and the user is told', async () => {
  const many = Array.from({ length: 10 }, (_, i) => app(`app-${i}`));
  const mcpClient = client(many, args => status(args));
  const events = await run({ tool: 'get_deployment_status', onlyProblems: true, scope: {} }, mcpClient);
  expect(mcpClient.callTool.mock.calls.filter(([tool]) => tool === 'get_deployment_status')).toHaveLength(MAX_TARGETS);
  expect(events.find(e => e.type === 'answer_delta').text).toMatch(/Tout est synchronisé[\s\S]*Seuls les 12 premiers/);
});

test('a known application or environment narrows the fleet; "toutes les apps" widens it', () => {
  expect(fleetPlan({ tool: 'get_application_logs', message: 'les logs', target: { applicationId: 'a' }, argsMissing: true }).scope)
    .toEqual({ applicationId: 'a', environment: undefined });
  expect(fleetPlan({ tool: 'get_application_logs', message: 'les logs de toutes les apps', target: { applicationId: 'a', environment: 'production' }, argsMissing: false }).scope).toEqual({});
  expect(fleetPlan({ tool: 'get_deployment_status', message: 'statut', target: { applicationId: 'a', environment: 'production' }, argsMissing: false })).toBeNull();
  expect(fleetPlan({ tool: 'list_applications', message: 'liste les applications' })).toBeNull();
  expect(fleetPlan({ tool: 'list_applications', message: 'quelles applications ne sont pas synchronisées ?' })).toMatchObject({ tool: 'get_deployment_status', onlyProblems: true });
  expect(fleetPlan({ tool: 'get_finops_recommendation', message: 'toutes les apps', argsMissing: true })).toBeNull();
});
