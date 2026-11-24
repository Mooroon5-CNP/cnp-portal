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
