'use strict';

const path = require('path');
const fs = require('fs');
function resolveDocument(root, requested) {
  if (typeof requested !== 'string' || requested.includes('\0')) throw new Error('INVALID_PATH');
  const canonicalRoot = fs.realpathSync(root);
  const candidate = path.resolve(canonicalRoot, requested);
  if (!candidate.startsWith(canonicalRoot + path.sep) || !candidate.endsWith('.md')) throw new Error('INVALID_PATH');
  const resolved = fs.realpathSync(candidate);
  if (!resolved.startsWith(canonicalRoot + path.sep) || !resolved.endsWith('.md') || !fs.statSync(resolved).isFile()) throw new Error('INVALID_PATH');
  return { resolved, relative: path.relative(canonicalRoot, resolved).split(path.sep).join('/') };
}
module.exports = { resolveDocument };
