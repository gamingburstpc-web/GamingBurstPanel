'use strict';

const WebSocket = require('ws');
const { parseSessionFromCookieHeader, getSession } = require('../src/auth');
const pm        = require('../src/processManager');
const { getMetrics, clearPidState } = require('../src/metrics');
const { getDb } = require('../src/db');

const METRICS_INTERVAL_MS = 3000;

function setupWs(httpServer) {
  const wss = new WebSocket.Server({ noServer: true });

  // ── Handle HTTP → WS upgrade ────────────────────────────────────────────
  httpServer.on('upgrade', (request, socket, head) => {
    // Auth check on upgrade handshake
    const sessionId = parseSessionFromCookieHeader(request.headers.cookie);
    const sess      = getSession(sessionId);
    if (!sess) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request, sess);
    });
  });

  // ── Route WS connections by URL ─────────────────────────────────────────
  wss.on('connection', (ws, request, sess) => {
    const url = request.url || '';

    // ── /ws/console/:serverId ─────────────────────────────────────────────
    const consoleMatch = url.match(/^\/ws\/console\/(\d+)$/);
    if (consoleMatch) {
      const hasConsolePerm = sess.isAdmin || sess.permissions?.includes('console');
      if (!hasConsolePerm) {
        ws.close(4003, 'Console access required');
        return;
      }
      handleConsole(ws, parseInt(consoleMatch[1], 10), sess);
      return;
    }

    // ── /ws/metrics/:serverId ──────────────────────────────────────────────
    const metricsMatch = url.match(/^\/ws\/metrics\/(\d+)$/);
    if (metricsMatch) {
      handleMetrics(ws, parseInt(metricsMatch[1], 10));
      return;
    }

    // ── /ws/global (dashboard status updates) ─────────────────────────────
    if (url === '/ws/global') {
      handleGlobal(ws);
      return;
    }

    ws.close(4004, 'Unknown WebSocket route');
  });
}

// ── Console stream handler ────────────────────────────────────────────────────
function handleConsole(ws, serverId, sess) {
  const db = getDb();

  const send = (line) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'log', line }));
    }
  };

  // Replay last 100 log lines from DB
  const logs = db.prepare(`
    SELECT line FROM server_logs
    WHERE server_id = ?
    ORDER BY id DESC LIMIT 100
  `).all(serverId).reverse();
  logs.forEach(r => send(r.line));

  let activeEmitter = null;
  let onLine = null;
  let onCloseEvent = null;

  const attachEmitter = () => {
    if (activeEmitter) {
      activeEmitter.off('line', onLine);
      activeEmitter.off('close', onCloseEvent);
    }
    activeEmitter = pm.getEmitter(serverId);
    if (activeEmitter) {
      onLine = (line) => send(line);
      onCloseEvent = (code) => {
        send(`\n[Panel] Server stopped (exit code: ${code ?? 'null'})`);
      };
      activeEmitter.on('line', onLine);
      activeEmitter.on('close', onCloseEvent);
    }
  };

  attachEmitter(); // Attach immediately if already running

  // If the server starts while we are connected, attach to the new emitter
  const onStatus = ({ serverId: sid, status }) => {
    if (sid === serverId && (status === 'starting' || status === 'running')) {
      attachEmitter();
    }
  };
  pm.globalEmitter.on('status', onStatus);

  ws.on('close', () => {
    if (activeEmitter) {
      activeEmitter.off('line', onLine);
      activeEmitter.off('close', onCloseEvent);
    }
    pm.globalEmitter.off('status', onStatus);
  });

  // Handle commands sent from browser terminal
  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);
      if (msg.type === 'command' && msg.command) {
        pm.sendCommand(serverId, msg.command.trim());
      }
    } catch {}
  });

  ws.on('error', () => {});
}

// ── Metrics stream handler ────────────────────────────────────────────────────
function handleMetrics(ws, serverId) {
  const db = getDb();

  const send = (data) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'metrics', ...data }));
    }
  };

  let intervalId = null;

  const startPolling = () => {
    const pid = pm.getPid(serverId);
    if (!pid) {
      send({ ram_mb: 0, cpu_pct: 0, status: 'offline', ts: Date.now() });
      return;
    }

    intervalId = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) {
        clearInterval(intervalId);
        return;
      }

      const livePid = pm.getPid(serverId);
      if (!livePid) {
        clearInterval(intervalId);
        send({ ram_mb: 0, cpu_pct: 0, status: 'offline', ts: Date.now() });
        return;
      }

      const m = getMetrics(livePid);
      const row = db.prepare('SELECT status, memory_max FROM servers WHERE id = ?').get(serverId);
      send({
        ...m,
        status:     row?.status || 'unknown',
        memory_max: row?.memory_max || 2048,
      });
    }, METRICS_INTERVAL_MS);
  };

  startPolling();

  // Re-subscribe if server starts while WS is open
  const onStatus = ({ serverId: sid, status }) => {
    if (sid !== serverId) return;
    if (status === 'running') {
      clearInterval(intervalId);
      startPolling();
    } else if (status === 'stopped' || status === 'crashed') {
      clearInterval(intervalId);
      clearPidState(pm.getPid(serverId));
      send({ ram_mb: 0, cpu_pct: 0, status, ts: Date.now() });
    }
  };

  pm.globalEmitter.on('status', onStatus);

  ws.on('close', () => {
    clearInterval(intervalId);
    pm.globalEmitter.off('status', onStatus);
  });
  ws.on('error', () => {});
}

// ── Global dashboard status handler ──────────────────────────────────────────
function handleGlobal(ws) {
  const onStatus = (data) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'status', ...data }));
    }
  };

  pm.globalEmitter.on('status', onStatus);
  ws.on('close', () => pm.globalEmitter.off('status', onStatus));
  ws.on('error', () => {});
}

module.exports = { setupWs };
