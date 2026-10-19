'use strict';

const { createApplicationResolver } = require('../apps/orchestrator/src/generation/application');
const env = { GENAI_ENABLED: 'true', GENAI_API_KEY: 'not-a-real-key', GENAI_MODEL: 'test-model' };
const applications = [{ applicationId: 'app-2-dancingduck', name: 'Dancing Duck', privateKey: 'never-forward' }];

test('semantic matching receives only the message and minimal authorized catalog', async () => {
  const generate = jest.fn(async () => ({ applicationId: 'app-2-dancingduck', confidence: 'high' }));
  const resolve = createApplicationResolver({ env, generate });
  expect(await resolve({ message: 'le canard Bearer private-token', applications })).toBe('app-2-dancingduck');
  const prompt = generate.mock.calls[0][0].prompt;
  expect(prompt).toContain('app-2-dancingduck');
  expect(prompt).not.toMatch(/never-forward|private-token|not-a-real-key/);
});

test('low-confidence and out-of-catalog suggestions keep clarification pending', async () => {
  for (const candidate of [
    { applicationId: 'app-2-dancingduck', confidence: 'low' },
    { applicationId: 'other-team-app', confidence: 'high' },
    { applicationId: null, confidence: 'low' },
  ]) {
    const resolve = createApplicationResolver({ env, generate: async () => candidate });
    expect(await resolve({ message: 'le canard', applications })).toBeNull();
  }
});

test('disabled semantic AI needs no credentials and does not generate', () => {
  expect(createApplicationResolver({ env: { GENAI_ENABLED: 'false' } })).toBeUndefined();
});

test('an enabled but incomplete configuration fails without exposing credentials', async () => {
  const resolve = createApplicationResolver({ env: { GENAI_ENABLED: 'true' } });
  await expect(resolve({ message: 'le canard', applications })).rejects.toThrow('GENAI_NOT_CONFIGURED');
});
