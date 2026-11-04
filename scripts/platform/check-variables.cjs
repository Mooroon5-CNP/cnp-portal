'use strict';
require('dotenv').config();
require('../../src/config/cloud-env').loadCloudEnv();
const provider = require('../../src/clients/secret-manager');
async function main() {
  const bundles = require('../../src/clients/variable-bundles');
  if (process.argv.includes('--role-definition')) {
    console.log(JSON.stringify({ title: 'CNP application variables', description: 'Backend control-plane permissions for application variables', stage: 'GA', includedPermissions: bundles.provider() === 'gcs' ? bundles.GCS_PERMISSIONS : bundles.provider() === 'openbao' ? bundles.GCS_PERMISSIONS.filter(permission => permission.startsWith('iam.')) : provider.REQUIRED_PERMISSIONS }, null, 2));
    return;
  }
  const result = await (bundles.provider() === 'secret-manager' ? provider.capability() : bundles.capability());
  console.log(JSON.stringify(result, null, 2));
  if (!result.available) process.exitCode = 1;
}
main().catch(() => { console.error('Vérification plateforme impossible. Aucun secret créé.'); process.exitCode = 1; });
