'use strict';

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcryptjs');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '../../data/cnp-portal.sqlite');

const dataDir = path.dirname(DB_PATH);
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id           TEXT PRIMARY KEY,
    gitlab_id    INTEGER UNIQUE,
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

// Seed default admin (local login)
const adminExists = db.prepare('SELECT id FROM users WHERE username = ?').get('admin');
if (!adminExists) {
  const hash = bcrypt.hashSync('admin', 10);
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO users (id, gitlab_id, username, email, avatar_url, password_hash, role, active, created_at, updated_at)
    VALUES (?, NULL, 'admin', 'admin@local', NULL, ?, 'manager', 1, ?, ?)
  `).run(uuidv4(), hash, now, now);
}

module.exports = db;
