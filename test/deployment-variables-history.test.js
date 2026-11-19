'use strict';

const db = require('../src/models/db');
const deployments = require('../src/models/deployment');
const variables = require('../src/models/deployment_variables');

test('retains removed names and pinned versions for rollback and deletion cleanup', () => {
  const dep = deployments.create({ appName: 'variable-history', environment: 'dev',
    githubRepoUrl: 'https://github.com/team/variable-history', ownerUserId: 'owner' });
  try {
    variables.save(dep.id, { generation: 'first', names: ['OLD_KEY'], versions: { gcp: 1 } });
    variables.save(dep.id, { generation: 'second', names: ['NEW_KEY'], versions: { gcp: 2 } });
    expect(variables.get(dep.id)).toMatchObject({ generation: 'second', names: ['NEW_KEY'],
      ownedNames: ['OLD_KEY', 'NEW_KEY'], history: [
        { generation: 'first', names: ['OLD_KEY'], versions: { gcp: 1 } },
        { generation: 'second', names: ['NEW_KEY'], versions: { gcp: 2 } },
      ] });
  } finally {
    db.prepare('DELETE FROM deployment_variables WHERE deployment_id=?').run(dep.id);
    deployments.delete(dep.id);
  }
});
