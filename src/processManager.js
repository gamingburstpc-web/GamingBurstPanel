'use strict';

const { spawn, execSync } = require('child_process');
const path          = require('path');
const fs            = require('fs');
const playitManager = require('./playitManager');
const EventEmitter  = require('events');
const { getDb, trimLogs } = require('./db');

// Detect Java version on startup
let javaVersion = 17;
try {
  const output = execSync('java -version 2>&1').toString();
  const match = output.match(/(?:version|build) "([0-9]+)/i) || output.match(/openjdk (\d+)/i);
  if (match) {
    javaVersion = parseInt(match[1], 10);
    console.log(`[ProcessManager] Detected Java version: ${javaVersion}`);
  }
} catch (e) {
  console.warn(`[ProcessManager] Could not detect Java version, defaulting to 17: ${e.message}`);
}

// ── ZGC vm.max_map_count helper ───────────────────────────────────────────────
// ZGC uses memory multi-mapping (3 virtual mappings per region). On Linux, the
// default vm.max_map_count (65536) is often too low for large heaps, causing the
// Linux OOM killer to terminate the process and crash the VM.
// This function checks the limit and tries to raise it automatically.
function ensureMaxMapCountForZgc(heapMb) {
  if (process.platform !== 'linux') return true; // not Linux, skip
  try {
    const mapCountPath = '/proc/sys/vm/max_map_count';
    const current = parseInt(fs.readFileSync(mapCountPath, 'utf8').trim(), 10);
    // ZGC needs roughly: heapMb / 2 (2MB regions) * 3 (multi-mapping) + 10000 overhead
    const required = Math.ceil((heapMb / 2) * 3) + 10000;
    if (current >= required) {
      console.log(`[ProcessManager] vm.max_map_count=${current} is sufficient for ZGC (need ${required}).`);
      return true;
    }
    // Try to raise it automatically
    const target = Math.max(required, 262144);
    console.warn(`[ProcessManager] vm.max_map_count=${current} is too low for ${heapMb}MB ZGC heap (need ${required}). Attempting to raise to ${target}...`);
    try {
      execSync(`sysctl -w vm.max_map_count=${target}`, { stdio: 'pipe' });
      console.log(`[ProcessManager] Successfully raised vm.max_map_count to ${target}.`);
      return true;
    } catch (sysctlErr) {
      console.error(`[ProcessManager] Could not raise vm.max_map_count (permission denied). Falling back to Aikar G1GC to prevent VM crash.`);
      return false;
    }
  } catch (e) {
    // If we can't read the file (non-Linux?), assume safe
    return true;
  }
}


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
  if (isRunning(serverId)) return { pid: getPid(serverId) };

  const db     = getDb();
  const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(serverId);
  if (!server) throw new Error(`Server ${serverId} not found.`);

  if (server.expire_at && Date.now() > server.expire_at) {
    db.prepare('UPDATE servers SET status = ? WHERE id = ?').run('expired', serverId);
    throw new Error('Subscription ended. Cannot start server.');
  }

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

    // ── Validate and clamp memory values ─────────────────────────────────
    const os = require('os');
    const systemRamMb = Math.floor(os.totalmem() / 1024 / 1024);
    // Reserve 2048 MB for OS kernel, ZGC native threads, and other processes.
    // ZGC requires extra native RAM outside the heap for its concurrent threads.
    const maxAllowedRamMb = Math.max(1024, systemRamMb - 2048);

    let memMin = parseInt(server.memory_min, 10);
    let memMax = parseInt(server.memory_max, 10);

    if (isNaN(memMin) || memMin < 128) memMin = 512;
    if (isNaN(memMax) || memMax < 128) memMax = 1024;

    // Clamp instead of reject — let the server start with the safe maximum
    if (memMax > maxAllowedRamMb) {
      console.warn(`[ProcessManager] Server "${server.name}": configured RAM ${memMax} MB exceeds safe limit (${maxAllowedRamMb} MB). Clamping automatically.`);
      memMax = maxAllowedRamMb;
    }

    // Ensure min does not exceed max (can happen if both were set to the same
    // value and the user later reduced max without touching min)
    if (memMin > memMax) memMin = Math.floor(memMax / 2);

    // ── GC Profile selection ──────────────────────────────────────────────
    // Read gc_profile from env_custom JSON. Defaults to 'zgc'.
    let gcProfile = 'zgc';
    try {
      const envObj = JSON.parse(server.env_custom || '{}');
      if (envObj.gc_profile) gcProfile = envObj.gc_profile;
    } catch {}

    // ── ZGC compatibility & safety checks ────────────────────────────────
    if (gcProfile === 'zgc') {
      if (javaVersion < 15) {
        console.warn(`[ProcessManager] ZGC is not supported on Java ${javaVersion}. Falling back to Aikar G1GC.`);
        gcProfile = 'aikar';
      } else if (!ensureMaxMapCountForZgc(memMax)) {
        // vm.max_map_count is too low and could not be raised — using ZGC would
        // cause the Linux OOM killer to kill the process and potentially crash the VM.
        gcProfile = 'aikar';
      } else {
        // ── KEY ZGC FIX: Force Xms to 512MB ──────────────────────────────
        // ZGC is designed to start with a SMALL heap and grow/shrink dynamically.
        // A large -Xms forces ZGC to commit that entire amount of physical RAM
        // immediately at startup — this is exactly what was climbing VPS RAM from
        // 10GB→11GB→12GB and eventually crashing the VM.
        // With Xms=512MB, ZGC starts lean, grows as players join, and
        // automatically releases unused RAM back to the OS when they leave.
        memMin = 512;
        console.log(`[ProcessManager] ZGC: overriding Xms to 512MB (ZGC manages heap dynamically, Xmx=${memMax}MB).`);
      }
    }

    // Build Xms/Xmx AFTER ZGC override so the 512MB Xms is respected.
    const jvmArgs = [`-Xms${memMin}M`, `-Xmx${memMax}M`];

    if (gcProfile === 'aikar') {
      // Classic Aikar G1GC flags — zero lag spikes, but high idle RAM usage
      jvmArgs.push(
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
      );
      console.log(`[ProcessManager] Server "${server.name}" using Aikar G1GC profile.`);
    } else if (gcProfile === 'zgc') {
      // ZGC — generational or non-generational depending on Java version
      jvmArgs.push('-XX:+UseZGC');
      // -XX:+ZGenerational was removed and made default starting with Java 24
      if (javaVersion >= 21 && javaVersion < 24) {
        jvmArgs.push('-XX:+ZGenerational');
      }
      jvmArgs.push(
        '-XX:+UnlockExperimentalVMOptions',
        '-XX:ConcGCThreads=2',
        '-XX:+DisableExplicitGC'
      );
      if (javaVersion >= 21) {
        console.log(`[ProcessManager] Server "${server.name}" using Generational ZGC (Java ${javaVersion}), Xms=512MB Xmx=${memMax}MB.`);
      } else {
        console.log(`[ProcessManager] Server "${server.name}" using ZGC (Java ${javaVersion}), Xms=512MB Xmx=${memMax}MB.`);
      }
    } else {
      // 'standard' — no extra flags, plain JVM defaults
      console.log(`[ProcessManager] Server "${server.name}" using Standard JVM profile.`);
    }



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

function getNextAvailablePort() {
  const db = getDb();
  let port = 25565;
  while (true) {
    const row = db.prepare('SELECT id FROM servers WHERE port = ? OR bedrock_port = ?').get(port, port);
    if (!row) return port;
    port++;
  }
}

// Background loop for checking expired subscriptions and auto-deletions
setInterval(() => {
  try {
    const db = getDb();
    
    // Check expirations
    const runningServers = db.prepare("SELECT id, expire_at FROM servers WHERE status IN ('starting', 'running') AND expire_at IS NOT NULL").all();
    for (const s of runningServers) {
      if (Date.now() > s.expire_at) {
        console.log(`[ProcessManager] Server ${s.id} subscription expired! Stopping automatically.`);
        try {
          stopServer(s.id);
          db.prepare('UPDATE servers SET status = ? WHERE id = ?').run('expired', s.id);
        } catch (e) {
          console.error(`Failed to stop expired server ${s.id}:`, e);
        }
      }
    }
    
    // Check automatic deletions
    const pendingDeletions = db.prepare("SELECT id, server_dir, expire_at, delete_after FROM servers WHERE delete_after IS NOT NULL AND expire_at IS NOT NULL").all();
    for (const s of pendingDeletions) {
      const deleteAt = s.expire_at + (s.delete_after * 24 * 60 * 60 * 1000);
      if (Date.now() > deleteAt) {
        console.log(`[ProcessManager] Server ${s.id} data deletion time reached! Deleting automatically.`);
        try {
          if (isRunning(s.id)) stopServer(s.id);
          if (s.server_dir && fs.existsSync(s.server_dir)) {
            fs.rmSync(s.server_dir, { recursive: true, force: true });
          }
          db.prepare('DELETE FROM servers WHERE id = ?').run(s.id);
        } catch (e) {
          console.error(`Failed to delete server ${s.id}:`, e);
        }
      }
    }
  } catch (err) {}
}, 60000);

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
