'use strict';

jest.mock('../src/services/voice-deployment', () => ({
  VoiceError: class VoiceError extends Error { constructor(message, status = 400) { super(message); this.status = status; } },
  QUESTION_IDS: ['purpose', 'environment', 'data', 'database', 'traffic', 'cloud', 'technical'],
  transcribe: jest.fn(), analyze: jest.fn(),
}));
jest.mock('../src/services/teams', () => ({ getTeamsForUser: jest.fn(() => []) }));
jest.mock('../src/services/github', () => ({ parseRepoUrl: jest.fn(() => ({ owner: 'org', repo: 'app' })) }));
jest.mock('../src/services/repository-database', () => ({ assertCompatible: jest.fn() }));

const router = require('../src/routes/voice-deployment');
const voice = require('../src/services/voice-deployment');
const database = require('../src/services/repository-database');
const handle = router.stack.find(layer => layer.route?.path === '/analyze').route.stack.at(-1).handle;

function response() {
  return { status: jest.fn().mockReturnThis(), json: jest.fn() };
}

beforeEach(() => {
  jest.clearAllMocks();
  database.assertCompatible.mockResolvedValue({ engine: 'postgres' });
});

test('valid prefill returns a draft and only checks repository compatibility', async () => {
  voice.analyze.mockResolvedValue({ fields: { environment: 'dev', stack: 'gcp-postgres' },
    notes: { stack: 'Recommandation : PostgreSQL.' }, missing: [] });
  const res = response();
  await handle({ body: { answers: [], githubRepoUrl: 'https://github.com/org/app', appName: 'my-app' },
    user: { id: 'user-1' } }, res);
  expect(database.assertCompatible).toHaveBeenCalledWith({ owner: 'org', repo: 'app' }, { environment: 'dev', selected: 'postgres' });
  expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ fields: { environment: 'dev', stack: 'gcp-postgres' } }));
});

test('a database mismatch leaves hosting to complete instead of substituting a choice', async () => {
  voice.analyze.mockResolvedValue({ fields: { environment: 'prod', stack: 'gcp-sqlite', billing: 'usage' },
    notes: { stack: 'Recommandation.', billing: 'Recommandation.' }, missing: [] });
  database.assertCompatible.mockRejectedValue(new Error('database mismatch'));
  const res = response();
  await handle({ body: { answers: [], githubRepoUrl: 'https://github.com/org/app', appName: 'my-app' },
    user: { id: 'user-1' } }, res);
  expect(res.json.mock.calls[0][0].fields).toEqual({ environment: 'prod' });
  expect(res.json.mock.calls[0][0].missing).toContain('Hébergement : vérifier la compatibilité avec la base de données du dépôt.');
});

test('invalid manual identity is rejected before analysis', async () => {
  const res = response();
  await handle({ body: { answers: [], githubRepoUrl: 'http://github.com/org/app', appName: 'my-app' },
    user: { id: 'user-1' } }, res);
  expect(res.status).toHaveBeenCalledWith(400);
  expect(voice.analyze).not.toHaveBeenCalled();
});
