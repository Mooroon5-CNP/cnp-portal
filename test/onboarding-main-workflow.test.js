'use strict';

jest.mock('../src/config/env', () => ({ config: {
  github: { configRepoName: 'Mooroon5-CNP/config-repo', configRepoToken: 'test-token',
    wifProvider: 'test-provider', gcpSaEmail: 'ci@test', registryUrl: 'registry.test/project/apps' },
  gcp: { project: 'test-project', region: 'europe-west9', imageRegistry: 'registry.test/project/apps', cloudRunSa: 'runtime@test' },
  cluster: { baseDomain: 'example.test' },
} }));
jest.mock('../src/clients/github', () => ({
  checkActionsEnabled: jest.fn(), getFileSha: jest.fn(), createOrUpdateFile: jest.fn(),
  setRepoSecret: jest.fn(), setRepoVariable: jest.fn(), getRef: jest.fn().mockResolvedValue('head'), createBranch: jest.fn(),
}));
jest.mock('../src/services/github', () => ({
  parseRepoUrl: jest.fn(url => { const [, owner, repo] = new URL(url).pathname.split('/'); return { owner, repo: repo.replace(/\.git$/, '') }; }),
  getFileSha: jest.fn(), getFileContent: jest.fn(), createOrUpdateFileWithToken: jest.fn(),
}));
jest.mock('../src/clients/kubernetes', () => ({ applyApplicationSet: jest.fn(), isCertManagerAvailable: jest.fn().mockResolvedValue(false) }));
jest.mock('../src/clients/argocd', () => ({}));

const github = require('../src/clients/github');
const files = require('../src/services/github');
const { onboardApp } = require('../src/services/onboarding');
const yaml = require('js-yaml');
const options = { appName: 'pixelcam', githubRepoUrl: 'https://github.com/team/pixelcalm', appPort: 8080, targetCluster: 'gcp' };

beforeEach(() => { jest.clearAllMocks(); files.getFileContent.mockResolvedValue('apps: []'); });

test('main delegates image promotion to the reusable pipeline once', async () => {
  const updateStatus = jest.fn();
  await onboardApp({ ...options, updateStatus });
  expect(updateStatus).toHaveBeenLastCalledWith('ready', null);
  const write = github.createOrUpdateFile.mock.calls.find(call => call[2] === '.github/workflows/ci.yml');
  const workflow = yaml.load(write[3]);
  expect(workflow.on.push.branches).toEqual(['main']);
  expect(Object.keys(workflow.jobs)).toEqual(['pipeline']);
  expect(workflow.jobs.pipeline.with.app_name).toBe('pixelcam');
});

test('an existing repository cannot be onboarded under a second app name', async () => {
  files.getFileContent.mockResolvedValue(yaml.dump({ apps: [{ app_name: 'pixelcalm', repo_url: 'https://github.com/TEAM/PIXELCALM.git' }] }));
  const updateStatus = jest.fn();
  await onboardApp({ ...options, updateStatus });
  expect(updateStatus).toHaveBeenLastCalledWith('failed', expect.stringContaining('pixelcalm'));
  expect(files.createOrUpdateFileWithToken).not.toHaveBeenCalled();
  expect(github.createOrUpdateFile).not.toHaveBeenCalled();
  expect(github.setRepoSecret).not.toHaveBeenCalled();
});

test('the existing app can be retried using the same repository', async () => {
  files.getFileContent.mockResolvedValue(yaml.dump({ apps: [{ app_name: 'pixelcam', repo_url: options.githubRepoUrl }] }));
  const updateStatus = jest.fn();
  await onboardApp({ ...options, updateStatus });
  expect(updateStatus).toHaveBeenLastCalledWith('ready', null);
});

test('a registry access failure stops onboarding before any files are overwritten', async () => {
  files.getFileContent.mockRejectedValueOnce(Object.assign(new Error('Registry access denied'), { response: { status: 403 } }));
  const updateStatus = jest.fn();
  await onboardApp({ ...options, updateStatus });
  expect(updateStatus).toHaveBeenLastCalledWith('failed', 'Registry access denied');
  expect(files.createOrUpdateFileWithToken).not.toHaveBeenCalled();
  expect(github.createOrUpdateFile).not.toHaveBeenCalled();
});
