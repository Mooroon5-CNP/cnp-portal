'use strict';
// Deployment operator preflight. Uses only the CI's short-lived Google token;
// never reads application values or changes an IAM policy.
const { request } = require('../runtime/variables.cjs');
const REQUIRED = [
  'run.services.get', 'run.services.create', 'run.services.update',
  'iam.serviceAccounts.create', 'iam.serviceAccounts.get', 'iam.serviceAccounts.getIamPolicy', 'iam.serviceAccounts.setIamPolicy',
  'iam.roles.create', 'iam.roles.get', 'iam.roles.update',
  'resourcemanager.projects.getIamPolicy', 'resourcemanager.projects.setIamPolicy',
  'storage.buckets.create', 'storage.buckets.get', 'storage.buckets.getIamPolicy', 'storage.buckets.setIamPolicy',
  'storage.objects.create', 'storage.objects.get',
];
async function main() {
  const token = process.env.CNP_DEPLOY_ACCESS_TOKEN;
  if (!token) throw new Error('DEPLOY_IDENTITY_MISSING');
  const result = await request('https://cloudresourcemanager.googleapis.com/v1/projects/cnp-terraform-512313:testIamPermissions', {
    method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: { permissions: REQUIRED }, timeout: 10000,
  });
  const missing = REQUIRED.filter(permission => !result.permissions?.includes(permission));
  console.log(JSON.stringify({ project: 'cnp-terraform-512313', service: 'cnp-portal-preview', available: !missing.length, missing }, null, 2));
  if (missing.length) process.exitCode = 1;
}
if (require.main === module) main().catch(error => { console.error(JSON.stringify({ code: error.code || 'DEPLOY_PREFLIGHT_FAILED', status: error.status || null, message: 'GCP deployment preflight failed; no resource was created.' })); process.exitCode = 1; });
module.exports = { REQUIRED };
