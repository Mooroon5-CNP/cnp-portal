'use strict';

const { createKnownContextBuilder, AmbiguousContextError } = require('./known-context-builder');

const applications = [
  { applicationId: 'example-api', name: 'Example API', environments: [{ name: 'dev', enabled: true }, { name: 'prod', enabled: false }] },
  { applicationId: 'billing-api', name: 'Billing API', environments: [{ name: 'dev', enabled: true }, { name: 'prod', enabled: true }] },
  { applicationId: 'payment-api-eu', name: 'Payment API Europe', environments: [{ name: 'prod', enabled: true }] },
  { applicationId: 'payment-api-us', name: 'Payment API USA', environments: [{ name: 'prod', enabled: true }] },
];
const actor = { userId: 'opaque-user-id', roles: ['dev'], authenticated: true };

function builder(catalog = applications) {
  const build = createKnownContextBuilder({ listApplications: async () => catalog });
  return (input = {}) => build({ actor, ...input });
}

describe('KnownContextV1 builder', () => {
  test('1. validates portal selection and builds required server sections', async () => {
    const context = await builder()({
      portalContext: {
        applicationId: 'example-api', environment: 'development', openPage: 'logs',
        selectedTab: 'errors', language: 'fr', timezone: 'Europe/Paris',
      },
    });
    expect(context).toMatchObject({
      schemaVersion: '1.0', actor,
      navigation: { openPage: 'logs', selectedTab: 'errors' },
      target: { applicationId: 'example-api', environment: 'development' },
      permissions: { allowedTools: expect.arrayContaining(['get_application_logs']) },
      locale: { language: 'fr', timezone: 'Europe/Paris' },
    });
  });

  test('2. validates page and server-confirmed conversation context', async () => {
    const context = await builder()({
      pageContext: { openPage: 'deployment' },
      confirmedConversationContext: { applicationId: 'billing-api', environment: 'prod' },
    });
    expect(context.target).toEqual({ applicationId: 'billing-api', environment: 'production' });
    expect(context.conversation).toEqual({
      confirmedApplicationId: 'billing-api', confirmedEnvironment: 'production',
    });
  });

  test('3. omits invalid and disabled environments', async () => {
    const invalid = await builder()({ portalContext: { applicationId: 'example-api', environment: 'qa' } });
    const disabled = await builder()({ portalContext: { applicationId: 'example-api', environment: 'production' } });
    expect(invalid.target).toEqual({ applicationId: 'example-api' });
    expect(disabled.target).toEqual({ applicationId: 'example-api' });
  });

  test('4. omits applications absent from the catalog', async () => {
    const context = await builder()({ portalContext: { applicationId: 'unknown-api', environment: 'development' } });
    expect(context.target).toEqual({ environment: 'development' });
  });

  test('5. requests clarification for several close applications', async () => {
    await expect(builder()({ userRequest: 'Logs for payment-api in production' }))
      .rejects.toBeInstanceOf(AmbiguousContextError);
  });

  test('6. explicit text replaces an older application and environment', async () => {
    const context = await builder()({
      confirmedConversationContext: { applicationId: 'example-api', environment: 'dev' },
      userRequest: 'Show billing-api in production',
    });
    expect(context.target).toEqual({ applicationId: 'billing-api', environment: 'production' });
  });

  test('7. drops a previous context made stale by the catalog', async () => {
    const context = await builder([applications[0]])({
      confirmedConversationContext: { applicationId: 'retired-api', environment: 'prod' },
    });
    expect(context.target).toEqual({ environment: 'production' });
    expect(context.conversation).toEqual({ confirmedEnvironment: 'production' });
  });

  test('8. emits complete defaults when optional UI context is absent', async () => {
    const context = await builder()();
    expect(context).toMatchObject({
      target: {}, navigation: { openPage: 'unknown' }, view: {}, conversation: {},
      locale: { language: 'fr', timezone: 'Europe/Paris' },
    });
  });

  test('9. ignores model candidates and browser-supplied authority fields', async () => {
    const context = await builder()({
      modelCandidate: { applicationId: 'billing-api', environment: 'prod' },
      portalContext: { openPage: 'logs' },
      userIdentity: { userId: 'attacker', roles: ['manager'] },
      allowedTools: ['get_application_logs', 'unapproved_tool'],
    });
    expect(context.target).toEqual({});
    expect(context.actor).toEqual(actor);
    expect(context.permissions.allowedTools).toEqual(['get_application_logs']);
  });

  test('10. rejects unknown browser fields and does not accept an unknown application', async () => {
    await expect(builder()({ portalContext: { applicationId: 'admin-api', token: 'secret' } }))
      .rejects.toThrow();
    const context = await builder()({ portalContext: { applicationId: 'admin-api' } });
    expect(context.target).toEqual({});
  });

  test('bounds log ranges to 24 hours and validates visible filters', async () => {
    const context = await builder()({
      portalContext: {
        openPage: 'logs',
        timeRange: { from: '2026-01-01T00:00:00.000Z', to: '2026-01-03T00:00:00.000Z' },
        filters: { logLevel: ['error', 'INVALID'], deploymentStatus: ['Healthy'], search: 'timeout' },
      },
    });
    expect(context.view).toEqual({
      timeRange: { from: '2026-01-02T00:00:00.000Z', to: '2026-01-03T00:00:00.000Z' },
      filters: { logLevel: ['error'], deploymentStatus: ['Healthy'], search: 'timeout' },
    });
  });

  test('omits arbitrary provider query syntax from visible filters', async () => {
    const context = await builder()({
      portalContext: { openPage: 'logs', filters: { search: 'service:secret AND status:error' } },
    });
    expect(context.view).toEqual({});
  });

  test('includes only a server-provided pending clarification identifier', async () => {
    const pendingClarificationId = '4a545e93-166a-4c9d-967a-ea77a091b70f';
    const context = await builder()({ pendingClarificationId });
    expect(context.conversation.pendingClarificationId).toBe(pendingClarificationId);
  });
});
