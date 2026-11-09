'use strict';
const { additivePatch } = require('../src/services/application-set-preservation');
const azure = 'apps/cnp-test-azure/crossplane/prod';
const pixel = 'apps/app4-pixelcam/crossplane/prod';
const existing = () => ({ metadata: { resourceVersion: '42' }, spec: {
  generators: [{ git: { repoURL: 'https://github.com/Mooroon5-CNP/config-repo.git', revision: 'main',
    directories: [{ path: azure }] } }],
  template: { spec: { project: 'team-cnp-prod' } }, syncPolicy: { unrelated: true },
} });
test('une base locale vide conserve Azure et le template existant', () => {
  const before = existing();
  const snapshot = JSON.stringify(before);
  const patch = additivePatch(before, []);
  expect(patch[0]).toEqual({ op: 'test', path: '/metadata/resourceVersion', value: '42' });
  expect(patch[1].value).toEqual([{ path: azure }]);
  expect(patch[2].value).toEqual({ unrelated: true, preserveResourcesOnDeletion: true, applicationsSync: 'create-update' });
  expect(patch.some(item => item.path.includes('template'))).toBe(false);
  expect(JSON.stringify(before)).toBe(snapshot);
});
test('Pixelcalm est ajouté sans doublon ni perte des exclusions existantes', () => {
  const before = existing();
  before.spec.generators[0].git.directories.push({ path: 'apps/excluded/**', exclude: true });
  const patch = additivePatch(before, [pixel, pixel]);
  expect(patch[1].value).toEqual([{ path: azure }, { path: 'apps/excluded/**', exclude: true }, { path: pixel }]);
});
test('une forme inconnue ou une exclusion explicite bloque la mutation', () => {
  expect(() => additivePatch({ spec: {} }, [pixel])).toThrow('inattendu');
  const before = existing();
  before.spec.generators[0].git.directories.push({ path: pixel, exclude: true });
  expect(() => additivePatch(before, [pixel])).toThrow('exclue');
});
