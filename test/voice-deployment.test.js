'use strict';

const voice = require('../src/services/voice-deployment');
const env = {
  SCW_SECRET_KEY: 'test-secret',
  REPORT_MODEL_API_KEY: 'test-analysis-secret',
  VOICE_DEPLOYMENT_GATEWAY_BASE_URL: 'https://api.scaleway.ai/53dabd61-d11a-46f3-be72-1a992593284f/v1',
  VOICE_DEPLOYMENT_ANALYSIS_MODEL: 'test-analysis-model',
};

function proposal(fields = {}) {
  return {
    environment: { value: 'prod', source: 'explicit', reason: 'Version destinée aux utilisateurs.' },
    stack: { value: 'gcp-postgres', source: 'recommended', reason: 'Base PostgreSQL déjà utilisée.' },
    billing: { value: 'instance', source: 'recommended', reason: 'Accès fréquent sans attente.' },
    appPort: { value: 8080, source: 'explicit', reason: 'Port annoncé.' },
    ownerTeamId: null, missing: [], ...fields,
  };
}

test('Whisper uses multipart audio/transcriptions with server-side bearer key', async () => {
  const audio = Buffer.alloc(48);
  audio.write('RIFF', 0); audio.write('WAVE', 8);
  const transport = jest.fn(async (url, options) => {
    expect(url).toBe(`${env.VOICE_DEPLOYMENT_GATEWAY_BASE_URL}/audio/transcriptions`);
    expect(options.headers.Authorization).toBe('Bearer test-secret');
    expect(options.body.get('model')).toBe('whisper-large-v3');
    expect(options.body.get('language')).toBe('fr');
    expect(options.body.get('file').name).toBe('reponse.wav');
    return { ok: true, json: async () => ({ text: 'Une application publique.' }) };
  });
  expect(await voice.transcribe(audio, env, transport)).toBe('Une application publique.');
  expect(transport).toHaveBeenCalledTimes(1);
});

test('audio is rejected before any provider call when malformed', async () => {
  const transport = jest.fn();
  await expect(voice.transcribe(Buffer.from('not audio'), env, transport)).rejects.toThrow('WAV invalide');
  expect(transport).not.toHaveBeenCalled();
});

test('analysis uses a separate configurable model and returns only draft fields', async () => {
  const transport = jest.fn(async (url, options) => {
    expect(url).toBe(`${env.VOICE_DEPLOYMENT_GATEWAY_BASE_URL}/chat/completions`);
    const body = JSON.parse(options.body);
    expect(options.headers.Authorization).toBe('Bearer test-analysis-secret');
    expect(body.model).toBe('test-analysis-model');
    expect(body.response_format.type).toBe('json_schema');
    expect(body.response_format.json_schema.schema.required).toContain('stack');
    expect(body.max_tokens).toBeGreaterThan(700);
    expect(body.messages[1].content).toContain('PostgreSQL');
    return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(proposal()) } }] }) };
  });
  const result = await voice.analyze([
    { id: 'purpose', text: 'Application publique.' },
    { id: 'environment', text: 'Production pour les utilisateurs.' },
    { id: 'data', text: 'Elle conserve les comptes.' },
    { id: 'database', text: 'Nous utilisons PostgreSQL.' },
    { id: 'traffic', text: 'Accès fréquent.' },
    { id: 'technical', text: 'Le port est 8080.' },
  ], [], env, transport);
  expect(result.fields).toMatchObject({ environment: 'prod', stack: 'gcp-postgres', billing: 'instance', appPort: '8080' });
  expect(result.notes.stack).toContain('Recommandation');
  expect(transport).toHaveBeenCalledTimes(1);
});

test.each([
  ['MySQL', 'gcp-postgres'], ['SQLite', 'azure-postgres'], ['PostgreSQL', 'gcp-sqlite'],
])('incompatible database %s cannot be silently mapped to %s', (database, stack) => {
  const result = voice.normalizeProposal(proposal({ stack: { value: stack, source: 'recommended', reason: 'Hypothèse.' } }), [],
    [{ id: 'database', text: `Nous utilisons ${database}.` }]);
  expect(result.fields.stack).toBeUndefined();
  expect(result.fields.billing).toBeUndefined();
  expect(result.missing).toContain('stack');
});

test('port and team are only filled from an explicit answer and an accessible team', () => {
  const fields = { ownerTeamId: { value: 'team-1', source: 'explicit', reason: 'Équipe annoncée.' } };
  const rejected = voice.normalizeProposal(proposal(fields), [{ id: 'team-1', name: 'Atlas' }], []);
  expect(rejected.fields.appPort).toBeUndefined();
  expect(rejected.fields.ownerTeamId).toBeUndefined();
  const accepted = voice.normalizeProposal(proposal(fields), [{ id: 'team-1', name: 'Atlas' }],
    [{ id: 'technical', text: 'Notre application écoute sur 8080, équipe Atlas.' }]);
  expect(accepted.fields.appPort).toBe('8080');
  expect(accepted.fields.ownerTeamId).toBe('team-1');
});

test('unknown answers leave fields empty and return a usable draft', () => {
  const unknown = { value: '', source: 'unknown', reason: '' };
  const result = voice.normalizeProposal({ environment: unknown, stack: unknown, billing: unknown,
    appPort: unknown, ownerTeamId: unknown, missing: ['base de données inconnue'] }, [], []);
  expect(result.fields).toEqual({});
  expect(result.missing).toEqual(expect.arrayContaining(['environment', 'stack', 'appPort', 'base de données inconnue']));
});

test('analysis JSON can be extracted from a text or Markdown response', () => {
  const value = proposal();
  expect(voice.parseModelJson(`Voici la proposition :\n\`\`\`json\n${JSON.stringify(value)}\n\`\`\``)).toEqual(value);
  expect(voice.parseModelJson(`Résultat demandé : ${JSON.stringify(value)} Fin.`)).toEqual(value);
  expect(() => voice.parseModelJson('Aucun objet JSON valide')).toThrow('Réponse d’analyse invalide');
});

test('missing credentials or analysis model prevents outbound inference', async () => {
  const transport = jest.fn();
  await expect(voice.analyze([{ id: 'purpose', text: 'Test' }], [], { ...env, VOICE_DEPLOYMENT_ANALYSIS_MODEL: '' }, transport))
    .rejects.toThrow('non configuré');
  await expect(voice.analyze([{ id: 'purpose', text: 'Test' }], [], { ...env, REPORT_MODEL_API_KEY: '' }, transport))
    .rejects.toThrow('clé du modèle absente');
  expect(transport).not.toHaveBeenCalled();
  expect(voice.configured({ ...env, SCW_SECRET_KEY: '' })).toBe(false);
  expect(voice.configured({ ...env, REPORT_MODEL_API_KEY: '' })).toBe(false);
  expect(voice.configured({ ...env, VOICE_DEPLOYMENT_ANALYSIS_MODEL: '' })).toBe(false);
  expect(voice.configured(env)).toBe(true);
});

test('project override follows AI Report configuration without exposing the key', async () => {
  const alternate = '01234567-89ab-cdef-0123-456789abcdef';
  const transport = jest.fn(async url => {
    expect(url).toBe(`https://api.scaleway.ai/${alternate}/v1/audio/transcriptions`);
    return { ok: true, json: async () => ({ text: 'Bonjour.' }) };
  });
  const audio = Buffer.alloc(48);
  audio.write('RIFF', 0); audio.write('WAVE', 8);
  await voice.transcribe(audio, { ...env, SCW_DEFAULT_PROJECT_ID: alternate }, transport);
  expect(voice.configured({ ...env, SCW_DEFAULT_PROJECT_ID: 'bad-project' })).toBe(false);
});
