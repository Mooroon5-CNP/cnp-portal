'use strict';

// Natural phrases measured against production routing on 23/11/2026 (see the chat review): keyword routing must no
// longer refuse questions or send "app" questions to the catalogue; Mistral comes first, keywords are the fallback.
const { classifyWithFallback } = require('../apps/orchestrator/src/typesafe/fallback-classifier');
const { createHybridClassifier } = require('../apps/orchestrator/src/typesafe/hybrid-classifier');

const tools = ['list_applications', 'get_deployment_status', 'get_application_logs', 'get_finops_recommendation'];
const context = { target: { applicationId: 'testapp09', environment: 'production' }, permissions: { allowedTools: tools } };

test.each([
  ['Qu\u2019est-ce qui a changé sur testapp09 ?', 'get_deployment_status'],
  ['Le deploy de testapp09 est ok ?', 'get_deployment_status'],
  ['Est-ce que testapp09 est sync ?', 'get_deployment_status'],
  ['Mon application a des erreurs ?', 'get_application_logs'],
  ['Pourquoi mon app est lente ?', 'get_application_logs'],
  ['Combien coûte testapp09 ?', 'get_finops_recommendation'],
  ['Quelles sont mes applications ?', 'list_applications'],
  ['Quelle version tourne en prod ?', 'get_deployment_status'],
])('keywords route "%s" to %s', (phrase, tool) => {
  expect(classifyWithFallback(phrase)).toMatchObject({ kind: 'tool', tool });
});

test.each(['Deploy majoutes-api in prod', 'supprime app-2-dancingduck', 'redémarrer le serveur', 'Déploie testapp09 en prod',
  'Peux-tu supprimer testapp09 ?', 'Change la version de testapp09', 'rollback testapp09'])('"%s" is still refused as a change', (phrase) => {
  expect(classifyWithFallback(phrase)).toMatchObject({ kind: 'mutation' });
});

test('mistral-first (default): Mistral decides; keywords only when Mistral is unavailable', async () => {
  const decide = jest.fn(async () => ({ kind: 'route', tool: 'get_application_logs' }));
  const classify = createHybridClassifier({ env: {}, decide });
  expect(await classify({ userRequest: 'Pourquoi mon app est lente ?', knownContext: context })).toMatchObject({ tool: 'get_application_logs', routedBy: 'mistral' });
  expect(decide).toHaveBeenCalled();
  const down = createHybridClassifier({ env: {}, decide: async () => ({ kind: 'routing_unavailable', reason: 'timeout' }) });
  expect(await down({ userRequest: 'Combien coûte testapp09 ?', knownContext: context })).toMatchObject({ tool: 'get_finops_recommendation', routedBy: 'keywords' });
  expect(await down({ userRequest: 'que se passe-t-il ?', knownContext: context })).toMatchObject({ kind: 'routing_unavailable' });
  const broken = createHybridClassifier({ env: {}, decide: async () => { throw new Error('boom'); } });
  expect(await broken({ userRequest: 'Montre les logs', knownContext: context })).toMatchObject({ tool: 'get_application_logs' });
});

test('a Mistral refusal of a change is still a refusal, and a change never reaches Mistral', async () => {
  const decide = jest.fn(async () => ({ kind: 'rejected', reason: 'mutation' }));
  const classify = createHybridClassifier({ env: {}, decide });
  expect(await classify({ userRequest: 'Remets la base à zéro', knownContext: context })).toMatchObject({ kind: 'mutation' });
  decide.mockClear();
  expect(await classify({ userRequest: 'supprime testapp09', knownContext: context })).toMatchObject({ kind: 'mutation' });
  expect(decide).not.toHaveBeenCalled();
});

test('an application name containing "gcp" is not a Gemini Cloud Assist question', async () => {
  const { runChatTurn } = require('../apps/orchestrator/src/chat/service');
  const events = [];
  const mcpClient = { callTool: jest.fn(async () => { throw new Error('stop after routing'); }) };
  const buildKnownContext = async () => ({ target: { applicationId: 'cnp-demo-gcp-gab', environment: 'production' }, permissions: { allowedTools: tools } });
  try {
    for await (const e of runChatTurn({ message: 'Le deploy de cnp-demo-gcp-gab est ok en prod ?' },
      { mcpClient, buildKnownContext, classify: classifyWithFallback, actor: { userId: 'u', roles: ['manager'], authenticated: true }, now: () => new Date() })) events.push(e);
  } catch { /* the stub MCP stops the turn once the tool is chosen */ }
  expect(events.some(e => e.type === 'error' && e.code === 'GCA_NOT_ENABLED')).toBe(false);
  expect(mcpClient.callTool.mock.calls[0][0]).toBe('get_deployment_status');
  const gca = [];
  for await (const e of runChatTurn({ message: 'que dit gcp sur mes services ?' },
    { mcpClient, buildKnownContext, classify: classifyWithFallback, actor: { userId: 'u', roles: ['manager'], authenticated: true }, now: () => new Date() })) gca.push(e);
  expect(gca.at(-1)).toMatchObject({ code: 'GCA_NOT_ENABLED' });
});
