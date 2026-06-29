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

// ── Date display ─────────────────────────────────────────────────────────────
const dateEl = document.getElementById('dateDisplay');
if (dateEl) dateEl.textContent = new Date().toLocaleDateString('en-IN', {
  weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
});

// ── Check error banner ────────────────────────────────────────────────────────
const params = new URLSearchParams(location.search);
if (params.get('error') === 'forbidden') {
  const b = document.getElementById('errorBanner');
  const m = document.getElementById('errorBannerMsg');
  if (b && m) { m.textContent = 'Access denied — admin only.'; b.classList.remove('hidden'); }
}

// ── Load user info (role) ─────────────────────────────────────────────────────
let currentUser = null;

async function loadMe() {
  try {
    const res  = await fetch('/api/me');
    if (!res.ok) return;
    currentUser = await res.json();

    // Update sidebar
    const u = currentUser.username;
    if (document.getElementById('sidebarUsername')) document.getElementById('sidebarUsername').textContent = u;
    if (document.getElementById('avatarInitial'))   document.getElementById('avatarInitial').textContent = u[0].toUpperCase();

    const roleEl = document.getElementById('sidebarRole');
    if (roleEl) {
      roleEl.innerHTML = currentUser.isAdmin
        ? '<span class="role-badge-admin">Admin</span>'
        : '<span class="role-badge-user">User</span>';
    }

    // Hide admin-only nav items for non-admins
    if (!currentUser.isAdmin) {
      const p = currentUser.permissions || {};
      const globalPerms = Array.isArray(p) ? p : (p.global || []);
      const canCreate = globalPerms.includes('create_server');
      
      const navNew = document.getElementById('navNewServer');
      if (navNew && !canCreate) navNew.style.display = 'none';
      const navUsers = document.getElementById('navUsers');
      if (navUsers) navUsers.style.display = 'none';
      const btnNew = document.getElementById('btnNewServer');
      if (btnNew && !canCreate) btnNew.style.display = 'none';
    }
  } catch {}
}

// ── Load & render servers ─────────────────────────────────────────────────────
async function loadServers() {
  const grid = document.getElementById('serverGrid');
  try {
    const res     = await fetch('/api/servers');
    const servers = await res.json();

    document.getElementById('statTotal').textContent   = servers.length;
    document.getElementById('statRunning').textContent = servers.filter(s => s.status === 'running').length;
    document.getElementById('statStopped').textContent = servers.filter(s => s.status === 'stopped').length;
    document.getElementById('statCrashed').textContent = servers.filter(s => s.status === 'crashed').length;

    if (!servers.length) {
      grid.innerHTML = `<div class="empty-state">
        <div class="empty-icon">🎮</div>
        <h3>No servers yet</h3>
        <p>Create your first Minecraft server to get started.</p>
        ${(currentUser?.isAdmin || (currentUser?.permissions?.global?.includes('create_server')) || (Array.isArray(currentUser?.permissions) && currentUser?.permissions.includes('create_server'))) ? '<a href="/servers/new" class="btn btn-primary">➕ Create Server</a>' : '<p class="text-muted text-sm">Ask your admin to create a server.</p>'}
      </div>`;
      return;
    }

    const isAdmin = currentUser?.isAdmin;
    grid.innerHTML = servers.map(s => `
      <div class="server-card ${s.status}" onclick="window.location='/servers/${s.id}'">
        <div class="server-card-header">
          <div>
            <div class="server-name">${esc(s.name)}</div>
            <div class="server-port">:${s.port}</div>
          </div>
          <span class="badge badge-${s.status}"><span class="badge-dot"></span>${s.status}</span>
        </div>
        <div class="server-card-meta">
          <span class="meta-chip">RAM: ${s.memory_max} MB</span>
          <span class="meta-chip">TZ: ${esc(s.env_tz)}</span>
          ${s.pid ? `<span class="meta-chip">PID: ${s.pid}</span>` : ''}
        </div>
        <div class="server-card-actions" onclick="event.stopPropagation()">
          ${s.status === 'running' || s.status === 'starting'
            ? `<button class="btn btn-danger btn-sm"  onclick="quickAction(${s.id},'stop',this)">⏹ Stop</button>
               <button class="btn btn-warning btn-sm" onclick="quickAction(${s.id},'restart',this)">↺ Restart</button>`
            : `<button class="btn btn-success btn-sm" onclick="quickAction(${s.id},'start',this)">▶ Start</button>`
          }
          <a href="/servers/${s.id}" class="btn btn-ghost btn-sm">Console →</a>
        </div>
      </div>
    `).join('');
  } catch (err) {
    grid.innerHTML = `<div class="empty-state"><div class="empty-icon">⚠️</div><h3>Failed to load</h3><p>${err.message}</p></div>`;
  }
}

async function quickAction(id, action, btn) {
  const label = { start: '▶ Start', stop: '⏹ Stop', restart: '↺ Restart' };
  btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>';
  try {
    const res = await fetch(`/api/servers/${id}/${action}`, { method: 'POST' });
    const d   = await res.json();
    if (!res.ok) throw new Error(d.error);
    setTimeout(loadServers, action === 'restart' ? 3500 : 800);
  } catch (e) {
    alert('Error: ' + e.message);
    btn.disabled = false; btn.innerHTML = label[action] || action;
  }
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

// ── Global WS ─────────────────────────────────────────────────────────────────
function connectGlobalWs() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws    = new WebSocket(`${proto}://${location.host}/ws/global`);
  ws.onmessage = () => loadServers();
  ws.onclose   = () => setTimeout(connectGlobalWs, 3000);
  ws.onerror   = () => {};
}

// ── Boot ──────────────────────────────────────────────────────────────────────
loadMe().then(loadServers);
connectGlobalWs();
setInterval(loadServers, 20000);
