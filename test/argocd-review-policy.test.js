'use strict';
const { canReviewAccess } = require('../src/services/argocd-access-policy');
const root = { id: 'root', username: 'admin', githubId: null, role: 'manager', active: true };
const manager = { id: 'manager', username: 'manager', githubId: 42, role: 'manager', active: true };
const dev = { id: 'dev', username: 'dev', githubId: 43, role: 'dev', active: true };

test.each([
  [root, root, false], [manager, manager, false], [manager, root, false],
  [manager, { ...manager, id: 'another-manager' }, false],
  [root, manager, true], [root, dev, true], [manager, dev, true], [dev, manager, false],
  [{ ...root, active: false }, manager, false], [{ ...root, githubId: 99 }, manager, false],
])('reviewer %j / requester %j => %s', (reviewer, requester, allowed) => {
  expect(canReviewAccess(reviewer, requester)).toBe(allowed);
});
