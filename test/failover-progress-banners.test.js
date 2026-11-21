'use strict';

jest.mock('../src/services/failover-teardown', () => ({ STEPS: [['commit', 'release'], ['operation', 'teardown-released'],
  ['commit', 'remove'], ['operation', 'teardown-gone'], ['operation', 'teardown-cleanup'], ['local', 'forget']], get: jest.fn() }));
jest.mock('../src/services/environment-deletion', () => ({ STEPS: ['inventory', 'release', 'release_wait', 'remove', 'verify',
  'variables', 'repository'], get: jest.fn() }));
const teardown = require('../src/services/failover-teardown');
const deletion = require('../src/services/environment-deletion');
const { failoverAlert, awsSince, failbackStatus } = require('../src/services/environment-failover');
const operations = require('../src/services/failover-operations');
const progress = require('../src/services/deletion-progress');

const now = Date.parse('2026-11-21T11:40:00Z');
const health = result => ({ result: { observed_at: now / 1000 - 30, ...result } });

describe('bandeau de bascule', () => {
  test('GCP ne répond plus avant l’alarme', () => {
    expect(failoverAlert(health({ state: 'WAIT_SIGNALS', public_ready: false }), now))
      .toEqual(expect.objectContaining({ alert: 'outage', message: expect.stringContaining('GCP ne répond plus') }));
    expect(failoverAlert(health({ state: 'WAIT_SIGNALS', public_ready: true }), now)).toBeNull();
  });
  test('bascule en cours : étape du worker en mots lisibles', () => {
    const alert = failoverAlert(health({ state: 'CLOSING_GCP_ROUTE', public_ready: false }), now);
    expect(alert.alert).toBe('switching');
    expect(alert.message).toContain('fermeture du DNS vers GCP');
  });
  test('bascule arrêtée par une sécurité', () => {
    expect(failoverAlert(health({ state: 'BLOCKED_SQL_STATE' }), now).alert).toBe('blocked');
  });
  test('contrôle trop ancien ou absent : aucun bandeau', () => {
    expect(failoverAlert({ result: { state: 'CLOSING_GCP_ROUTE', observed_at: now / 1000 - 600 } }, now)).toBeNull();
    expect(failoverAlert(undefined, now)).toBeNull();
  });
  test('servi par AWS depuis le premier contrôle AWS_ACTIVE de la série en cours', () => {
    const checks = [{ result: { state: 'AWS_ACTIVE', observed_at: 300 } }, { result: { state: 'AWS_ACTIVE', observed_at: 200 } },
      { result: { state: 'OPENING_AWS', observed_at: 100 } }, { result: { state: 'AWS_ACTIVE', observed_at: 50 } }];
    expect(awsSince(checks)).toBe(200);
    expect(awsSince([{ result: { state: 'WAIT_SIGNALS', observed_at: 1 } }])).toBeNull();
    // Heure exacte du journal du worker, quand le contrôle la fournit.
    expect(awsSince([{ result: { state: 'AWS_ACTIVE', observed_at: 300, aws_active_since: 123 } }, ...checks.slice(1)])).toBe(123);
  });
});

describe('suivi de suppression', () => {
  beforeEach(() => { teardown.get.mockReset(); deletion.get.mockReset(); });
  const dep = { id: 'dep-1', appName: 'sample-app' };

  test('suppression avec secours : étape, durées et détail du parcours', () => {
    teardown.get.mockReturnValue({ deployment_id: 'dep-1', state: 'waiting', step: 3, message: 'En attente : base RDS.',
      started_at: '2026-11-21T11:20:00Z', step_started_at: '2026-11-21T11:28:00Z' });
    const value = progress.progress(dep, now);
    expect(value).toEqual(expect.objectContaining({ step: 3, total: 6, label: 'Destruction des ressources chez GCP et AWS',
      elapsed: 720, estimate: 1800, totalElapsed: 1200, slow: false }));
    expect(value.totalEstimate).toBe(1200 + (1800 - 720) + 60 + 120);
    expect(progress.message(dep, now)).toBe('Suppression (étape 4/6) : Destruction des ressources chez GCP et AWS '
      + '(étape 12 min / ~30 min, parcours 20 min / ~41 min). En attente : base RDS.');
  });
  test('étape au-delà du double de l’habitude : signalée, pas en erreur', () => {
    teardown.get.mockReturnValue({ deployment_id: 'dep-1', state: 'waiting', step: 1, started_at: '2026-11-21T11:20:00Z',
      step_started_at: '2026-11-21T11:25:00Z' });
    expect(progress.message(dep, now)).toContain('Plus long que d’habitude');
  });
  test('suppression d’un environnement sans secours', () => {
    deletion.get.mockReturnValue({ step: 'verify', state: 'waiting', started_at: '2026-11-21T11:35:00Z',
      step_started_at: '2026-11-21T11:37:00Z' });
    expect(progress.message(dep, now)).toMatch(/^Suppression \(étape 5\/7\) : Disparition des ressources chez le fournisseur \(étape 3 min/);
  });
  test('ancienne suppression sans début d’étape enregistré, ou rien en cours', () => {
    deletion.get.mockReturnValue({ step: 'remove', state: 'running', started_at: '2026-11-21T11:30:00Z', updated_at: '2026-11-21T11:39:00Z' });
    expect(progress.progress(dep, now).elapsed).toBe(60);
    teardown.get.mockReturnValue({ deployment_id: 'other', state: 'running', step: 0, started_at: '2026-11-21T11:30:00Z' });
    deletion.get.mockReturnValue(null);
    expect(progress.message(dep, now)).toBeNull();
  });
});

describe('retour vers GCP', () => {
  const dep = { appName: 'sample-app' };
  const step = index => ({ phase: 'failback', state: 'running', step: index, total: 11, label: 'Étape', elapsed: 30, estimate: 120,
    totalElapsed: 300, totalEstimate: 1500, slow: false });
  afterEach(() => jest.restoreAllMocks());

  test('avant la copie vérifiée : retour en cours, l’app reste sur AWS', () => {
    const value = failbackStatus(dep, step(3));
    expect(value).toEqual(expect.objectContaining({ phase: 'deploying', failoverAlert: 'returning' }));
    expect(value.message).toContain('reste servie par AWS');
    expect(value.cloudRunUrl).toBeUndefined();
  });
  test('après la copie : servie par GCP, secours AWS en reconstruction, lien de l’app affiché', () => {
    jest.spyOn(operations, 'list').mockReturnValue([{ action: 'failback-reset', created_at: '2026-11-21T10:45:30Z' },
      { action: 'failback-sync', created_at: '2026-11-21T10:42:00Z' }]);
    const value = failbackStatus(dep, step(5));
    expect(value).toEqual(expect.objectContaining({ phase: 'success', failoverAlert: 'restoring',
      applicationUrl: 'https://sample-app.apps.mooroon5.fr' }));
    expect(value.message).toMatch(/^L’application est de nouveau servie par GCP depuis 11:45\. Remise en place du secours AWS en cours \(étape 6\/11\)/);
    expect(value.message).toContain('ne serait pas couverte');
  });
});
