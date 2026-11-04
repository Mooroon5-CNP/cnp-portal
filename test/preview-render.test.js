'use strict';
const { render } = require('../scripts/platform/render-preview.cjs');
const { previewId } = require('../scripts/platform/prepare-preview.cjs');
const { createHash } = require('crypto');
const id = previewId('test-project');
const reference = { schemaVersion: 1, applicationId: id, environment: 'dev', provider: 'gcs', bundleId: '11111111-1111-1111-1111-111111111111', bucket: 'cnp-vars-test', object: 'bundles/11111111-1111-1111-1111-111111111111.json', generation: '12' };
const profile = { schemaVersion: 1, service: 'cnp-portal-preview', project: 'test-project', region: 'europe-west9', runtimeAccount: `cnp-${createHash('sha256').update(id).digest('hex').slice(0, 24)}@test-project.iam.gserviceaccount.com`, bundle: { reference, names: ['TOKEN'] } };
const image = `europe-west9-docker.pkg.dev/test-project/cnp-registry/cnp-portal@sha256:${'a'.repeat(64)}`;
test('branch preview is a separate private service with pinned image and bundle, no main mutation', () => {
  const result = render(profile, image);
  expect(result.metadata.name).toBe('cnp-portal-preview'); expect(result.spec.deletionPolicy).toBe('Orphan');
  expect(result.spec.forProvider.template.containers[0].image).toBe(image);
  const env = result.spec.forProvider.template.containers[0].env;
  expect(JSON.parse(env.find(item => item.name === 'CNP_VARIABLES_REF').value)).toEqual(reference);
  expect(result.spec.forProvider.template.serviceAccount).toBe(profile.runtimeAccount);
});
test('rejects floating tags, another service or another runtime identity', () => {
  expect(() => render(profile, image.split('@')[0] + ':latest')).toThrow();
  expect(() => render({ ...profile, service: 'cnp-portal-dev' }, image)).toThrow();
  expect(() => render({ ...profile, runtimeAccount: 'shared@test-project.iam.gserviceaccount.com' }, image)).toThrow();
});
