'use strict';

const { execFile } = require('child_process');
const path = require('path');
const { createHash } = require('crypto');

// Exécuté par le provisionneur seulement : son rôle AWS (OIDC GKE, sans clé) peut créer des rôles sous /cnp-runtime/,
// toujours avec la limite de droits cnp-runtime-exec-boundary. Le portail n'a aucun droit IAM.
const APP = /^[a-z][a-z0-9-]{0,38}[a-z0-9]$/;
const SAFE = /^(Paramètres du rôle AWS invalides|Rôle AWS existant hors du périmètre attendu|Isolation du rôle AWS non prouvée|Rôle AWS créé mais pas encore effectif, réessayez|Compte AWS inattendu)\.?$/;

function roleArnFor(appName, account) {
  if (!APP.test(appName || '') || !/^[0-9]{12}$/.test(account || '')) return null;
  return `arn:aws:iam::${account}:role/cnp-runtime/cnp-${createHash('sha256').update(`${appName}/prod`).digest('hex').slice(0, 20)}-exec`;
}

function run(python, args, input, timeout) {
  return new Promise((resolve, reject) => {
    const child = execFile(python, args, { encoding: 'utf8', timeout, maxBuffer: 64 * 1024 }, (error, stdout, stderr) => {
      if (error) return reject(Object.assign(new Error('failed'), { stderr: String(stderr || '').trim() }));
      return resolve(stdout);
    });
    child.stdin.end(input);
  });
}

async function ensureAwsRole(deployment, { account = process.env.CNP_AWS_ACCOUNT_ID, region = process.env.CNP_AWS_REGION,
  boundary = process.env.CNP_AWS_RUNTIME_BOUNDARY_ARN, python = process.env.CNP_FAILOVER_PYTHON || 'python3',
  execute = run } = {}) {
  const expected = roleArnFor(deployment?.appName, account);
  if (!expected || deployment.targetCluster !== 'gcp' || deployment.environment !== 'prod' || !deployment.failoverRequested
    || !/^[a-z]{2}-[a-z]+-[0-9]$/.test(region || '')
    || boundary !== `arn:aws:iam::${account}:policy/cnp-runtime/cnp-runtime-exec-boundary`) {
    throw new Error('Paramètres du rôle AWS invalides.');
  }
  const script = path.resolve(__dirname, '../../scripts/failover/engine/openbao_identity_aws.py');
  let output;
  try {
    // 8 essais de 5 s au plus pour la propagation IAM, plus les appels : 90 s laissent de la marge sous les 120 s du client.
    output = await execute(python, [script], JSON.stringify({ operation: 'ensure', app: deployment.appName, account, region,
      boundary_arn: boundary }), 90000);
  } catch (error) {
    const message = SAFE.test(error.stderr || '') ? error.stderr.replace(/\.?$/, '.') : 'Provisionnement AWS indisponible ou refusé.';
    throw new Error(message);
  }
  let role;
  try { role = JSON.parse(output).role_arn; } catch (_) { /* invalid output */ }
  if (role !== expected) throw new Error('Rôle AWS existant hors du périmètre attendu.');
  return role;
}

// Suppression de l'app : le rôle d'exécution propre à l'app part avec son secours (opération « remove » du script, qui
// refuse tout rôle hors périmètre). Absent = déjà fait.
async function removeAwsRole(deployment, { account = process.env.CNP_AWS_ACCOUNT_ID, region = process.env.CNP_AWS_REGION,
  boundary = process.env.CNP_AWS_RUNTIME_BOUNDARY_ARN, python = process.env.CNP_FAILOVER_PYTHON || 'python3',
  execute = run } = {}) {
  if (!roleArnFor(deployment?.appName, account) || deployment.targetCluster !== 'gcp' || deployment.environment !== 'prod'
    || !/^[a-z]{2}-[a-z]+-[0-9]$/.test(region || '')
    || boundary !== `arn:aws:iam::${account}:policy/cnp-runtime/cnp-runtime-exec-boundary`) {
    throw new Error('Paramètres du rôle AWS invalides.');
  }
  const script = path.resolve(__dirname, '../../scripts/failover/engine/openbao_identity_aws.py');
  let output;
  try {
    output = await execute(python, [script], JSON.stringify({ operation: 'remove', app: deployment.appName, account, region,
      boundary_arn: boundary }), 60000);
  } catch (error) {
    throw new Error(SAFE.test(error.stderr || '') ? error.stderr.replace(/\.?$/, '.') : 'Provisionnement AWS indisponible ou refusé.');
  }
  let removed;
  try { removed = JSON.parse(output).removed; } catch (_) { /* invalid output */ }
  if (typeof removed !== 'boolean') throw new Error('Provisionnement AWS indisponible ou refusé.');
  return removed;
}

module.exports = { ensureAwsRole, removeAwsRole, roleArnFor };
