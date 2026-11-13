'use strict';
const { selectWorkflowRun } = require('../src/services/workflow-runs');
const failed = { id: 20, head_branch: 'main', head_sha: 'current', created_at: '2026-11-03T12:00:00Z', run_started_at: '2026-11-03T12:00:00Z', conclusion: 'failure' };
const rerun = { id: 10, head_branch: 'main', head_sha: 'current', created_at: '2026-11-01T12:00:00Z', run_started_at: '2026-11-03T13:00:00Z', run_attempt: 2, conclusion: 'success' };
test('a successful newer attempt is selected even when its run was created earlier', () => {
  expect(selectWorkflowRun([failed, rerun], { branch: 'main', revision: 'current', notBefore: '2026-11-03T11:00:00Z' })).toEqual(rerun);
});
test('another branch, another revision and pre-onboarding attempts cannot be published', () => {
  const candidates = [{ ...rerun, head_branch: 'prod' }, { ...rerun, head_sha: 'old' }, { ...failed, run_started_at: '2026-10-01T00:00:00Z' }];
  expect(selectWorkflowRun(candidates, { branch: 'main', revision: 'current', notBefore: '2026-11-03T11:00:00Z' })).toBeNull();
});
test('a newer running attempt takes precedence over previous success', () => {
  const running = { ...failed, run_started_at: '2026-11-03T14:00:00Z', status: 'in_progress', conclusion: null };
  expect(selectWorkflowRun([running, rerun], { revision: 'current' })).toEqual(running);
});
