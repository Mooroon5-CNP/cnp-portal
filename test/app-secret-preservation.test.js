'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

jest.mock('child_process', () => ({ spawnSync: jest.fn() }));

test('a general credential refresh retains unrelated and voice Secret keys', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cnp-app-secret-test-'));
  const credentials = path.join(dir, 'credentials.env');
  const oauth = path.join(dir, 'oauth.env');
  fs.writeFileSync(credentials, [
    'ADMIN_INITIAL_PASSWORD=0123456789abcdef',
    'GITHUB_APP_ID=123',
    'GITHUB_APP_PRIVATE_KEY=test-key',
    'GITHUB_APP_INSTALLATION_ID=456',
    'GITHUB_CONFIG_REPO_NAME=config-repo',
    'DD_API_KEY=new-datadog-key',
    'DD_APP_KEY=app-key',
  ].join('\n'));
  fs.writeFileSync(oauth, 'GITHUB_CLIENT_ID=client-id\nGITHUB_CLIENT_SECRET=client-secret\n');
  const old = value => Buffer.from(value).toString('base64');
  let replacement;
  spawnSync.mockImplementation((command, args, options) => {
    expect(command).toBe('kubectl');
    if (args.includes('cnp-portal-app-env')) {
      return { status: 0, stdout: JSON.stringify({
        metadata: { resourceVersion: '42' },
        data: {
          SESSION_SECRET: old('stable-session'),
          SCW_SECRET_KEY: old('stable-voice-key'),
          VOICE_DEPLOYMENT_ANALYSIS_MODEL: old('stable-model'),
          FUTURE_FEATURE_KEY: old('must-stay'),
          DD_SITE: old('datadoghq.eu'),
        },
      }) };
    }
    if (args.includes('argocd-secret')) {
      return { status: 0, stdout: JSON.stringify({ data: { 'tls.crt': old('cert') } }) };
    }
    if (args[0] === 'replace') {
      replacement = JSON.parse(options.input);
      return { status: 0, stdout: '' };
    }
    throw new Error(`Unexpected kubectl arguments: ${args.join(' ')}`);
  });
  const previousArgv = process.argv;
  const log = jest.spyOn(console, 'log').mockImplementation(() => {});
  try {
    process.argv = ['node', 'apply-app-secret.js', credentials, '--oauth-file', oauth,
      '--oauth-callback-registered'];
    jest.isolateModules(() => require('../scripts/deploy/apply-app-secret'));
    expect(replacement.metadata.resourceVersion).toBe('42');
    expect(Buffer.from(replacement.data.FUTURE_FEATURE_KEY, 'base64').toString()).toBe('must-stay');
    expect(Buffer.from(replacement.data.SCW_SECRET_KEY, 'base64').toString()).toBe('stable-voice-key');
    expect(Buffer.from(replacement.data.VOICE_DEPLOYMENT_ANALYSIS_MODEL, 'base64').toString()).toBe('stable-model');
    expect(Buffer.from(replacement.data.SESSION_SECRET, 'base64').toString()).toBe('stable-session');
    expect(Buffer.from(replacement.data.DD_SITE, 'base64').toString()).toBe('datadoghq.eu');
    expect(Buffer.from(replacement.data.DD_API_KEY, 'base64').toString()).toBe('new-datadog-key');
  } finally {
    process.argv = previousArgv;
    log.mockRestore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
