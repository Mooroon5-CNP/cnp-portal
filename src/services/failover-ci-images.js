'use strict';

const { execFileSync } = require('child_process');
const { config } = require('../config/env');
const github = require('../clients/github');
const repositories = require('./github');

async function latest(dep, api) {
  const source = repositories.parseRepoUrl(dep.githubRepoUrl);
  if (!source || dep.environment !== 'prod') throw new Error('Production GitHub requise.');
  api ||= await github.getInstallationOctokit();
  const { data } = await api.request('GET /repos/{owner}/{repo}/actions/workflows/{workflow_id}/runs', {
    ...source, workflow_id: `cnp-${dep.appName}.yml`, branch: 'prod', per_page: 1,
  });
  const run = data.workflow_runs?.[0];
  if (!run || run.head_branch !== 'prod' || !/^[a-f0-9]{40}$/.test(run.head_sha)) throw new Error('Pipeline de production absent.');
  return { run, source, api };
}
function validate(record, dep, revision) {
  const registry = config.github.registryUrl || config.gcp.imageRegistry;
  if (!record || Object.keys(record).sort().join(',') !== 'app,aws,digest,gcp,revision'
    || record.app !== dep.appName || record.revision !== revision || !/^sha256:[a-f0-9]{64}$/.test(record.digest)
    || record.gcp !== `${registry}/${dep.appName}@${record.digest}`
    || record.aws !== `626278345026.dkr.ecr.eu-west-3.amazonaws.com/${dep.appName}@${record.digest}`) {
    throw new Error('Images CI absentes ou incohérentes avec ce déploiement.');
  }
  return record;
}
async function resolve(dep, expectedRevision) {
  const { run, source, api } = await latest(dep);
  if (run.status !== 'completed' || run.conclusion !== 'success') throw new Error('Un pipeline de production réussi est requis.');
  if (expectedRevision && run.head_sha !== expectedRevision) throw new Error('Le pipeline a changé depuis la préparation.');
  if (await github.getRef(source.owner, source.repo, 'prod') !== run.head_sha) throw new Error('La branche a changé depuis le pipeline.');
  const { data } = await api.request('GET /repos/{owner}/{repo}/actions/runs/{run_id}/artifacts', {
    ...source, run_id: run.id, per_page: 100,
  });
  const artifacts = data.artifacts.filter(value => value.name === `cnp-failover-images-${run.head_sha}` && !value.expired);
  if (artifacts.length !== 1 || artifacts[0].size_in_bytes > 65536) throw new Error('Preuve des images absente, expirée ou ambiguë. Configurez le pipeline failover puis relancez-le.');
  const { data: archive } = await api.request('GET /repos/{owner}/{repo}/actions/artifacts/{artifact_id}/{archive_format}', {
    ...source, artifact_id: artifacts[0].id, archive_format: 'zip',
  });
  if (Buffer.byteLength(archive) > 65536) throw new Error('Archive de preuve trop volumineuse.');
  const output = execFileSync(process.env.CNP_FAILOVER_PYTHON || 'python3', ['-c',
    "import io,json,sys,zipfile; z=zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())); assert z.namelist()==['cnp-images.json']; i=z.getinfo('cnp-images.json'); assert i.file_size<=16384; print(json.dumps(json.loads(z.read(i))))"],
  { input: Buffer.from(archive), timeout: 5000, maxBuffer: 32768, stdio: ['pipe', 'pipe', 'pipe'] });
  return { ...validate(JSON.parse(output.toString()), dep, run.head_sha), runId: run.id, deploymentId: dep.id };
}
module.exports = { latest, resolve, validate };
