'use strict';

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcryptjs');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '../../data');
const DB_PATH  = process.env.DB_PATH  || path.join(DATA_DIR, 'cnp-portal.sqlite');

const dataDir = path.dirname(DB_PATH);
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id           TEXT PRIMARY KEY,
    gitlab_id    INTEGER UNIQUE,
    github_id    INTEGER UNIQUE,
    username     TEXT NOT NULL UNIQUE,
    email        TEXT,
    avatar_url   TEXT,
    password_hash TEXT,
    role         TEXT NOT NULL DEFAULT 'dev',
    active       INTEGER NOT NULL DEFAULT 1,
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL
  )
`);

// Migrations: add columns introduced after initial schema
const cols = db.pragma('table_info(users)').map(c => c.name);
if (!cols.includes('github_id')) {
  db.exec('ALTER TABLE users ADD COLUMN github_id INTEGER');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_github_id ON users(github_id) WHERE github_id IS NOT NULL');
}
if (!cols.includes('approved')) {
  // Existing users are already approved; new OAuth users will explicitly set approved=0
  db.exec('ALTER TABLE users ADD COLUMN approved INTEGER NOT NULL DEFAULT 1');
}

// Seed default admin (local login) — always active and approved
const adminExists = db.prepare('SELECT id FROM users WHERE username = ?').get('admin');
if (!adminExists) {
  const hash = bcrypt.hashSync('admin', 10);
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO users (id, gitlab_id, github_id, username, email, avatar_url, password_hash, role, active, approved, created_at, updated_at)
    VALUES (?, NULL, NULL, 'admin', 'admin@local', NULL, ?, 'manager', 1, 1, ?, ?)
  `).run(uuidv4(), hash, now, now);
}

module.exports = db;
