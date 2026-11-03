'use strict';
const { readDashboardSources } = require('../src/services/dashboard-sources');

afterEach(() => jest.useRealTimers());
test('a stalled provider cannot block page data; other sources are retained', async () => {
  jest.useFakeTimers();
  const result = readDashboardSources({
    Kubernetes: () => new Promise(() => {}),
    Datadog: async () => [{ status: 'ALERT' }],
    Argo: async () => [{ name: 'app-dev' }],
  });
  await jest.advanceTimersByTimeAsync(3000);
  await expect(result).resolves.toEqual({
    Kubernetes: { available: false, data: [] },
    Datadog: { available: true, data: [{ status: 'ALERT' }] },
    Argo: { available: true, data: [{ name: 'app-dev' }] },
  });
  expect(jest.getTimerCount()).toBe(0);
});
test('failed and late providers do not become fabricated healthy data', async () => {
  const result = await readDashboardSources({ Argo: async () => { throw new Error('unavailable'); } });
  expect(result.Argo.available).toBe(false);
});
