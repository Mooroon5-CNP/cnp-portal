'use strict';
jest.mock('../src/config/env', () => ({ config: { github: { registryUrl: 'europe-west9-docker.pkg.dev/cnp-terraform-512313/cnp-registry' } } }));
jest.mock('../src/clients/github', () => ({ getInstallationOctokit: jest.fn(), getRef: jest.fn() }));
const { execFileSync } = require('child_process');
const github = require('../src/clients/github');
const images = require('../src/services/failover-ci-images');
const revision = 'a'.repeat(40);
const digest = `sha256:${'b'.repeat(64)}`;
const dep = { id: 'deployment', appName: 'telemetry-api', environment: 'prod', githubRepoUrl: 'https://github.com/team/telemetry' };
let record, run, artifacts, api;
function zip(value) {
  return execFileSync('python3', ['-c', "import io,sys,zipfile; b=io.BytesIO(); z=zipfile.ZipFile(b,'w'); z.writestr('cnp-images.json',sys.stdin.buffer.read()); z.close(); sys.stdout.buffer.write(b.getvalue())"], { input: JSON.stringify(value) });
}
beforeEach(() => {
  record = { app: dep.appName, revision, digest,
    gcp: `europe-west9-docker.pkg.dev/cnp-terraform-512313/cnp-registry/${dep.appName}@${digest}`,
    aws: `626278345026.dkr.ecr.eu-west-3.amazonaws.com/${dep.appName}@${digest}` };
  run = { id: 10, head_sha: revision, head_branch: 'prod', status: 'completed', conclusion: 'success' };
  artifacts = [{ id: 1, name: `cnp-failover-images-${revision}`, expired: false, size_in_bytes: 1000 }];
  api = { request: jest.fn(async route => {
    if (route.includes('/workflows/')) return { data: { workflow_runs: [run] } };
    if (route.includes('/runs/')) return { data: { artifacts } };
    return { data: zip(record) };
  }) };
  github.getInstallationOctokit.mockResolvedValue(api);
  github.getRef.mockResolvedValue(revision);
});
test('les deux images sont liées au pipeline réussi et à la branche courante', async () => {
  expect(await images.resolve(dep)).toEqual({ ...record, runId: 10, deploymentId: dep.id });
  expect(api.request.mock.calls.every(([route]) => route.startsWith('GET'))).toBe(true);
});
test('une autre application, un registre étranger ou deux images différentes sont refusés', () => {
  for (const patch of [{ app: 'other' }, { revision: 'c'.repeat(40) }, { aws: 'registry.invalid/image' }, { digest: 'latest' }]) {
    expect(() => images.validate({ ...record, ...patch }, dep, revision)).toThrow('incohérentes');
  }
});
test('une CI échouée, une branche modifiée ou une preuve expirée ne permet aucune publication', async () => {
  run.conclusion = 'failure';
  await expect(images.resolve(dep)).rejects.toThrow('réussi');
  run.conclusion = 'success'; github.getRef.mockResolvedValue('c'.repeat(40));
  await expect(images.resolve(dep)).rejects.toThrow('branche');
  github.getRef.mockResolvedValue(revision); artifacts[0].expired = true;
  await expect(images.resolve(dep)).rejects.toThrow('Preuve');
});
