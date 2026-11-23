'use strict';

const manifestMrModel = require('../models/manifest_mr');
const deletionRequestModel = require('../models/deletion_request');
const argocdAccessRequestModel = require('../models/argocd_access_request');
const deploymentReleases = require('../models/deployment_release');
const userStore = require('../models/user');

const safe = (count) => { try { return count(); } catch (_) { return 0; } }; // a badge never breaks a page

/**
 * Pending manager requests shown as sidebar badges. Only managers decide on them, so other roles get zeros.
 *  - users:       accounts waiting for approval
 *  - deployments: manifest MRs + production releases awaiting validation + deletion requests
 *  - argocd:      Argo CD access requests
 */
function managerRequestCounts(user) {
  if (!user || user.role !== 'manager') return { users: 0, deployments: 0, argocd: 0 };
  return {
    users: safe(() => userStore.countPending()),
    deployments: safe(() => manifestMrModel.countAllPending())
      + safe(() => deploymentReleases.countAwaitingApproval())
      + safe(() => deletionRequestModel.countPending()),
    argocd: safe(() => argocdAccessRequestModel.countPending()),
  };
}

module.exports = { managerRequestCounts };
