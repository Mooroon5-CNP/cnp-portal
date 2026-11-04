'use strict';
const fs = require('fs');
const protocol = require('../runtime/variables.cjs');
function render(profile, image) {
  if (profile.schemaVersion !== 1 || profile.service !== 'cnp-portal-preview' || !/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/.test(profile.project) || !/^[a-z]+-[a-z]+\d+$/.test(profile.region)) throw new Error('Profil preview invalide.');
  const ref = protocol.reference(profile.bundle?.reference);
  const expected = `cnp-${require('crypto').createHash('sha256').update(ref.applicationId).digest('hex').slice(0, 24)}@${profile.project}.iam.gserviceaccount.com`;
  if (profile.runtimeAccount !== expected || ref.environment !== 'dev') throw new Error('Identité preview invalide.');
  const prefix = `${profile.region}-docker.pkg.dev/${profile.project}/cnp-registry/cnp-portal@sha256:`;
  if (!image.startsWith(prefix) || !/^[a-f0-9]{64}$/.test(image.slice(prefix.length))) throw new Error('Digest image preview invalide.');
  const env = [{ name: 'DATA_DIR', value: '/tmp' }, { name: 'DD_ENV', value: 'preview' }, { name: 'DD_SERVICE', value: 'cnp-portal' }, { name: 'CNP_VARIABLES_REF', value: JSON.stringify(ref) }, { name: 'CNP_VARIABLES_PROVIDER', value: ref.provider }];
  if (ref.provider === 'openbao') {
    const settings = protocol.baoSettings({ CNP_OPENBAO_ADDR: profile.openbao?.origin, CNP_OPENBAO_AUDIENCE: profile.openbao?.audience });
    env.push({ name: 'CNP_OPENBAO_ADDR', value: settings.origin }, { name: 'CNP_OPENBAO_AUDIENCE', value: settings.audience });
    // Private routing is mandatory for the OpenBao preview. No public fallback.
    if (!profile.network || !/^projects\/[a-z0-9-]+\/global\/networks\/[a-z0-9-]+$/.test(profile.network.network) || !/^projects\/[a-z0-9-]+\/regions\/[a-z0-9-]+\/subnetworks\/[a-z0-9-]+$/.test(profile.network.subnetwork)) throw new Error('Réseau privé OpenBao manquant dans le profil.');
  }
  const template = { serviceAccount: profile.runtimeAccount, containers: [{ image, ports: { containerPort: 8080 }, env }], scaling: { maxInstanceCount: 1 }, timeout: '300s' };
  if (ref.provider === 'openbao') template.vpcAccess = { egress: 'PRIVATE_RANGES_ONLY', networkInterfaces: [{ network: profile.network.network, subnetwork: profile.network.subnetwork }] };
  const metadata = { name: profile.service, labels: { 'app.kubernetes.io/name': 'cnp-portal-preview', 'app.kubernetes.io/version': '1', 'app.kubernetes.io/owner': 'team-cnp', 'cost-center': 'projet-epita' } };
  // No public IAM binding: operator tests through authenticated Cloud Run access.
  return { apiVersion: 'cloudrun.gcp.upbound.io/v1beta2', kind: 'V2Service', metadata,
    spec: { deletionPolicy: 'Orphan', forProvider: { project: profile.project, location: profile.region, template }, providerConfigRef: { name: 'default' } } };
}
if (require.main === module) {
  try { const [file, image] = process.argv.slice(2); console.log(JSON.stringify(render(JSON.parse(fs.readFileSync(file, 'utf8')), image), null, 2)); }
  catch (_) { console.error('Profil ou image preview invalide. Aucun manifeste produit.'); process.exitCode = 1; }
}
module.exports = { render };
