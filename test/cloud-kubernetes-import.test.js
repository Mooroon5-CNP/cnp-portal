'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const dotenv = require('dotenv');
const { CLOUD_KEYS } = require('../src/config/cloud-env');
const { main } = require('../scripts/cloud/import-kubernetes');
const context = 'gke_test-project_europe-west9-b_test-cluster';
let directory;
beforeEach(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cnp-cloud-import-')); });
afterEach(() => fs.rmSync(directory, { recursive: true, force: true }));
function contract() {
  return { ...Object.fromEntries(CLOUD_KEYS.map(key => [key, 'fixture'])), GCP_PROJECT: 'test-project',
    KUBE_API_URL: 'https://cluster.example.test', ARGOCD_TOKEN: '', SESSION_SECRET: 'must-not-import', GENAI_API_KEY: 'must-not-import' };
}
function runner(values) {
  return jest.fn((_command, args) => JSON.stringify(args.includes('view')
    ? { clusters: [{ cluster: { server: 'https://cluster.example.test' } }] }
    : { data: Object.fromEntries(Object.entries(values).map(([key, value]) => [key, Buffer.from(value).toString('base64')])) }));
}
function args() { return ['--context', context, '--project', 'test-project', '--output', path.join(directory, '.env.cloud')]; }
test('imports the complete matching cloud contract without touching application credentials', () => {
  const run = runner(contract()); const result = main(args(), { run });
  const imported = dotenv.parse(fs.readFileSync(result.output));
  expect(imported.KUBE_API_URL).toBe('https://cluster.example.test');
  expect(imported.KUBE_TOKEN).toBe('fixture');
  expect(imported.SESSION_SECRET).toBeUndefined();
  expect(imported.GENAI_API_KEY).toBeUndefined();
  expect(fs.statSync(result.output).mode & 0o777).toBe(0o600);
  expect(run.mock.calls[1][1]).toEqual(expect.arrayContaining(['get', 'secret', 'cnp-portal-cloud-env', '--namespace=cnp-portal']));
});
test.each([{ GCP_PROJECT: 'wrong-project' }, { KUBE_API_URL: 'https://old-cluster.test' }])('rejects mismatched cluster contracts: %j', change => {
  const output = path.join(directory, '.env.cloud'); fs.writeFileSync(output, 'previous');
  expect(() => main(args(), { run: runner({ ...contract(), ...change }) })).toThrow('does not match');
  expect(fs.readFileSync(output, 'utf8')).toBe('previous');
});
test('refuses partial credentials instead of mixing new endpoints and old tokens', () => {
  const values = contract(); delete values.KUBE_TOKEN;
  expect(() => main(args(), { run: runner(values) })).toThrow('missing KUBE_TOKEN');
  expect(fs.existsSync(path.join(directory, '.env.cloud'))).toBe(false);
});
test('cluster read failures never expose kubectl output or overwrite the existing file', () => {
  const run = jest.fn(() => { throw new Error('secret-output-never-print'); });
  expect(() => main(args(), { run })).toThrow('Cannot read');
  expect(() => main(args(), { run })).not.toThrow('secret-output-never-print');
});
