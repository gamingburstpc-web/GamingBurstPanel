'use strict';

window.showAlert = function(type, msg) {
  if (msg === undefined) {
    msg = type;
    type = 'info';
  }
  console.log(`[${type}] ${msg}`);
  
  const alertEl = document.getElementById('alert');
  const alertSuccessEl = document.getElementById('alertSuccess');
  
  if (alertEl && alertSuccessEl) {
    if (type === 'success' || type === 'info') {
      document.getElementById('alertSuccessMsg').innerText = msg;
      alertSuccessEl.classList.remove('hidden');
      alertEl.classList.add('hidden');
    } else {
      document.getElementById('alertMsg').innerText = msg;
      alertEl.classList.remove('hidden');
      alertSuccessEl.classList.add('hidden');
    }
    
    // Scroll to top to see the alert
    window.scrollTo({ top: 0, behavior: 'smooth' });
    
    // Auto hide after 5 seconds
    setTimeout(() => {
      if (alertEl) alertEl.classList.add('hidden');
      if (alertSuccessEl) alertSuccessEl.classList.add('hidden');
    }, 5000);
  } else {
    alert(msg);
  }
};

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
  
  const autoScroll = document.getElementById('autoscrollToggle');
  if (terminal && (!autoScroll || autoScroll.checked)) {
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
      const navNew = document.getElementById('navNewServer');
      if (navNew) navNew.style.display = 'none';
      document.getElementById('navUsers')?.style && (document.getElementById('navUsers').style.display = 'none');
      
      const hasPerm = (perm) => {
        if (Array.isArray(p)) return p.includes(perm);
        return globalPerms.includes(perm) || (p.servers && p.servers[serverId] && p.servers[serverId].includes(perm));
      };
      
      document.querySelectorAll('.admin-only, .admin-only-block').forEach(el => el.style.display = 'none');

      const toggleTab = (id, perm) => {
        const btn = document.getElementById(id);
        if (btn) btn.classList.toggle('hidden', !hasPerm(perm));
      };
      toggleTab('tabBtnConsole', 'console');
      toggleTab('tabBtnFiles', 'files');
      toggleTab('tabBtnPlugins', 'plugins');
      toggleTab('tabBtnPlayit', 'playit');
      toggleTab('tabBtnPlayers', 'players');
      toggleTab('tabBtnSettings', 'settings');
    } else {
      ['Console', 'Files', 'Plugins', 'Playit', 'Players', 'Settings'].forEach(t => document.getElementById('tabBtn' + t)?.classList.remove('hidden'));
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
  
  if (serverData.is_expired && !currentUser?.isAdmin) {
    const overlay = document.getElementById('subscriptionOverlay');
    if (overlay) {
      overlay.style.display = 'flex';
      overlay.classList.remove('hidden');
      
      const pText = overlay.querySelector('p');
      if (pText) {
        if (serverData.delete_at) {
          const diffDays = Math.ceil((serverData.delete_at - Date.now()) / (1000 * 60 * 60 * 24));
          const timeStr = diffDays > 0 ? `within ${diffDays} day(s)` : 'immediately';
          pText.innerHTML = `Please contact your Provider to extend it ${timeStr} or else server data will be deleted.<br><br>Thank you for playing!`;
        } else {
          pText.innerHTML = `Please contact your Provider to extend your subscription.<br><br>Thank you for playing!`;
        }
      }
    }
    // Disable all actions
    document.getElementById('topbarActions').style.display = 'none';
    return;
  }
  
  document.getElementById('serverTz').textContent   = `🌏 ${serverData.env_tz}`;
  document.getElementById('metRamMax').textContent  = `/ ${serverData.memory_max} MB`;

  if (serverData.jar_path && serverData.jar_path.toLowerCase().includes('vanilla')) {
    const pluginsBtn = document.getElementById('tabBtnPlugins');
    if (pluginsBtn) pluginsBtn.style.display = 'none';
  }

  const formatBytesStr = (bytes) => {
    if (bytes > 1024 * 1024 * 1024) return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
    if (bytes > 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    return (bytes / 1024).toFixed(1) + ' KB';
  };
  
  const formatBytes = (bytes) => {
    if (bytes > 1024 * 1024 * 1024) return [(bytes / (1024 * 1024 * 1024)).toFixed(2), 'GB'];
    if (bytes > 1024 * 1024) return [(bytes / (1024 * 1024)).toFixed(1), 'MB'];
    return [(bytes / 1024).toFixed(1), 'KB'];
  };

  const [svrDiskVal, svrDiskUnit] = formatBytes(serverData.disk_usage || 0);
  document.getElementById('metDisk').textContent = svrDiskVal;
  document.getElementById('metDiskUnit').textContent = svrDiskUnit;

  if (currentUser?.isAdmin) {
    const [vpsDiskUsedVal, vpsDiskUsedUnit] = formatBytes(serverData.vps_disk_used || 0);
    const [vpsDiskTotalVal, vpsDiskTotalUnit] = formatBytes(serverData.vps_disk_total || 0);
    document.getElementById('metVpsDisk').textContent = `VPS: ${vpsDiskUsedVal} ${vpsDiskUsedUnit} / ${vpsDiskTotalVal} ${vpsDiskTotalUnit}`;
    
    const vpsDiskPct = serverData.vps_disk_total ? Math.min(Math.round((serverData.vps_disk_used / serverData.vps_disk_total) * 100), 100) : 0;
    const db = document.getElementById('diskBar');
    if (db) { db.style.width = vpsDiskPct + '%'; db.className = 'progress-fill' + (vpsDiskPct > 90 ? ' crit' : ''); }

    const [vpsRamUsedVal, vpsRamUsedUnit] = formatBytes(serverData.vps_ram_used || 0);
    const [vpsRamTotalVal, vpsRamTotalUnit] = formatBytes(serverData.vps_ram_total || 0);
    document.getElementById('metVpsRam').textContent = `VPS: ${vpsRamUsedVal} ${vpsRamUsedUnit} / ${vpsRamTotalVal} ${vpsRamTotalUnit}`;
  } else {
    document.getElementById('metVpsDisk').style.display = 'none';
    const db = document.getElementById('diskBar');
    if (db && db.parentElement) db.parentElement.style.display = 'none';
    document.getElementById('metVpsRam').style.display = 'none';
  }

  updateStatusUI(serverData.status);

  // Role-based UI adjustments
  const hasConsole = currentUser?.isAdmin || (() => {
    const p = currentUser?.permissions;
    if (!p) return false;
    if (Array.isArray(p)) return p.includes('console');
    return (p.global && p.global.includes('console')) || (p.servers && p.servers[serverId] && p.servers[serverId].includes('console'));
  })();
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
    ['RAM',         serverData.memory_max + ' MB'],
    ['Disk Usage',  serverData.disk_usage != null ? formatBytesStr(serverData.disk_usage) : 'Unknown'],
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
  if (serverData) serverData.status = status;
  const badge = document.getElementById('statusBadge');
  if (badge) { badge.className = `badge badge-${status}`; badge.innerHTML = `<span class="badge-dot"></span> ${status}`; }
  const isRunning = status === 'running' || status === 'starting';
  
  const hasPerm = (perm) => {
    if (currentUser?.isAdmin) return true;
    const p = currentUser?.permissions;
    if (!p) return false;
    if (Array.isArray(p)) return p.includes(perm);
    return (p.global && p.global.includes(perm)) || (p.servers && p.servers[serverId] && p.servers[serverId].includes(perm));
  };
  
  if (hasPerm('start')) {
    document.getElementById('btnStart')?.classList.toggle('hidden', isRunning);
  } else {
    document.getElementById('btnStart')?.classList.add('hidden');
  }
  
  if (hasPerm('stop')) {
    document.getElementById('btnStop')?.classList.toggle('hidden', !isRunning);
  } else {
    document.getElementById('btnStop')?.classList.add('hidden');
  }
  
  if (hasPerm('restart')) {
    document.getElementById('btnRestart')?.classList.toggle('hidden', !isRunning);
  } else {
    document.getElementById('btnRestart')?.classList.add('hidden');
  }
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
  const canAccessConsole = currentUser?.isAdmin || (() => {
    const p = currentUser?.permissions;
    if (!p) return false;
    if (Array.isArray(p)) return p.includes('console');
    return (p.global && p.global.includes('console')) || (p.servers && p.servers[serverId] && p.servers[serverId].includes('console'));
  })();
  if (!canAccessConsole) return; // skip if no access
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
