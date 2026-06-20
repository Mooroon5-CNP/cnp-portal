'use strict';

const crypto     = require('crypto');
const bcrypt     = require('bcryptjs');
const client     = require('../clients/argocd');
const k8sClient  = require('../clients/kubernetes');
const accessReqModel = require('../models/argocd_access_request');
const userModel  = require('../models/user');

// ── App listing ───────────────────────────────────────────────────────────────

async function listApps() {
  try {
    const apps = await client.listApplications();
    return apps.map(app => ({
      name:      app.name,
      project:   app.project,
      namespace: app.namespace,
      status:    app.sync   || 'Unknown',
      health:    app.health || 'Unknown',
      syncedAt:  app.lastDeployedAt || new Date().toISOString(),
      revision:  app.revision,
    }));
  } catch (err) {
    console.error('[argocd] listApps error:', err.message);
    return [];
  }
}

async function syncApp(appName) {
  return client.syncApplication(appName);
}

// ── Access request workflow ───────────────────────────────────────────────────

function requestAccess(userId, appName, reason) {
  if (accessReqModel.hasPending(userId)) {
    throw new Error('Vous avez déjà une demande d\'accès en attente.');
  }
  return accessReqModel.create({ userId, appName, reason });
}

function getAccessRequests() {
  return accessReqModel.listPending();
}

function getUserAccessRequest(userId) {
  return accessReqModel.getLatestForUser(userId);
}

// Called by the manager when approving a request.
// Provisions an ArgoCD local account, stores credentials in DB.
async function approveAccess(requestId, reviewerId) {
  const req = accessReqModel.getById(requestId);
  if (!req) throw new Error('Demande introuvable.');
  if (req.status !== 'pending') throw new Error('Cette demande a déjà été traitée.');

  const user = userModel.findById(req.userId);
  if (!user) throw new Error('Utilisateur introuvable.');

  // Derive a safe ArgoCD username (lowercase alphanum + hyphens, max 32 chars).
  const argoCDUsername = user.username
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .substring(0, 32) || `user-${req.userId.substring(0, 8)}`;

  // Generate a random 16-char password (digits + letters, no ambiguous chars).
  const alphabet = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const password = Array.from(crypto.randomBytes(16))
    .map(b => alphabet[b % alphabet.length])
    .join('');

  const bcryptHash = bcrypt.hashSync(password, 10);

  // Provision the account in the cluster (best-effort — log on failure but don't abort).
  try {
    await k8sClient.provisionArgoCDLocalUser(argoCDUsername, bcryptHash);
  } catch (err) {
    console.error('[argocd] provisionArgoCDLocalUser failed:', err.message);
    // Still save the request as approved so the manager can communicate credentials manually.
  }

  return accessReqModel.approve(requestId, {
    argoCDUsername,
    argoCDPassword: password,
    reviewedBy: reviewerId,
  });
}

function rejectAccess(requestId, reviewerId) {
  const req = accessReqModel.getById(requestId);
  if (!req) throw new Error('Demande introuvable.');
  if (req.status !== 'pending') throw new Error('Cette demande a déjà été traitée.');
  return accessReqModel.reject(requestId, reviewerId);
}

module.exports = {
  listApps, syncApp,
  requestAccess, getAccessRequests, getUserAccessRequest,
  approveAccess, rejectAccess,
};
