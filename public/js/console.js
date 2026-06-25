'use strict';

// ── Sidebar ──────────────────────────────────────────────────────────────────
function toggleSidebar() {
  const s = document.getElementById('sidebar');
  const o = document.getElementById('sidebarOverlay');
  const h = document.getElementById('hamburger');
  const open = s?.classList.toggle('open');
  o?.classList.toggle('visible', open);
  h?.classList.toggle('open', open);
}
function closeSidebar() {
  document.getElementById('sidebar')?.classList.remove('open');
  document.getElementById('sidebarOverlay')?.classList.remove('visible');
  document.getElementById('hamburger')?.classList.remove('open');
}
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeSidebar(); });

// ── State ────────────────────────────────────────────────────────────────────
const serverId = parseInt(location.pathname.split('/').pop(), 10);
if (!serverId) location.href = '/dashboard';

let consoleWs  = null;
let metricsWs  = null;
let serverData = null;
let currentUser = null;

const terminal = document.getElementById('terminal');
const cmdInput = document.getElementById('cmdInput');
const wsStatus = document.getElementById('wsStatus');

// ── ANSI formatter ────────────────────────────────────────────────────────────
function formatLine(raw) {
  let s = raw.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  s = s.replace(/\[WARN\]|\[WARNING\]/gi, m => `<span style="color:var(--yellow)">${m}</span>`);
  s = s.replace(/\[ERROR\]|\[SEVERE\]/gi,  m => `<span style="color:var(--red)">${m}</span>`);
  s = s.replace(/\[INFO\]/gi,              m => `<span style="color:var(--cyan)">${m}</span>`);
  s = s.replace(/Done \([^)]+\)/g,         m => `<span style="color:var(--green);font-weight:600">${m}</span>`);
  return s;
}

function appendLine(text) {
  const el = document.createElement('div');
  el.className = 'terminal-line';
  el.innerHTML = formatLine(text);
  terminal?.appendChild(el);
  if (terminal && terminal.scrollTop + terminal.clientHeight >= terminal.scrollHeight - 100) {
    terminal.scrollTop = terminal.scrollHeight;
  }
}

function clearConsole() { if (terminal) terminal.innerHTML = ''; }

// ── Load user info ────────────────────────────────────────────────────────────
async function loadMe() {
  try {
    const res = await fetch('/api/me');
    if (!res.ok) return;
    currentUser = await res.json();
    const u = currentUser.username;
    if (document.getElementById('sidebarUsername')) document.getElementById('sidebarUsername').textContent = u;
    if (document.getElementById('avatarInitial'))   document.getElementById('avatarInitial').textContent  = u[0].toUpperCase();
    const roleEl = document.getElementById('sidebarRole');
    if (roleEl) roleEl.innerHTML = currentUser.isAdmin
      ? '<span class="role-badge-admin">Admin</span>'
      : '<span class="role-badge-user">User</span>';
    if (!currentUser.isAdmin) {
      document.getElementById('navNewServer')?.style && (document.getElementById('navNewServer').style.display = 'none');
      document.getElementById('navUsers')?.style && (document.getElementById('navUsers').style.display = 'none');
    }
  } catch {}
}

// ── Load server metadata ──────────────────────────────────────────────────────
async function loadServer() {
  const res = await fetch(`/api/servers/${serverId}`);
  if (!res.ok) { location.href = '/dashboard'; return; }
  serverData = await res.json();

  document.title = `${serverData.name} — GamingBurst Panel`;
  document.getElementById('pageTitle').textContent  = serverData.name;
  document.getElementById('serverName').textContent = serverData.name;
  document.getElementById('serverPort').textContent = `:${serverData.port}`;
  document.getElementById('serverTz').textContent   = `🌏 ${serverData.env_tz}`;
  document.getElementById('metRamMax').textContent  = `/ ${serverData.memory_max} MB`;

  updateStatusUI(serverData.status);

  // Role-based UI adjustments
  const hasConsole = currentUser?.isAdmin || currentUser?.permissions?.includes('console');
  if (!hasConsole) {
    // Hide console, show restricted message
    document.getElementById('consoleWrapper')?.classList.add('hidden');
    document.getElementById('consoleRestricted')?.classList.remove('hidden');
  }

  // Hide delete if not admin
  if (!currentUser?.isAdmin) {
    document.getElementById('btnDelete')?.classList.add('hidden');
  } else {
    document.getElementById('btnDelete')?.classList.remove('hidden');
  }

  // Server info grid
  const infoGrid = document.getElementById('serverInfo');
  const fields = [
    ['Directory',   serverData.server_dir],
    ['JAR',         serverData.jar_path.split('/').pop()],
    ['Min RAM',     serverData.memory_min + ' MB'],
    ['Max RAM',     serverData.memory_max + ' MB'],
    ['Port',        serverData.port],
    ['Timezone',    serverData.env_tz],
    ['Created',     new Date(serverData.created_at).toLocaleString('en-IN')],
    ['Last Start',  serverData.last_started ? new Date(serverData.last_started).toLocaleString('en-IN') : 'Never'],
  ];
  if (infoGrid) infoGrid.innerHTML = fields.map(([k,v]) => `
    <div>
      <div class="text-muted text-sm">${k}</div>
      <div class="mono" style="font-size:12px;color:var(--text-primary);margin-top:2px;word-break:break-all">${esc(String(v))}</div>
    </div>
  `).join('');
}

function updateStatusUI(status) {
  const badge = document.getElementById('statusBadge');
  if (badge) { badge.className = `badge badge-${status}`; badge.innerHTML = `<span class="badge-dot"></span> ${status}`; }
  const isRunning = status === 'running' || status === 'starting';
  document.getElementById('btnStart')?.classList.toggle('hidden', isRunning);
  document.getElementById('btnStop')?.classList.toggle('hidden', !isRunning);
  document.getElementById('btnRestart')?.classList.toggle('hidden', !isRunning);
}

// ── Actions ───────────────────────────────────────────────────────────────────
async function serverAction(action) {
  const ids  = { start: 'btnStart', stop: 'btnStop', restart: 'btnRestart' };
  const labs = { start: '▶ Start', stop: '⏹ Stop', restart: '↺ Restart' };
  const btn  = document.getElementById(ids[action]);
  if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>'; }
  try {
    const res  = await fetch(`/api/servers/${serverId}/${action}`, { method: 'POST' });
    const data = await res.json();
    if (!res.ok) alert(data.error);
    else loadServer();
  } catch (e) { alert(e.message); }
  finally { if (btn) { btn.disabled = false; btn.innerHTML = labs[action]; } }
}

async function deleteServer() {
  if (!confirm(`Are you sure you want to delete this server? This will permanently erase all server data, including worlds, plugins, configurations, and files. This action cannot be undone.`)) return;
  const res = await fetch(`/api/servers/${serverId}`, { method: 'DELETE' });
  if (res.ok) location.href = '/dashboard';
  else { const d = await res.json(); alert(d.error); }
}

// ── Console WS ────────────────────────────────────────────────────────────────
function connectConsole() {
  if (!currentUser?.isAdmin && !currentUser?.permissions?.includes('console')) return; // skip if no access
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  consoleWs   = new WebSocket(`${proto}://${location.host}/ws/console/${serverId}`);

  consoleWs.onopen = () => {
    if (wsStatus) { wsStatus.className = 'badge badge-running'; wsStatus.innerHTML = '<span class="badge-dot"></span> connected'; }
  };
  consoleWs.onmessage = (e) => {
    try { const m = JSON.parse(e.data); if (m.type === 'log') appendLine(m.line); } catch {}
  };
  consoleWs.onclose = (e) => {
    if (wsStatus) { wsStatus.className = 'badge badge-stopped'; wsStatus.innerHTML = '<span class="badge-dot"></span> disconnected'; }
    if (e.code !== 4003) setTimeout(connectConsole, 3000); // 4003 = admin denied
  };
  consoleWs.onerror = () => {};
}

// ── Metrics WS ────────────────────────────────────────────────────────────────
function connectMetrics() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  metricsWs   = new WebSocket(`${proto}://${location.host}/ws/metrics/${serverId}`);
  metricsWs.onmessage = (e) => {
    try {
      const m = JSON.parse(e.data);
      if (m.type !== 'metrics') return;
      // Deduct 15% to hide JVM native overhead and simulate Heap usage for better UX
      const simulatedHeap = Math.floor(m.ram_mb * 0.85);
      const displayedRam = serverData?.memory_max ? Math.min(simulatedHeap, serverData.memory_max) : simulatedHeap;
      
      document.getElementById('metRam').textContent = displayedRam;
      document.getElementById('metCpu').textContent = m.cpu_pct.toFixed(1);
      const memPct = serverData?.memory_max ? Math.min(Math.round(displayedRam / serverData.memory_max * 100), 100) : 0;
      const cpuPct = Math.min(m.cpu_pct, 100);
      const rb = document.getElementById('ramBar');
      if (rb) { rb.style.width = memPct + '%'; rb.className = 'progress-fill' + (memPct > 90 ? ' crit' : memPct > 70 ? ' warn' : ''); }
      const cb = document.getElementById('cpuBar');
      if (cb) { cb.style.width = cpuPct + '%'; cb.className = 'progress-fill' + (cpuPct > 90 ? ' crit' : cpuPct > 70 ? ' warn' : ''); }
      if (m.status) updateStatusUI(m.status);
    } catch {}
  };
  metricsWs.onclose = () => setTimeout(connectMetrics, 3000);
  metricsWs.onerror = () => {};
}

// ── Command input ─────────────────────────────────────────────────────────────
function sendCmd() {
  const cmd = cmdInput?.value.trim();
  if (!cmd) return;
  if (consoleWs?.readyState === WebSocket.OPEN) {
    consoleWs.send(JSON.stringify({ type: 'command', command: cmd }));
    appendLine(`> ${cmd}`);
  }
  if (cmdInput) cmdInput.value = '';
}
cmdInput?.addEventListener('keydown', e => { if (e.key === 'Enter') sendCmd(); });

function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

// ── Boot ──────────────────────────────────────────────────────────────────────
loadMe().then(loadServer).then(() => {
  connectConsole();
  connectMetrics();
});
