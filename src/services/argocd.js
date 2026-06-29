'use strict';

const crypto     = require('crypto');
const bcrypt     = require('bcryptjs');
const client     = require('../clients/argocd');
const k8sClient  = require('../clients/kubernetes');
const accessReqModel = require('../models/argocd_access_request');
const userModel  = require('../models/user');

// AES-256-GCM encryption for ArgoCD passwords stored in DB.
// Key derived from SESSION_SECRET so no extra env var is needed.
const _encKey = crypto.createHash('sha256')
  .update(process.env.SESSION_SECRET || 'dev-fallback-key-change-in-prod')
  .digest();

function _encrypt(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', _encKey, iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64');
}

function _decrypt(stored) {
  try {
    const buf = Buffer.from(stored, 'base64');
    const iv  = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const enc = buf.subarray(28);
    const d   = crypto.createDecipheriv('aes-256-gcm', _encKey, iv);
    d.setAuthTag(tag);
    return d.update(enc).toString('utf8') + d.final('utf8');
  } catch {
    return null;
  }
}

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

function hasApproved(userId) {
  return accessReqModel.hasApproved(userId);
}

function requestAccess(userId, appName, reason) {
  if (accessReqModel.hasPending(userId)) {
    throw new Error('Vous avez déjà une demande d\'accès en attente.');
  }
  if (accessReqModel.hasApproved(userId)) {
    throw new Error('ALREADY_APPROVED');
  }
  return accessReqModel.create({ userId, appName, reason });
}

function getAccessRequests() {
  return accessReqModel.listPending();
}

function getUserAccessRequest(userId) {
  // If the user has an approved request, always surface it (credentials take priority
  // over a newer pending/rejected request so the UI always shows the credentials card).
  const req = accessReqModel.getApprovedForUser(userId) || accessReqModel.getLatestForUser(userId);
  if (req && req.argoCDPassword) {
    req.argoCDPassword = _decrypt(req.argoCDPassword);
  }
  return req;
}

// Called by the manager when approving a request.
// Provisions an ArgoCD local account, stores credentials encrypted in DB.
// If the user already has an approved account, reuses the existing credentials.
async function approveAccess(requestId, reviewerId) {
  const req = accessReqModel.getById(requestId);
  if (!req) throw new Error('Demande introuvable.');
  if (req.status !== 'pending') throw new Error('Cette demande a déjà été traitée.');

  const user = userModel.findById(req.userId);
  if (!user) throw new Error('Utilisateur introuvable.');

  // If the user already has an approved account, reuse its credentials.
  const existing = accessReqModel.getApprovedForUser(req.userId);
  if (existing) {
    return accessReqModel.approve(requestId, {
      argoCDUsername: existing.argoCDUsername,
      argoCDPassword: existing.argoCDPassword, // already encrypted
      reviewedBy: reviewerId,
    });
  }

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
    argoCDPassword: _encrypt(password),
    reviewedBy: reviewerId,
  });
}

function rejectAccess(requestId, reviewerId) {
  const req = accessReqModel.getById(requestId);
  if (!req) throw new Error('Demande introuvable.');
  if (req.status !== 'pending') throw new Error('Cette demande a déjà été traitée.');
  return accessReqModel.reject(requestId, reviewerId);
}

// Regenerate credentials for an already-approved user.
async function regenerateCredentials(userId) {
  const existing = accessReqModel.getApprovedForUser(userId);
  if (!existing) throw new Error('Aucun accès ArgoCD approuvé trouvé.');

  const user = userModel.findById(userId);
  if (!user) throw new Error('Utilisateur introuvable.');

  const argoCDUsername = existing.argoCDUsername;

  const alphabet = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const password = Array.from(crypto.randomBytes(16))
    .map(b => alphabet[b % alphabet.length])
    .join('');

  const bcryptHash = bcrypt.hashSync(password, 10);

  try {
    await k8sClient.provisionArgoCDLocalUser(argoCDUsername, bcryptHash);
  } catch (err) {
    console.error('[argocd] regenerateCredentials provisionArgoCDLocalUser failed:', err.message);
  }

  return accessReqModel.updateCredentials(existing.id, {
    argoCDPassword: _encrypt(password),
  });
}

module.exports = {
  listApps, syncApp,
  hasApproved,
  requestAccess, getAccessRequests, getUserAccessRequest,
  approveAccess, rejectAccess, regenerateCredentials,
};
