'use strict';
// Explicit operator command. Reads a local file, writes cloud storage, emits references only.
const fs = require('fs');
const { createHash } = require('crypto');
const { parseFile } = require('../../public/js/application-variables');
const protocol = require('../runtime/variables.cjs');
function previewId(project) {
  const hash = createHash('sha256').update(`${project}/cnp-portal-preview/dev`).digest('hex');
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
}
async function main() {
  const [file, output] = process.argv.slice(2);
  if (!file || !output || !['gcs', 'openbao'].includes(process.env.CNP_VARIABLES_PROVIDER)) throw new Error('Usage: CNP_VARIABLES_PROVIDER=gcs|openbao node scripts/platform/prepare-preview.cjs /private/app.env /tmp/cnp-preview.json');
  if (fs.existsSync(output)) throw new Error('Le fichier de sortie existe déjà.');
  const raw = fs.readFileSync(file); if (raw.length > 262144) throw new Error('Fichier trop volumineux.');
  const values = Object.fromEntries(parseFile(raw.toString('utf8')).map(row => [row.name, row.value]));
  protocol.validateValues(values);
  const { config } = require('../../src/config/env');
  const provider = require('../../src/clients/variable-bundles');
  const dep = { id: previewId(config.gcp.project), appName: 'cnp-portal', environment: 'dev', targetCluster: 'gcp' };
  const health = await provider.capability(); if (!health.available) throw new Error(health.message);
  await provider.prepare(dep);
  const bundle = await provider.write(dep, values);
  const profile = { schemaVersion: 1, service: 'cnp-portal-preview', project: config.gcp.project, region: config.gcp.region,
    runtimeAccount: provider.runtimeAccount(dep), bundle,
    ...(bundle.reference.provider === 'openbao' ? { openbao: protocol.baoSettings(process.env) } : {}) };
  fs.writeFileSync(output, JSON.stringify(profile, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  console.log('Configuration préparée. Le fichier de sortie contient uniquement des références, jamais les valeurs.');
}
if (require.main === module) main().catch(() => { console.error('Préparation impossible. Vérifiez les chemins, le fournisseur, l’identité et les droits ; aucune publication effectuée.'); process.exitCode = 1; });
module.exports = { previewId };
