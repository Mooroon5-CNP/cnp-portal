'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { randomUUID } = require('crypto');
const { CLOUD_KEYS } = require('../../src/config/cloud-env');

function writeContract(values, output) {
  for (const key of CLOUD_KEYS) {
    if (typeof values[key] !== 'string') throw new Error(`Terraform output is missing ${key}`);
    if (/[\r\n]/.test(values[key])) throw new Error(`Unexpected multiline value for ${key}`);
  }
  if (!values.KUBE_TOKEN || !values.ARGOCD_PASSWORD || values.ARGOCD_TOKEN) throw new Error('Invalid Terraform authentication contract');
  const text = CLOUD_KEYS.map(key => `${key}=${JSON.stringify(values[key])}`).join('\n') + '\n';
  const temporary = `${output}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, text, { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, output);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

function main(argv) {
  if (argv.includes('--help')) {
    console.log('npm run cloud:import -- --terraform-dir ../Cloud/cnp/gcp [--output .env.cloud]');
    return;
  }
  const opts = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!['--terraform-dir', '--output'].includes(argv[i]) || !argv[i + 1]) throw new Error('Expected --terraform-dir PATH [--output PATH]');
    opts[argv[i]] = argv[i + 1];
  }
  if (!opts['--terraform-dir']) throw new Error('--terraform-dir is required');
  const dir = path.resolve(opts['--terraform-dir']);
  const output = path.resolve(opts['--output'] || '.env.cloud');
  let values;
  try {
    values = JSON.parse(execFileSync('terraform', [`-chdir=${dir}`, 'output', '-json', 'portal_environment'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000 }));
  } catch (_) {
    throw new Error('Cannot read portal_environment. Initialize the correct backend and apply the portal Terraform changes first.');
  }
  writeContract(values, output);
  console.log(`Cloud settings imported into ${output} (0600). Restart the portal. No infrastructure changed.`);
}

if (require.main === module) {
  try { main(process.argv.slice(2)); } catch (err) { console.error(err.message); process.exitCode = 1; }
}

module.exports = { writeContract, main };
