'use strict';

const github = require('../clients/github');

// Bounded, read-only inspection of runtime dependencies and conventional entrypoints.
// Never execute repository code or read .env files / connection strings.
const PATHS = ['package.json', 'requirements.txt', 'backend/requirements.txt', 'app.py',
  'src/app.py', 'src/db.js', 'src/db.ts', 'prisma/schema.prisma'];
const SQLITE = new Set(['better-sqlite3', 'sqlite3', 'sqlite']);
const POSTGRES = new Set(['pg', 'postgres', 'pg-native', 'psycopg', 'psycopg2', 'psycopg2-binary', 'asyncpg', 'pg8000']);

function detect(files) {
  const found = new Map();
  const add = (engine, path) => found.set(engine, [...new Set([...(found.get(engine) || []), path])]);
  for (const [path, text] of Object.entries(files)) {
    if (path === 'package.json') {
      let manifest;
      try { manifest = JSON.parse(text); } catch (_) { throw new Error('package.json invalide : impossible de vérifier la compatibilité de la base.'); }
      for (const name of Object.keys({ ...manifest.dependencies, ...manifest.optionalDependencies })) {
        if (SQLITE.has(name)) add('sqlite', path);
        if (POSTGRES.has(name)) add('postgres', path);
      }
    } else if (path.endsWith('requirements.txt')) {
      for (const line of text.split('\n')) {
        const name = /^\s*([a-z0-9_-]+)(?=\s*(?:\[|[<>=!~;#]|$))/i.exec(line)?.[1]?.toLowerCase().replace(/_/g, '-');
        if (name && SQLITE.has(name)) add('sqlite', path);
        if (name && POSTGRES.has(name)) add('postgres', path);
      }
    } else if (path.endsWith('.py')) {
      if (/^\s*(?:import\s+sqlite3\b|from\s+sqlite3\b)/m.test(text)) add('sqlite', path);
      if (/^\s*(?:import\s+(?:psycopg2?|asyncpg|pg8000)\b|from\s+(?:psycopg2?|asyncpg|pg8000)\b)/m.test(text)) add('postgres', path);
    } else if (/\.([jt]s)$/.test(path)) {
      const source = text.split('\n').filter(line => !/^\s*(?:\/\/|\*)/.test(line)).join('\n');
      if (/(?:require\s*\(\s*|from\s+|import\s*)['"](?:better-sqlite3|sqlite3|sqlite|node:sqlite)['"]/.test(source)) add('sqlite', path);
      if (/(?:require\s*\(\s*|from\s+|import\s*)['"](?:pg|postgres|pg-native)['"]/.test(source)) add('postgres', path);
    } else if (path.endsWith('.prisma')) {
      const source = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
      if (/\bprovider\s*=\s*"sqlite"/.test(source)) add('sqlite', path);
      if (/\bprovider\s*=\s*"postgresql"/.test(source)) add('postgres', path);
    }
  }
  return { engine: found.size === 1 ? [...found.keys()][0] : found.size > 1 ? 'mixed' : 'unknown',
    evidence: [...found.values()].flat() };
}

async function assertCompatible(repository, { environment, selected }) {
  if (!selected) return { engine: 'unknown', evidence: [] };
  try {
    const api = await github.getInstallationOctokit();
    let revision;
    try { revision = await github.getRef(repository.owner, repository.repo, environment === 'prod' ? 'prod' : 'main'); }
    catch (error) {
      // Onboarding creates prod from main when it does not exist yet.
      if (environment !== 'prod' || error.status !== 404) throw error;
      revision = await github.getRef(repository.owner, repository.repo, 'main');
    }
    const entries = await Promise.all(PATHS.map(async path => {
      try {
        const { data } = await api.request('GET /repos/{owner}/{repo}/contents/{path}', {
          ...repository, path, ref: revision, request: { timeout: 10000 },
        });
        if (data.type && data.type !== 'file') return null;
        if (data.size > 131072 || data.encoding !== 'base64' || typeof data.content !== 'string') {
          throw new Error('Unsupported source file');
        }
        return [path, Buffer.from(data.content, 'base64').toString('utf8')];
      } catch (error) { if (error.status === 404) return null; throw error; }
    }));
    const result = detect(Object.fromEntries(entries.filter(Boolean)));
    if (['sqlite', 'postgres'].includes(result.engine) && result.engine !== selected) {
      const detected = result.engine === 'sqlite' ? 'SQLite' : 'PostgreSQL';
      const wanted = selected === 'sqlite' ? 'SQLite' : 'PostgreSQL';
      const choice = result.engine === 'sqlite' ? 'GCP GCS (SQLite)' : 'un hébergement PostgreSQL (GCP Cloud SQL ou Azure)';
      throw Object.assign(new Error(`Le dépôt utilise ${detected} (${result.evidence.join(', ')}), mais ${wanted} est sélectionné. Choisissez ${choice} ou adaptez le code. Aucun déploiement n’a été créé.`), { code: 'DATABASE_MISMATCH' });
    }
    return result;
  } catch (error) {
    if (error.code === 'DATABASE_MISMATCH') throw error;
    throw new Error('Impossible de vérifier la compatibilité SQLite/PostgreSQL du dépôt. Vérifiez son accès GitHub et ses fichiers de dépendances, puis réessayez. Aucun déploiement n’a été créé.');
  }
}

module.exports = { assertCompatible, detect };
