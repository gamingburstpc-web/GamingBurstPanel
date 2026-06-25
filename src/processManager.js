'use strict';

const { spawn }     = require('child_process');
const path          = require('path');
const fs            = require('fs');
const playitManager = require('./playitManager');
const EventEmitter  = require('events');
const { getDb, trimLogs } = require('./db');

const SERVERS_DIR = path.resolve(__dirname, '..', 'servers');

// ── Process registry ──────────────────────────────────────────────────────────
// Key: serverId (integer)  Value: { proc, emitter, serverId }
const registry = new Map();

// ── Public event bus (dashboard / WS can listen to status changes) ────────────
const globalEmitter = new EventEmitter();
globalEmitter.setMaxListeners(50);

// ── Port range ────────────────────────────────────────────────────────────────
const PORT_START = 25565;

function getNextAvailablePort() {
  const db   = getDb();
  const rows = db.prepare('SELECT port FROM servers ORDER BY port ASC').all();
  const used  = new Set(rows.map(r => r.port));
  let port    = PORT_START;
  while (used.has(port)) port++;
  return port;
}

// ── Spawn a Minecraft server ─────────────────────────────────────────────────
function startServer(serverId) {
  if (registry.has(serverId)) {
    throw new Error(`Server ${serverId} is already running.`);
  }

  const db     = getDb();
  const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(serverId);
  if (!server) throw new Error(`Server ${serverId} not found.`);

  const serversDir = path.resolve(process.env.SERVERS_DIR || './servers');
  fs.mkdirSync(server.server_dir, { recursive: true });

  // Auto-accept EULA
  const eulaPath = path.join(server.server_dir, 'eula.txt');
  if (!fs.existsSync(eulaPath)) {
    fs.writeFileSync(eulaPath, 'eula=true\n', 'utf8');
  }

  let proc;
  let customEnv = {};
  try { customEnv = JSON.parse(server.env_custom || '{}'); } catch {}

  const childEnv = {
    ...process.env,
    TZ: server.env_tz || process.env.DEFAULT_TZ || 'Asia/Kolkata',
    ...customEnv,
  };

  if (server.jar_path.endsWith('.jar')) {
    // Java Server
    const jvmArgs = [
      `-Xms${server.memory_min}M`,
      `-Xmx${server.memory_max}M`,
      '-XX:+UseG1GC',
      '-XX:+ParallelRefProcEnabled',
      '-XX:MaxGCPauseMillis=200',
      '-XX:+UnlockExperimentalVMOptions',
      '-XX:+DisableExplicitGC',
      '-XX:G1NewSizePercent=30',
      '-XX:G1MaxNewSizePercent=40',
      '-XX:G1HeapRegionSize=8M',
      '-XX:G1ReservePercent=20',
      '-XX:G1HeapWastePercent=5',
      '-XX:G1MixedGCCountTarget=4',
      '-XX:InitiatingHeapOccupancyPercent=15',
      '-XX:G1MixedGCLiveThresholdPercent=90',
      '-XX:G1RSetUpdatingPauseTimePercent=5',
      '-XX:SurvivorRatio=32',
      '-XX:+PerfDisableSharedMem',
      '-XX:MaxTenuringThreshold=1',
      '-Dusing.aikars.flags=https://mcflags.emc.gs',
      '-Daikars.new.flags=true',
    ];

    if (server.jvm_flags && server.jvm_flags.trim()) {
      jvmArgs.push(...server.jvm_flags.trim().split(/\s+/));
    }

    jvmArgs.push('-jar', server.jar_path, '--nogui', `--port`, String(server.port));
    
    proc = spawn('java', jvmArgs, {
      cwd:   server.server_dir,
      env:   childEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } else {
    // Bedrock / Binary Server
    childEnv.LD_LIBRARY_PATH = '.';
    proc = spawn(server.jar_path, [], {
      cwd:   server.server_dir,
      env:   childEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  }

  // Update DB status
  db.prepare('UPDATE servers SET status = ?, pid = ?, last_started = datetime(\'now\') WHERE id = ?')
    .run('starting', proc.pid, serverId);

  const emitter = new EventEmitter();
  emitter.setMaxListeners(20);
  registry.set(serverId, { proc, emitter, serverId });

  globalEmitter.emit('status', { serverId, status: 'starting', pid: proc.pid });

  // ── Pipe stdout → DB ring buffer + emitter ────────────────────────────────
  let lineBuffer = '';
  const onData = (chunk) => {
    lineBuffer += chunk.toString();
    const lines = lineBuffer.split('\n');
    lineBuffer  = lines.pop(); // keep incomplete line

    for (const line of lines) {
      if (!line.trim()) continue;

      // Detect "Done" message → mark as running
      if (line.includes('Done (') && line.includes('For help')) {
        db.prepare('UPDATE servers SET status = ? WHERE id = ?').run('running', serverId);
        globalEmitter.emit('status', { serverId, status: 'running' });
      }

      // Store in ring buffer
      db.prepare('INSERT INTO server_logs (server_id, line) VALUES (?, ?)').run(serverId, line);
      trimLogs(serverId);

      // Broadcast to WS listeners
      emitter.emit('line', line);
    }
  };

  proc.stdout.on('data', onData);
  proc.stderr.on('data', onData); // stderr also useful (GC logs, warnings)

  // ── Process exit handling ─────────────────────────────────────────────────
  proc.on('close', (code) => {
    const exitLine = `\n[Panel] Server process exited with code ${code ?? 'null'}`;
    db.prepare('INSERT INTO server_logs (server_id, line) VALUES (?, ?)').run(serverId, exitLine);
    emitter.emit('line', exitLine);

    const finalStatus = code === 0 ? 'stopped' : 'crashed';
    db.prepare('UPDATE servers SET status = ?, pid = NULL WHERE id = ?').run(finalStatus, serverId);
    registry.delete(serverId);
    globalEmitter.emit('status', { serverId, status: finalStatus });
    emitter.emit('close', code);
  });

  proc.on('error', (err) => {
    const errLine = `[Panel] Failed to start Java process: ${err.message}`;
    db.prepare('UPDATE servers SET status = ?, pid = NULL WHERE id = ?').run('crashed', serverId);
    db.prepare('INSERT INTO server_logs (server_id, line) VALUES (?, ?)').run(serverId, errLine);
    registry.delete(serverId);
    globalEmitter.emit('status', { serverId, status: 'crashed' });
    emitter.emit('line', errLine);
    emitter.emit('close', 1);
  });

  // Start Playit tunnel if it exists
  playitManager.startPlayit(serverId, server.server_dir);

  return { pid: proc.pid };
}

// ── Send command to running server's stdin ─────────────────────────────────
function sendCommand(serverId, command) {
  const entry = registry.get(serverId);
  if (!entry) throw new Error(`Server ${serverId} is not running.`);
  entry.proc.stdin.write(command + '\n');
}

// ── Stop a running server ─────────────────────────────────────────────────────
function stopServer(serverId) {
  const entry = registry.get(serverId);
  if (!entry) throw new Error(`Server ${serverId} is not running.`);
  // Send graceful Minecraft stop command first
  try { entry.proc.stdin.write('stop\n'); } catch {}
  // Give 10 seconds then force kill
  const killTimer = setTimeout(() => {
    try { entry.proc.kill('SIGKILL'); } catch {}
  }, 10000);
  killTimer.unref();

  playitManager.stopPlayit(serverId);
}

// ── Kill all running servers (graceful shutdown) ──────────────────────────────
async function killAll() {
  const promises = [];
  for (const [id, entry] of registry) {
    promises.push(new Promise((resolve) => {
      console.log(`[PM] Initiating graceful shutdown for server #${id}...`);
      // Try save-all first to avoid world corruption
      try { entry.proc.stdin.write('save-all\n'); } catch {}
      
      // Stop after a brief 1.5s delay to allow save-all to run
      setTimeout(() => {
        try { entry.proc.stdin.write('stop\n'); } catch {}
      }, 1500);

      // Force SIGKILL if it doesn't shut down in 8 seconds
      const forceKill = setTimeout(() => {
        console.warn(`[PM] Server #${id} did not stop gracefully. Force killing...`);
        try { entry.proc.kill('SIGKILL'); } catch {}
        resolve();
      }, 8000);

      entry.proc.on('close', () => {
        clearTimeout(forceKill);
        resolve();
      });
    }));
  }
  await Promise.all(promises);
}

// ── Get emitter for a server (WS console streaming) ──────────────────────────
function getEmitter(serverId) {
  return registry.get(serverId)?.emitter || null;
}

// ── Get PID for a server (metrics) ───────────────────────────────────────────
function getPid(serverId) {
  return registry.get(serverId)?.proc?.pid || null;
}

function isRunning(serverId) {
  return registry.has(serverId);
}

module.exports = {
  startServer,
  stopServer,
  sendCommand,
  killAll,
  getEmitter,
  getPid,
  isRunning,
  getNextAvailablePort,
  globalEmitter,
};
