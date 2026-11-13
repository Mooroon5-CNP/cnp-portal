'use strict';

// Garde-fou : le failover générique ne doit coder en dur le nom d'aucune application, ni réintroduire le pilote retiré le
// 07/11/2026 (page /failover, réglages du pilote, rattachement, mode pas à pas).
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const generic = [
  ...fs.readdirSync(path.join(root, 'src/services')).filter(name => /^failover-.*\.js$/.test(name) || name === 'environment-failover.js')
    .map(name => `src/services/${name}`),
  'src/routes/deployments.js', 'src/views/deployments/detail.ejs',
  ...fs.readdirSync(path.join(root, 'scripts/failover')).filter(name => name.endsWith('.py')).map(name => `scripts/failover/${name}`),
];
const pilot = /app4-pixelcam|app4-pixelcalm|pixelcalm|pixelcam/i;

test.each(generic)('%s ne code aucun nom d’application du pilote', file => {
  const hits = fs.readFileSync(path.join(root, file), 'utf8').split('\n')
    .map((text, index) => ({ line: index + 1, text })).filter(row => pilot.test(row.text));
  expect(hits).toEqual([]);
});

test('la page /failover, les réglages du pilote, le rattachement et le pas à pas ont disparu', () => {
  for (const file of ['src/routes/failover.js', 'src/views/failover.ejs', 'src/services/failover-owner.js', 'src/services/failover-dev-routing.js']) {
    expect(fs.existsSync(path.join(root, file))).toBe(false);
  }
  const code = generic.map(file => fs.readFileSync(path.join(root, file), 'utf8')).join('\n');
  expect(code).not.toMatch(/CNP_FAILOVER_SETTINGS|exposeLegacyApplication|CNP_FAILOVER_STEP_BY_STEP|adoptionPreview|failover_adoptions/);
  expect(fs.readFileSync(path.join(root, 'src/index.js'), 'utf8')).not.toMatch(/routes\/failover/);
});

test('la liste vérifiée contient bien les modules failover (le garde-fou n’est pas vide)', () => {
  expect(generic).toEqual(expect.arrayContaining(['src/services/failover-provisioning.js', 'src/services/environment-failover.js',
    'scripts/failover/operate.py', 'scripts/failover/render.py']));
});
