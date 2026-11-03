'use strict';

// created_at stays unchanged when GitHub reruns a workflow; run_started_at
// identifies the current attempt and must determine which CI is newest.
function attemptTime(run) {
  const value = Date.parse(run.run_started_at || run.created_at || '');
  return Number.isFinite(value) ? value : 0;
}
function selectWorkflowRun(runs, { branch, revision, notBefore } = {}) {
  const start = Date.parse(notBefore || '');
  return runs.filter(run => (!branch || run.head_branch === branch) && (!revision || run.head_sha === revision)
    && (!Number.isFinite(start) || !attemptTime(run) || attemptTime(run) >= start))
    .sort((a, b) => attemptTime(b) - attemptTime(a) || (b.run_attempt || 1) - (a.run_attempt || 1) || b.id - a.id)[0] || null;
}
module.exports = { attemptTime, selectWorkflowRun };
