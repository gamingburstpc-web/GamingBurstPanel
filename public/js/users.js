'use strict';

let myId = null;
let loadedUsers = [];
let availableServers = [];
let editMode = false;
let editUserId = null;

async function fetchMe() {
  try {
    const r = await fetch('/api/me');
    const d = await r.json();
    myId = d.id;
  } catch {}
}

async function fetchServers() {
  try {
    const r = await fetch('/api/servers');
    availableServers = await r.json();
    const select = document.getElementById('serverSelect');
    const filterSelect = document.getElementById('userFilterSelect');
    
    select.innerHTML = '<option value="">-- Select a Server --</option>';
    let filterHtml = '<option value="all">All Users</option>';
    
    availableServers.forEach(s => {
      select.innerHTML += `<option value="${s.id}">${s.name} (Port ${s.port})</option>`;
      filterHtml += `<option value="${s.id}">${s.name}</option>`;
    });
    
    if (filterSelect) filterSelect.innerHTML = filterHtml;
  } catch {}
}

function filterUsers() {
  const tbody = document.getElementById('usersList');
  const filterSelect = document.getElementById('userFilterSelect');
  const filterId = filterSelect ? filterSelect.value : 'all';
  
  if (loadedUsers.length === 0) {
    tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;padding:32px;color:var(--text-muted)">No users found.</td></tr>';
    return;
  }

  let html = '';
  let count = 0;
  for (const u of loadedUsers) {
    // Check if user matches filter
    if (filterId !== 'all') {
      if (u.is_admin !== 1) {
        let hasAccess = false;
        if (u.permissions) {
          if (u.permissions.global && u.permissions.global.length > 0) hasAccess = true;
          if (u.permissions.servers && u.permissions.servers[filterId]) hasAccess = true;
        }
        if (!hasAccess) continue;
      }
    }
    
    count++;
    const isMe = u.id === myId;
    const roleBadge = u.is_admin === 1 
      ? `<span class="badge" style="background:rgba(91,110,255,0.1);color:var(--accent)">Admin</span>`
      : `<span class="badge" style="background:rgba(255,255,255,0.05);color:var(--text-secondary)">User</span>`;
    
    let permsText = 'No extra perms';
    if (u.is_admin === 1) {
      permsText = 'All Permissions';
    } else if (u.permissions) {
      const p = u.permissions;
      const globalCount = p.global ? p.global.length : 0;
      const serverCount = p.servers ? Object.keys(p.servers).length : 0;
      if (globalCount > 0 || serverCount > 0) {
        permsText = `${globalCount} Global, ${serverCount} Server(s)`;
      }
    }

    html += `
      <tr>
        <td>#${u.id}</td>
        <td><strong style="color:var(--text-primary)">${u.username}</strong> ${isMe ? '<span style="font-size:11px;color:var(--text-muted)">(You)</span>' : ''}</td>
        <td>${roleBadge}<br><span class="text-muted text-sm">${permsText}</span></td>
        <td class="text-muted text-sm">${new Date(u.created_at).toLocaleDateString()}</td>
        <td style="text-align:right; white-space:nowrap;">
          <button class="btn btn-sm btn-ghost" style="margin-right:6px;" onclick="startEditUser(${u.id})">⚙️ Edit</button>
          ${!isMe ? `<button class="btn btn-sm" style="background:rgba(248,81,73,0.1);color:#f85149;border-color:transparent;" onclick="deleteUser(${u.id}, '${u.username}')">Delete</button>` : ''}
        </td>
      </tr>
    `;
  }
  
  if (count === 0) {
    html = '<tr><td colspan="5" style="text-align:center;padding:32px;color:var(--text-muted)">No users found matching this filter.</td></tr>';
  }
  
  tbody.innerHTML = html;
}

async function loadUsers() {
  const tbody = document.getElementById('usersList');
  try {
    const res = await fetch('/api/users');
    if (!res.ok) throw new Error('Failed to fetch users');
    loadedUsers = await res.json();
    filterUsers();
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="5" style="text-align:center;padding:32px;color:#f85149">Error: ${err.message}</td></tr>`;
  }
}

function togglePerms() {
  const isAdmin = document.getElementById('addIsAdmin').checked;
  const permsGroup = document.getElementById('permsGroup');
  const checkboxes = document.querySelectorAll('#permsGroup input[type="checkbox"]');
  const serverSelect = document.getElementById('serverSelect');
  const addServerBtn = document.querySelector('button[onclick="addServerPermBlock()"]');
  
  if (isAdmin) {
    permsGroup.style.opacity = '0.5';
    checkboxes.forEach(cb => cb.disabled = true);
    serverSelect.disabled = true;
    addServerBtn.disabled = true;
  } else {
    permsGroup.style.opacity = '1';
    checkboxes.forEach(cb => cb.disabled = false);
    serverSelect.disabled = false;
    addServerBtn.disabled = false;
  }
}

function addServerPermBlock(existingServerId = null, existingPerms = []) {
  let serverIdStr = existingServerId;
  if (!serverIdStr) {
    const select = document.getElementById('serverSelect');
    serverIdStr = select.value;
    if (!serverIdStr) return alert('Please select a server first.');
  }

  const serverId = parseInt(serverIdStr, 10);
  const container = document.getElementById('serverPermsContainer');
  
  if (container.querySelector(`[data-server-id="${serverId}"]`)) {
    return alert('Permissions for this server are already added above.');
  }

  const server = availableServers.find(s => s.id === serverId);
  const serverName = server ? server.name : `Server #${serverId}`;

  const template = document.getElementById('serverPermTemplate');
  const clone = template.content.cloneNode(true);
  
  const card = clone.querySelector('.server-perm-card');
  card.setAttribute('data-server-id', serverId);
  
  const title = clone.querySelector('.server-perm-title');
  title.textContent = serverName;
  
  const checkboxes = clone.querySelectorAll('.s-perm-cb');
  checkboxes.forEach(cb => {
    if (existingPerms.includes(cb.value)) {
      cb.checked = true;
    }
  });

  container.appendChild(clone);
  
  if (document.getElementById('addIsAdmin').checked) {
    togglePerms(); // disable if admin is checked
  }
}

function startEditUser(id) {
  const user = loadedUsers.find(u => u.id === id);
  if (!user) return;

  editMode = true;
  editUserId = id;

  document.getElementById('formCardTitle').textContent = '✏️ Edit User';
  document.getElementById('addBtn').textContent = 'Save Changes';
  document.getElementById('cancelEditBtn').classList.remove('hidden');

  document.getElementById('addUsername').value = user.username;
  
  const passwordField = document.getElementById('addPassword');
  passwordField.required = false;
  passwordField.value = '';
  document.getElementById('passwordLabel').textContent = 'Password (optional)';

  const isAdminCheckbox = document.getElementById('addIsAdmin');
  isAdminCheckbox.checked = user.is_admin === 1;

  // Reset UI
  document.querySelectorAll('#globalPerms .perm-cb').forEach(cb => cb.checked = false);
  document.getElementById('serverPermsContainer').innerHTML = '';
  document.getElementById('serverSelect').value = '';

  // Set user perms
  if (user.permissions) {
    if (user.permissions.global) {
      user.permissions.global.forEach(perm => {
        const cb = document.querySelector(`#globalPerms .perm-cb[value="${perm}"]`);
        if (cb) cb.checked = true;
      });
    }
    if (user.permissions.servers) {
      for (const [sId, sPerms] of Object.entries(user.permissions.servers)) {
        addServerPermBlock(sId, sPerms);
      }
    }
  }

  togglePerms();
}

function cancelEditMode() {
  editMode = false;
  editUserId = null;

  document.getElementById('formCardTitle').textContent = '➕ Add New User';
  document.getElementById('addBtn').textContent = 'Create User';
  document.getElementById('cancelEditBtn').classList.add('hidden');

  document.getElementById('addUsername').value = '';
  
  const passwordField = document.getElementById('addPassword');
  passwordField.required = true;
  passwordField.value = '';
  document.getElementById('passwordLabel').textContent = 'Password';

  document.getElementById('addIsAdmin').checked = false;
  
  // Reset UI
  document.querySelectorAll('#globalPerms .perm-cb').forEach(cb => cb.checked = false);
  document.getElementById('serverPermsContainer').innerHTML = '';
  document.getElementById('serverSelect').value = '';

  togglePerms();
}

document.getElementById('addUserForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = document.getElementById('addBtn');
  const alertE = document.getElementById('alert');
  const alertS = document.getElementById('alertSuccess');
  alertE.classList.add('hidden');
  alertS.classList.add('hidden');
  btn.disabled = true;

  const username = document.getElementById('addUsername').value;
  const password = document.getElementById('addPassword').value;
  const is_admin = document.getElementById('addIsAdmin').checked;
  
  // Collect Global Permissions
  const globalPerms = Array.from(document.querySelectorAll('#globalPerms .perm-cb:checked')).map(cb => cb.value);
  
  // Collect Server Permissions
  const serverPerms = {};
  document.querySelectorAll('.server-perm-card').forEach(card => {
    const sId = card.getAttribute('data-server-id');
    const checked = Array.from(card.querySelectorAll('.s-perm-cb:checked')).map(cb => cb.value);
    if (sId) serverPerms[sId] = checked;
  });
  
  const permissions = { global: globalPerms, servers: serverPerms };

  if (editMode) {
    btn.textContent = 'Saving...';
    try {
      const res = await fetch(`/api/users/${editUserId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password, is_admin, permissions })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to update user');
      
      alertS.querySelector('#alertSuccessMsg').textContent = `User ${username} updated successfully!`;
      alertS.classList.remove('hidden');
      cancelEditMode();
      loadUsers();
    } catch (err) {
      alertE.querySelector('#alertMsg').textContent = err.message;
      alertE.classList.remove('hidden');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Save Changes';
    }
  } else {
    btn.textContent = 'Creating...';
    try {
      const res = await fetch('/api/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password, is_admin, permissions })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to create user');
      
      cancelEditMode(); // Resets everything
      
      alertS.querySelector('#alertSuccessMsg').textContent = `User ${username} created!`;
      alertS.classList.remove('hidden');
      loadUsers();
    } catch (err) {
      alertE.querySelector('#alertMsg').textContent = err.message;
      alertE.classList.remove('hidden');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Create User';
    }
  }
});

async function deleteUser(id, username) {
  if (!confirm(`Are you sure you want to delete user "${username}"?`)) return;
  try {
    const res = await fetch(`/api/users/${id}`, { method: 'DELETE' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to delete');
    loadUsers();
  } catch (err) {
    alert(err.message);
  }
}

// Init
(async () => {
  await fetchMe();
  await fetchServers();
  loadUsers();
})();
