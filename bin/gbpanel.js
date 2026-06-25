#!/usr/bin/env node
'use strict';

/**
 * GamingBurst Panel — CLI Tool
 * Usage:
 *   node bin/gbpanel.js user add
 *   node bin/gbpanel.js user list
 *   node bin/gbpanel.js user remove <username>
 */

const path = require('path');
const fs   = require('fs');

// Always resolve paths relative to project root (one level up from bin/)
process.chdir(path.join(__dirname, '..'));

// Load .env if present
const envPath = path.join(process.cwd(), '.env');
if (fs.existsSync(envPath)) require('dotenv').config({ path: envPath });

const readline = require('readline');
const bcrypt   = require('bcryptjs');
const { getDb, initDb } = require('../src/db');
const http = require('http');

const BCRYPT_ROUNDS = parseInt(process.env.BCRYPT_ROUNDS || '10', 10);
const PANEL_PORT = process.env.PANEL_PORT || '7676';

function doFetch(url, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({
        ok: res.statusCode >= 200 && res.statusCode < 300,
        json: () => JSON.parse(data)
      }));
    });
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

let _proxy = null;
async function getDbProxy() {
  if (_proxy) return _proxy;
  try {
    const res = await doFetch(`http://127.0.0.1:${PANEL_PORT}/api/ping`);
    if (res.ok) {
      const send = async (method, sql, args) => {
        const r = await doFetch(`http://127.0.0.1:${PANEL_PORT}/api/cli`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ method, sql, args })
        });
        const d = await r.json();
        if (d.error) throw new Error(d.error);
        return d.result;
      };
      _proxy = {
        prepare: (sql) => ({
          run: async (...args) => send('run', sql, args),
          get: async (...args) => send('get', sql, args),
          all: async (...args) => send('all', sql, args)
        })
      };
      return _proxy;
    }
  } catch (e) {}

  // Server is offline, use direct DB access wrapped in promises
  initDb();
  const directDb = getDb();
  _proxy = {
    prepare: (sql) => {
      const stmt = directDb.prepare(sql);
      return {
        run: async (...args) => stmt.run(...args),
        get: async (...args) => stmt.get(...args),
        all: async (...args) => stmt.all(...args)
      };
    }
  };
  return _proxy;
}

// ── ANSI colours ──────────────────────────────────────────────────────────────
const C = {
  reset:  '\x1b[0m',
  bold:   '\x1b[1m',
  dim:    '\x1b[2m',
  green:  '\x1b[32m',
  red:    '\x1b[31m',
  yellow: '\x1b[33m',
  cyan:   '\x1b[36m',
  white:  '\x1b[37m',
  bgBlue: '\x1b[44m',
};

function print(msg)  { process.stdout.write(msg + '\n'); }
function error(msg)  { print(`${C.red}✗ Error: ${msg}${C.reset}`); }
function success(msg){ print(`${C.green}✓ ${msg}${C.reset}`); }
function info(msg)   { print(`${C.cyan}ℹ ${msg}${C.reset}`); }

function banner() {
  print('');
  print(`${C.bold}${C.cyan}  ╔════════════════════════════════╗${C.reset}`);
  print(`${C.bold}${C.cyan}  ║   GamingBurst Panel  🎮 CLI   ║${C.reset}`);
  print(`${C.bold}${C.cyan}  ╚════════════════════════════════╝${C.reset}`);
  print('');
}

// ── Prompt helpers ────────────────────────────────────────────────────────────
function ask(prompt) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(`${C.bold}${prompt}${C.reset}`, (ans) => {
      rl.close();
      resolve(ans.trim());
    });
  });
}

function maskedAsk(prompt) {
  return new Promise((resolve) => {
    process.stdout.write(`${C.bold}${prompt}${C.reset}`);

    const isTTY = process.stdin.isTTY;
    if (!isTTY) {
      // Non-interactive (piped input) — read normally
      const rl = readline.createInterface({ input: process.stdin, output: null });
      rl.once('line', (line) => { rl.close(); print(''); resolve(line.trim()); });
      return;
    }

    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');

    let input = '';

    const onData = (ch) => {
      if (ch === '\r' || ch === '\n') {
        process.stdin.setRawMode(false);
        process.stdin.pause();
        process.stdin.removeListener('data', onData);
        process.stdout.write('\n');
        resolve(input);
      } else if (ch === '\u0003') {
        // Ctrl+C
        print('\n');
        process.exit(1);
      } else if (ch === '\u007f' || ch === '\b') {
        // Backspace
        if (input.length > 0) {
          input = input.slice(0, -1);
          process.stdout.write('\b \b');
        }
      } else {
        input += ch;
        process.stdout.write('•');
      }
    };

    process.stdin.on('data', onData);
  });
}

// ── Commands ──────────────────────────────────────────────────────────────────

async function cmdUserAdd() {
  banner();
  print(`${C.bold}Creating a new user account${C.reset}\n`);

  const db = await getDbProxy();

  // Username
  let username = '';
  while (!username) {
    username = await ask('  Username: ');
    if (!username) { error('Username cannot be empty.'); username = ''; continue; }
    if (!/^[a-zA-Z0-9_\-]{3,32}$/.test(username)) {
      error('Username must be 3–32 chars, letters/numbers/dash/underscore only.');
      username = ''; continue;
    }
    const exists = await db.prepare('SELECT id FROM users WHERE username = ?').get(username);
    if (exists) { error(`User "${username}" already exists.`); username = ''; }
  }

  // Password
  let password = '';
  while (!password) {
    password = await maskedAsk('  Password: ');
    if (password.length < 4) {
      error('Password must be at least 4 characters.');
      password = ''; continue;
    }
    const confirm = await maskedAsk('  Confirm Password: ');
    if (password !== confirm) {
      error('Passwords do not match. Try again.');
      password = ''; continue;
    }
  }

  // Admin?
  let isAdmin = false;
  while (true) {
    const ans = await ask(`  Grant admin privileges? ${C.dim}(admins have full access — console, create/delete servers)${C.reset}\n  Admin [y/N]: `);
    if (ans === '' || ans.toLowerCase() === 'n') { isAdmin = false; break; }
    if (ans.toLowerCase() === 'y') { isAdmin = true; break; }
    error('Please enter y or n.');
  }

  // Create user
  const hash = bcrypt.hashSync(password, BCRYPT_ROUNDS);
  await db.prepare('INSERT INTO users (username, password, is_admin, must_change) VALUES (?, ?, ?, 0)')
    .run(username, hash, isAdmin ? 1 : 0);

  print('');
  success(`User ${C.bold}"${username}"${C.reset}${C.green} created successfully!`);
  print(`  ${C.dim}Role: ${isAdmin ? `${C.green}Administrator${C.dim}` : `${C.yellow}Standard User${C.dim} (start/stop/restart only)`}${C.reset}`);
  print('');
}

async function cmdUserList() {
  banner();
  const db = await getDbProxy();
  const users = await db.prepare('SELECT id, username, is_admin, must_change, created_at FROM users ORDER BY id ASC').all();

  if (!users.length) {
    info('No users found. Run: node bin/gbpanel.js user add');
    return;
  }

  print(`${C.bold}  Users (${users.length} total)${C.reset}\n`);
  print(`  ${'ID'.padEnd(4)} ${'Username'.padEnd(20)} ${'Role'.padEnd(16)} ${'Created'}` );
  print(`  ${'─'.repeat(60)}`);
  for (const u of users) {
    const role   = u.is_admin ? `${C.cyan}Administrator${C.reset}` : `${C.yellow}Standard${C.reset}`;
    const pwFlag = u.must_change ? ` ${C.dim}[must change pw]${C.reset}` : '';
    print(`  ${String(u.id).padEnd(4)} ${u.username.padEnd(20)} ${role.padEnd(27)} ${C.dim}${u.created_at}${C.reset}${pwFlag}`);
  }
  print('');
}

async function cmdUserRemove(username) {
  if (!username) { error('Usage: gbpanel user remove <username>'); process.exit(1); }
  banner();
  const db = await getDbProxy();
  const user = await db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user) { error(`User "${username}" not found.`); process.exit(1); }

  const confirm = await ask(`  Are you sure you want to remove user "${C.bold}${username}${C.reset}"? [y/N]: `);
  if (confirm.toLowerCase() !== 'y') { info('Aborted.'); return; }

  await db.prepare('DELETE FROM users WHERE username = ?').run(username);
  success(`User "${username}" removed.`);
  print('');
}

async function cmdUserResetPw(username) {
  if (!username) { error('Usage: gbpanel user reset-password <username>'); process.exit(1); }
  banner();
  const db = await getDbProxy();
  const user = await db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user) { error(`User "${username}" not found.`); process.exit(1); }

  let password = '';
  while (!password) {
    password = await maskedAsk('  New Password: ');
    if (password.length < 4) { error('Password must be at least 4 characters.'); password = ''; continue; }
    const confirm = await maskedAsk('  Confirm Password: ');
    if (password !== confirm) { error('Passwords do not match.'); password = ''; continue; }
  }

  const hash = bcrypt.hashSync(password, BCRYPT_ROUNDS);
  await db.prepare('UPDATE users SET password = ?, must_change = 0 WHERE username = ?').run(hash, username);
  success(`Password for "${username}" has been reset.`);
  print('');
}

async function cmdServerList() {
  banner();
  const db = await getDbProxy();
  const servers = await db.prepare('SELECT id, name, port, status, server_dir FROM servers ORDER BY id ASC').all();

  if (!servers.length) {
    info('No servers found. Create one in the web panel dashboard.');
    return;
  }

  print(`${C.bold}  Servers (${servers.length} total)${C.reset}\n`);
  print(`  ${'ID'.padEnd(4)} ${'Server Name'.padEnd(20)} ${'Port'.padEnd(8)} ${'Status'.padEnd(12)} ${'Directory Path'}`);
  print(`  ${'─'.repeat(80)}`);
  for (const s of servers) {
    let statCol = C.dim;
    if (s.status === 'running') statCol = C.green;
    else if (s.status === 'starting') statCol = C.yellow;
    else if (s.status === 'crashed') statCol = C.red;

    const absPath = path.resolve(s.server_dir);
    print(`  ${String(s.id).padEnd(4)} ${s.name.padEnd(20)} ${String(s.port).padEnd(8)} ${statCol}${s.status.padEnd(12)}${C.reset} ${absPath}`);
  }
  print('');
  info(`To cd directly into a server's folder, run:`);
  print(`  ${C.bold}cd $(gbpanel server path <server_name>)${C.reset}`);
  print('');
}

async function cmdServerPath(name) {
  if (!name) { error('Usage: gbpanel server path <server_name>'); process.exit(1); }
  const db = await getDbProxy();
  const server = await db.prepare('SELECT server_dir FROM servers WHERE name = ?').get(name);
  if (!server) {
    const serverById = await db.prepare('SELECT server_dir FROM servers WHERE id = ?').get(parseInt(name, 10) || 0);
    if (!serverById) {
      error(`Server "${name}" not found.`);
      process.exit(1);
    }
    print(path.resolve(serverById.server_dir));
    return;
  }
  print(path.resolve(server.server_dir));
}

// ── Main router ───────────────────────────────────────────────────────────────
async function main() {
  const [,, cmd, sub, ...rest] = process.argv;

  if (cmd === 'user') {
    if (sub === 'add')   return await cmdUserAdd();
    if (sub === 'list')  return await cmdUserList();
    if (sub === 'remove') return await cmdUserRemove(rest[0]);
    if (sub === 'reset-password') return await cmdUserResetPw(rest[0]);
  } else if (cmd === 'server') {
    if (sub === 'list')  return await cmdServerList();
    if (sub === 'path')  return await cmdServerPath(rest[0]);
  }

  // Help
  banner();
  print(`${C.bold}Usage:${C.reset}`);
  print(`  ${C.cyan}gbpanel${C.reset} <command> [options]\n`);
  print(`${C.bold}Commands:${C.reset}`);
  print(`  ${C.green}user add${C.reset}                      Create a new user (interactive)`);
  print(`  ${C.green}user list${C.reset}                     List all users`);
  print(`  ${C.green}user remove ${C.dim}<username>${C.reset}       Remove a user`);
  print(`  ${C.green}user reset-password ${C.dim}<username>${C.reset} Reset a user's password`);
  print(`  ${C.green}server list${C.reset}                   List all servers, ports & paths`);
  print(`  ${C.green}server path ${C.dim}<server_name>${C.reset}    Print absolute path of a server`);
  print('');
  print(`${C.bold}Examples:${C.reset}`);
  print(`  ${C.dim}sudo gbpanel user add${C.reset}`);
  print(`  ${C.dim}sudo gbpanel server list${C.reset}`);
  print(`  ${C.dim}cd $(gbpanel server path my-server)${C.reset}`);
  print('');
}

main().catch((err) => {
  error(err.message);
  process.exit(1);
});
