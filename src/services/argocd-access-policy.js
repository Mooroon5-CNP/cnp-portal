'use strict';

function canReviewAccess(reviewer, requester) {
  if (!reviewer || !requester || !reviewer.active || reviewer.role !== 'manager' || reviewer.id === requester.id) return false;
  // The seeded local admin is the root reviewer; an OAuth username is insufficient.
  if (requester.role === 'manager') return reviewer.username === 'admin' && reviewer.githubId === null;
  return true;
}
function assertCanReviewAccess(reviewer, requester) {
  if (canReviewAccess(reviewer, requester)) return;
  const error = new Error('Approbation refusée : aucune auto-approbation. L’accès d’un manager doit être validé par le compte local admin.');
  error.code = 'FORBIDDEN';
  throw error;
}
module.exports = { canReviewAccess, assertCanReviewAccess };
