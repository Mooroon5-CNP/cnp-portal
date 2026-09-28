'use strict';

const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const { marked } = require('marked');
const { requireAuth } = require('../middleware/auth');
const { requirePermission, can } = require('../middleware/rbac');

const DOCS_DIR = path.resolve(process.cwd(), 'documentation');

const DEVOPS_PREFIX = 'devops/';

function isDevopsFile(relPath) {
  return relPath.startsWith(DEVOPS_PREFIX);
}

function canSeeDevopsFiles(user) {
  return user && (user.role === 'manager' || user.role === 'devops');
}

function listDocFiles(dir, base = '') {
  const entries = [];
  try {
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      const relPath = base ? `${base}/${item.name}` : item.name;
      if (item.isDirectory()) {
        entries.push(...listDocFiles(path.join(dir, item.name), relPath));
      } else if (item.name.endsWith('.md')) {
        entries.push(relPath);
      }
    }
  } catch (_) { /* directory unreadable */ }
  return entries;
}

function sortedFiles(allFiles) {
  // PLATFORM_CONTRACT.md first, DEVELOPER_GUIDE.md second, then alphabetical, devops/ section last
  const ORDER = ['PLATFORM_CONTRACT.md', 'DEVELOPER_GUIDE.md'];
  return [...allFiles].sort((a, b) => {
    const ai = ORDER.indexOf(a);
    const bi = ORDER.indexOf(b);
    if (ai !== -1 && bi !== -1) return ai - bi;
    if (ai !== -1) return -1;
    if (bi !== -1) return 1;
    const aDevops = isDevopsFile(a);
    const bDevops = isDevopsFile(b);
    if (aDevops && !bDevops) return 1;
    if (!aDevops && bDevops) return -1;
    return a.localeCompare(b);
  });
}

router.get('/', requireAuth, requirePermission('docs:read'), (req, res) => {
  return res.redirect('/docs/PLATFORM_CONTRACT.md');
});

router.get('/*', requireAuth, requirePermission('docs:read'), (req, res) => {
  const requestedPath = req.params[0];

  // Prevent path traversal
  const resolved = path.resolve(DOCS_DIR, requestedPath);
  if (!resolved.startsWith(DOCS_DIR) || !resolved.endsWith('.md')) {
    return res.status(400).render('error', { title: 'Fichier invalide', message: 'Fichier non autorisé.', code: 400, user: req.user });
  }

  // Gate devops-only files
  if (isDevopsFile(requestedPath) && !canSeeDevopsFiles(req.user)) {
    return res.status(403).render('error', { title: 'Accès refusé', message: 'Ce document est réservé aux DevOps.', code: 403, user: req.user });
  }

  const allFiles = listDocFiles(DOCS_DIR);
  const files = sortedFiles(
    canSeeDevopsFiles(req.user) ? allFiles : allFiles.filter(f => !isDevopsFile(f))
  );

  let content = null;
  try {
    const raw = fs.readFileSync(resolved, 'utf8');
    content = marked(raw);
  } catch (_) {
    return res.status(404).render('error', { title: 'Fichier introuvable', message: 'Ce fichier de documentation n\'existe pas.', code: 404, user: req.user });
  }

  res.render('documentation/index', {
    title: `${requestedPath} — Documentation`,
    currentPage: 'docs',
    files,
    content,
    currentFile: requestedPath,
    isDevopsFile,
    user: req.user,
    can: (p) => can(req.user, p),
  });
});

module.exports = router;
