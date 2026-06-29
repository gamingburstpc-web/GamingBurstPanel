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
    const res = await fetch('/api/servers');
    if (res.ok) {
      availableServers = await res.json();
      const s = document.getElementById('addServerSelect');
      if (s) {
        s.innerHTML = '<option value="">-- Select a Server --</option>';
        availableServers.forEach(srv => {
          s.innerHTML += `<option value="${srv.id}">${srv.name}</option>`;
        });
      }
    }
  } catch (err) { console.error('Failed to fetch servers'); }
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
    let isOwner = false;
    let isSubUser = false;
    let serversHtml = [];
    
    // Check owned servers
    availableServers.forEach(s => {
      if (s.owner_id === u.id) {
        isOwner = true;
        serversHtml.push(`<span class="badge" style="background:rgba(35,134,54,0.1);color:#3fb950">${s.name} (Owner)</span>`);
      }
    });
    
    // Check server perms
    if (u.permissions && u.permissions.servers) {
      for (const sid of Object.keys(u.permissions.servers)) {
        // Skip if already owner
        const isAlreadyOwner = availableServers.find(s => s.id == sid && s.owner_id == u.id);
        if (!isAlreadyOwner) {
          isSubUser = true;
          const sObj = availableServers.find(s => s.id == sid);
          const sName = sObj ? sObj.name : `#${sid}`;
          serversHtml.push(`<span class="badge" style="background:rgba(255,255,255,0.05);color:var(--text-secondary)">${sName} (Access)</span>`);
        }
      }
    }
    
    // Filtering logic
    if (filterId === 'admins' && u.is_admin !== 1) continue;
    if (filterId === 'owners' && !isOwner) continue;
    if (filterId === 'subusers' && !isSubUser) continue;
    
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
      if (globalCount > 0) permsText = `${globalCount} Global`;
    }

    html += `
      <tr>
        <td>#${u.id}</td>
        <td><strong style="color:var(--text-primary)">${u.username}</strong> ${isMe ? '<span style="font-size:11px;color:var(--text-muted)">(You)</span>' : ''}</td>
        <td>${roleBadge}<br><span class="text-muted text-sm">${permsText}</span></td>
        <td><div style="display:flex; flex-direction:column; gap:4px; align-items:flex-start;">${serversHtml.length > 0 ? serversHtml.join('') : '-'}</div></td>
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
  
  if (isAdmin) {
    permsGroup.style.opacity = '0.5';
    checkboxes.forEach(cb => cb.disabled = true);
  } else {
    permsGroup.style.opacity = '1';
    checkboxes.forEach(cb => cb.disabled = false);
  }
}

function startEditUser(id) {
  const user = loadedUsers.find(u => u.id === id);
  if (!user) return;
  editUserId = id;
  document.getElementById('formCardTitle').textContent = `✏️ Edit User #${id}`;
  document.getElementById('addUsername').value = user.username;
  document.getElementById('addPassword').required = false;
  document.getElementById('addBtn').textContent = 'Update User';
  document.getElementById('cancelEditBtn').classList.remove('hidden');

  const isAdminCheckbox = document.getElementById('addIsAdmin');
  isAdminCheckbox.checked = user.is_admin === 1;

  document.querySelectorAll('#globalPerms .perm-cb').forEach(cb => cb.checked = false);

  if (user.permissions) {
    let p = user.permissions;
    if (Array.isArray(p)) p = { global: p, servers: {} };
    if (p.global) {
      document.querySelectorAll('#globalPerms .perm-cb').forEach(cb => {
        if (p.global.includes(cb.value)) cb.checked = true;
      });
    }
  }
  
  togglePerms();
}

function cancelEditMode() {
  editUserId = null;
  document.getElementById('formCardTitle').textContent = '➕ Add New User';
  document.getElementById('addUsername').value = '';
  document.getElementById('addPassword').value = '';
  document.getElementById('addPassword').required = true;
  document.getElementById('addBtn').textContent = 'Create User';
  document.getElementById('cancelEditBtn').classList.add('hidden');
  document.getElementById('addIsAdmin').checked = false;
  document.querySelectorAll('#globalPerms .perm-cb').forEach(cb => cb.checked = false);
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
  const p = { global: [], servers: {} };
  document.querySelectorAll('#globalPerms .perm-cb').forEach(cb => {
    if (cb.checked) p.global.push(cb.value);
  });
  
  // Preserve existing server permissions if editing
  if (editUserId !== null) {
    const u = loadedUsers.find(x => x.id === editUserId);
    if (u && u.permissions && u.permissions.servers) {
      p.servers = u.permissions.servers;
    }
  }
  
  const permissions = p;

  if (editUserId !== null) {
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
