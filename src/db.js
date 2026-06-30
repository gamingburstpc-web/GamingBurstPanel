'use strict';

const { Database: _Database } = require('node-sqlite3-wasm');
const bcrypt = require('bcryptjs');
const path   = require('path');
const fs     = require('fs');

const DB_PATH       = path.resolve(process.env.DB_PATH || './data/panel.db');
const BCRYPT_ROUNDS = parseInt(process.env.BCRYPT_ROUNDS || '10', 10);

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

// ── Compat shim ───────────────────────────────────────────────────────────────
// node-sqlite3-wasm Statement.run/get/all take an array.
// This shim makes it accept spread args like better-sqlite3.
function wrapDb(db) {
  const origPrepare = db.prepare.bind(db);
  db.prepare = (sql) => {
    const stmt   = origPrepare(sql);
    const oRun   = stmt.run.bind(stmt);
    const oGet   = stmt.get.bind(stmt);
    const oAll   = stmt.all.bind(stmt);
    const toArr  = (args) => (args.length === 1 && Array.isArray(args[0]) ? args[0] : args);
    stmt.run = (...args) => oRun(toArr(args));
    stmt.get = (...args) => oGet(toArr(args));
    stmt.all = (...args) => oAll(toArr(args));
    return stmt;
  };
  return db;
}

// ── Singleton ─────────────────────────────────────────────────────────────────
let _db = null;

function getDb() {
  if (!_db) {
    const raw = new _Database(DB_PATH);
    _db = wrapDb(raw);
    _db.exec('PRAGMA journal_mode = WAL');
    _db.exec('PRAGMA busy_timeout = 5000');
    _db.exec('PRAGMA foreign_keys = ON');
    _db.exec('PRAGMA temp_store = MEMORY');
    _db.exec('PRAGMA cache_size = -8000');
  }
  return _db;
}

// ── Schema ────────────────────────────────────────────────────────────────────
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS users (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    username    TEXT    NOT NULL UNIQUE,
    password    TEXT    NOT NULL,
    is_admin    INTEGER DEFAULT 0,
    permissions TEXT    DEFAULT '[]',
    must_change INTEGER DEFAULT 0,
    created_at  TEXT    DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);

  CREATE TABLE IF NOT EXISTS servers (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    name         TEXT    NOT NULL UNIQUE,
    port         INTEGER NOT NULL UNIQUE,
    memory_min   INTEGER DEFAULT 512,
    memory_max   INTEGER DEFAULT 2048,
    jar_path     TEXT    NOT NULL,
    jvm_flags    TEXT    DEFAULT '',
    env_tz       TEXT    DEFAULT 'Asia/Kolkata',
    env_custom   TEXT    DEFAULT '{}',
    status       TEXT    DEFAULT 'stopped',
    pid          INTEGER,
    server_dir   TEXT    NOT NULL,
    created_at   TEXT    DEFAULT (datetime('now')),
    last_started TEXT,
    owner_id     INTEGER DEFAULT NULL,
    expire_at    INTEGER DEFAULT NULL,
    delete_after INTEGER DEFAULT NULL,
    bedrock_port INTEGER DEFAULT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_servers_status ON servers(status);
  CREATE INDEX IF NOT EXISTS idx_servers_port   ON servers(port);

  CREATE TABLE IF NOT EXISTS server_logs (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    server_id INTEGER NOT NULL,
    line      TEXT    NOT NULL,
    ts        TEXT    DEFAULT (datetime('now')),
    FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_logs_server ON server_logs(server_id);
`;

// ── Migrations (safe to re-run) ───────────────────────────────────────────────
function runMigrations(db) {
  // Add is_admin column if upgrading from earlier schema
  try { db.exec('ALTER TABLE users ADD COLUMN is_admin INTEGER DEFAULT 0'); } catch {}
  try { db.exec("ALTER TABLE users ADD COLUMN permissions TEXT DEFAULT '[]'"); } catch {}
  try { db.exec('ALTER TABLE servers ADD COLUMN owner_id INTEGER DEFAULT NULL'); } catch {}
  try { db.exec('ALTER TABLE servers ADD COLUMN expire_at INTEGER DEFAULT NULL'); } catch {}
  try { db.exec('ALTER TABLE servers ADD COLUMN delete_after INTEGER DEFAULT NULL'); } catch {}
  try { db.exec('ALTER TABLE servers ADD COLUMN bedrock_port INTEGER DEFAULT NULL'); } catch {}
  // Sessions table — created here so it works on existing databases that predate the SCHEMA addition
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id         TEXT    PRIMARY KEY,
        user_id    INTEGER NOT NULL,
        data       TEXT    NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
      CREATE INDEX IF NOT EXISTS idx_sessions_exp  ON sessions(expires_at);
    `);
  } catch (e) {
    console.error('[DB] Warning: could not create sessions table:', e.message);
  }
}

// ── Seed admin/admin for dev/testing ─────────────────────────────────────────
function seedAdmin(db) {
  const count = db.prepare('SELECT COUNT(*) as cnt FROM users').get();
  if (count.cnt === 0) {
    const hash = bcrypt.hashSync('admin', BCRYPT_ROUNDS);
    db.prepare('INSERT INTO users (username, password, is_admin, must_change) VALUES (?, ?, 1, 0)')
      .run('admin', hash);
    console.log('[DB] Seeded dev user → username: admin  password: admin  (admin role)');
    console.log('[DB] ⚠️  Use "node bin/gbpanel.js user add" to create production users!');
  }
}

// ── Public init ───────────────────────────────────────────────────────────────
function initDb() {
  const db = getDb();
  db.exec(SCHEMA);
  runMigrations(db);
  seedAdmin(db);
  console.log(`[DB] SQLite ready → ${DB_PATH}`);
  return db;
}

// ── Log ring buffer (last 500 lines per server) ───────────────────────────────
function trimLogs(serverId) {
  const db = getDb();
  db.prepare(`
    DELETE FROM server_logs
    WHERE server_id = ?
      AND id NOT IN (
        SELECT id FROM server_logs
        WHERE server_id = ?
        ORDER BY id DESC
        LIMIT 500
      )
  `).run(serverId, serverId);
}

// ── Prepared statement cache ──────────────────────────────────────────────────
const _stmts = {};
function stmt(sql) {
  if (!_stmts[sql]) _stmts[sql] = getDb().prepare(sql);
  return _stmts[sql];
}

// ── Helper: count users (for setup-mode detection) ────────────────────────────
function hasUsers() {
  try {
    const row = getDb().prepare('SELECT COUNT(*) as cnt FROM users').get();
    return row.cnt > 0;
  } catch { return false; }
}

module.exports = { getDb, initDb, trimLogs, stmt, hasUsers };
