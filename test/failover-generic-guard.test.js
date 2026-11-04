'use strict';

// Garde-fou : le failover générique ne doit coder en dur le nom d'aucune application. Les profils historiques
// (recipe, pixelcalm) restent dans le moteur CNP, mais pas dans le portail ni dans l'opérateur.
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const generic = [
  ...fs.readdirSync(path.join(root, 'src/services')).filter(name => /^failover-.*\.js$/.test(name) || name === 'environment-failover.js')
    .map(name => `src/services/${name}`),
  'src/routes/failover.js', 'src/views/failover.ejs',
  ...fs.readdirSync(path.join(root, 'scripts/failover')).filter(name => name.endsWith('.py')).map(name => `scripts/failover/${name}`),
];
const pilot = /app4-pixelcam|app4-pixelcalm|pixelcalm|pixelcam/i;

test.each(generic)('%s ne code aucun nom d’application du pilote', file => {
  const hits = fs.readFileSync(path.join(root, file), 'utf8').split('\n')
    .map((text, index) => ({ line: index + 1, text })).filter(row => pilot.test(row.text));
  expect(hits).toEqual([]);
});

test('les réparations ponctuelles du pilote ne sont plus exposées', () => {
  const routes = fs.readFileSync(path.join(root, 'src/routes/failover.js'), 'utf8');
  expect(routes).not.toMatch(/owner\/reconcile|repair\/dev-backend/);
  for (const file of ['src/services/failover-owner.js', 'src/services/failover-dev-routing.js']) {
    expect(fs.existsSync(path.join(root, file))).toBe(false);
  }
});

test('la liste vérifiée contient bien les modules failover (le garde-fou n’est pas vide)', () => {
  expect(generic).toEqual(expect.arrayContaining(['src/services/failover-provisioning.js', 'src/services/environment-failover.js',
    'scripts/failover/operate.py', 'scripts/failover/render.py']));
});
