'use strict';

const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const { marked } = require('marked');
const { requireAuth } = require('../middleware/auth');
const { requirePermission, can } = require('../middleware/rbac');

const DOCS_DIR = path.resolve(process.cwd(), 'documentation');

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

router.get('/', requireAuth, requirePermission('docs:read'), (req, res) => {
  const files = listDocFiles(DOCS_DIR);
  res.render('documentation/index', {
    title: 'Documentation — CNP Portal',
    currentPage: 'docs',
    files,
    content: null,
    currentFile: null,
    user: req.user,
    can: (p) => can(req.user, p),
  });
});

router.get('/*', requireAuth, requirePermission('docs:read'), (req, res) => {
  const requestedPath = req.params[0];

  // Prevent path traversal
  const resolved = path.resolve(DOCS_DIR, requestedPath);
  if (!resolved.startsWith(DOCS_DIR) || !resolved.endsWith('.md')) {
    return res.status(400).render('error', { title: 'Fichier invalide', message: 'Fichier non autorisé.', code: 400, user: req.user });
  }

  const files = listDocFiles(DOCS_DIR);
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
    user: req.user,
    can: (p) => can(req.user, p),
  });
});

module.exports = router;
