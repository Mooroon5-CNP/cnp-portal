'use strict';

const { observedServiceStatus } = require('../src/clients/kubernetes');

function resource() {
  return { status: { conditions: [{ type: 'Ready', status: 'True' }, { type: 'Synced', status: 'True' }], atProvider: {
    terminalCondition: [{ type: 'Ready', state: 'CONDITION_SUCCEEDED' }],
    conditions: [{ type: 'RoutesReady', state: 'CONDITION_SUCCEEDED' }, { type: 'ConfigurationsReady', state: 'CONDITION_SUCCEEDED' }],
    generation: '2', observedGeneration: '2', reconciling: false,
    latestCreatedRevision: 'revision-2', latestReadyRevision: 'revision-2', uri: 'https://service.test',
    template: { containers: [{ image: 'registry.test/app:observed' }] },
  } } };
}

test('the verified Crossplane terminalCondition schema reports the observed image as ready', () => {
  expect(observedServiceStatus(resource())).toMatchObject({ ready: true, url: 'https://service.test', image: 'registry.test/app:observed' });
});

test('unobserved generation, active reconciliation and mismatched revisions are not ready', () => {
  for (const change of [{ observedGeneration: '1' }, { reconciling: true }, { latestReadyRevision: 'revision-1' }]) {
    const body = resource(); Object.assign(body.status.atProvider, change);
    expect(observedServiceStatus(body).ready).toBe(false);
  }
});

test('a desired spec and an old URI never substitute for actual cloud readiness', () => {
  const body = resource(); body.spec = { forProvider: { template: { containers: [{ image: 'registry.test/app:new' }] } } };
  body.status.atProvider.terminalCondition[0] = { type: 'Ready', state: 'CONDITION_FAILED', message: 'Image not found.' };
  expect(observedServiceStatus(body)).toMatchObject({ ready: false, image: 'registry.test/app:observed', failure: 'Image not found.' });
});

test('large generation counters compare without precision loss and missing metadata fails closed', () => {
  const body = resource(); body.status.atProvider.generation = '9007199254740993'; body.status.atProvider.observedGeneration = '9007199254740992';
  expect(observedServiceStatus(body).ready).toBe(false);
  expect(observedServiceStatus({}).ready).toBe(false);
});
