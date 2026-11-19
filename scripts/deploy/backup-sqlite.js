#!/usr/bin/env node
'use strict';

// Take an online SQLite backup, upload it to the dedicated regional bucket,
// then download and integrity-check the uploaded object before reporting success.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const Database = require('better-sqlite3');

const bucket = process.env.CNP_PORTAL_BACKUP_BUCKET || 'gs://cnp-portal-backup-512313';
const timestamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
const object = `${bucket}/sqlite/${timestamp}.sqlite`;
const remoteFile = `/tmp/cnp-portal-${timestamp}.sqlite`;
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cnp-portal-backup-'));
const localFile = path.join(tempDir, 'backup.sqlite');
const restoredFile = path.join(tempDir, 'restored.sqlite');

function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`${command} failed: ${result.stderr || result.stdout || result.error?.message}`);
  }
  return result.stdout.trim();
}

let pod;
try {
  pod = run('kubectl', [
    '-n', 'cnp-portal', 'get', 'pod', '-l', 'app.kubernetes.io/name=cnp-portal',
    '-o', 'jsonpath={.items[0].metadata.name}',
  ]);
  if (!pod) throw new Error('No portal pod found.');
  run('kubectl', ['-n', 'cnp-portal', 'exec', pod, '--', 'node', '-e',
    'const Database=require("better-sqlite3"); const db=new Database(process.env.DB_PATH,{readonly:true}); db.backup(process.argv[1]).then(()=>db.close()).catch(e=>{console.error(e.message);process.exit(1)});',
    remoteFile]);
  run('kubectl', ['-n', 'cnp-portal', 'cp', `${pod}:${remoteFile}`, localFile]);
  run('gcloud', ['storage', 'cp', localFile, object]);
  run('gcloud', ['storage', 'cp', object, restoredFile]);
  const restored = new Database(restoredFile, { readonly: true, fileMustExist: true });
  try {
    const check = restored.pragma('integrity_check', { simple: true });
    if (check !== 'ok') throw new Error(`Restored SQLite integrity check failed: ${check}`);
    if (!restored.prepare("SELECT 1 FROM sqlite_master WHERE name = 'users'").get()) {
      throw new Error('Restored SQLite backup lacks the users table.');
    }
  } finally { restored.close(); }
  console.log(`Backup uploaded and restore-tested: ${object}`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  if (pod) spawnSync('kubectl', ['-n', 'cnp-portal', 'exec', pod, '--', 'node', '-e',
    'try{require("fs").unlinkSync(process.argv[1])}catch(e){if(e.code!=="ENOENT")process.exit(1)}', remoteFile], { encoding: 'utf8' });
  fs.rmSync(tempDir, { recursive: true, force: true });
}
