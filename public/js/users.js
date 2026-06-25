'use strict';

let myId = null;
let loadedUsers = [];
let editMode = false;
let editUserId = null;

async function fetchMe() {
  try {
    const r = await fetch('/api/me');
    const d = await r.json();
    myId = d.id;
  } catch {}
}

async function loadUsers() {
  const tbody = document.getElementById('usersList');
  try {
    const res = await fetch('/api/users');
    if (!res.ok) throw new Error('Failed to fetch users');
    loadedUsers = await res.json();
    
    if (loadedUsers.length === 0) {
      tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;padding:32px;color:var(--text-muted)">No users found.</td></tr>';
      return;
    }

    let html = '';
    for (const u of loadedUsers) {
      const isMe = u.id === myId;
      const roleBadge = u.is_admin === 1 
        ? `<span class="badge" style="background:rgba(91,110,255,0.1);color:var(--accent)">Admin</span>`
        : `<span class="badge" style="background:rgba(255,255,255,0.05);color:var(--text-secondary)">User</span>`;
      
      const permsInfo = u.is_admin === 1 
        ? '<span class="text-muted text-sm">All Permissions</span>'
        : `<span class="text-muted text-sm">${u.permissions.join(', ') || 'No extra perms'}</span>`;

      html += `
        <tr>
          <td>#${u.id}</td>
          <td><strong style="color:var(--text-primary)">${u.username}</strong> ${isMe ? '<span style="font-size:11px;color:var(--text-muted)">(You)</span>' : ''}</td>
          <td>${roleBadge}<br>${permsInfo}</td>
          <td class="text-muted text-sm">${new Date(u.created_at).toLocaleDateString()}</td>
          <td style="text-align:right; white-space:nowrap;">
            <button class="btn btn-sm btn-ghost" style="margin-right:6px;" onclick="startEditUser(${u.id})">⚙️ Edit</button>
            ${!isMe ? `<button class="btn btn-sm" style="background:rgba(248,81,73,0.1);color:#f85149;border-color:transparent;" onclick="deleteUser(${u.id}, '${u.username}')">Delete</button>` : ''}
          </td>
        </tr>
      `;
    }
    tbody.innerHTML = html;
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="5" style="text-align:center;padding:32px;color:#f85149">Error: ${err.message}</td></tr>`;
  }
}

function togglePerms() {
  const isAdmin = document.getElementById('addIsAdmin').checked;
  const permsGroup = document.getElementById('permsGroup');
  const checkboxes = document.querySelectorAll('.perm-cb');
  
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

  // Reset checkboxes first
  document.querySelectorAll('.perm-cb').forEach(cb => cb.checked = false);

  // Set user perms
  if (Array.isArray(user.permissions)) {
    user.permissions.forEach(perm => {
      const cb = document.querySelector(`.perm-cb[value="${perm}"]`);
      if (cb) cb.checked = true;
    });
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
  document.querySelectorAll('.perm-cb').forEach(cb => cb.checked = false);

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
  const permissions = Array.from(document.querySelectorAll('.perm-cb:checked')).map(cb => cb.value);

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
      
      document.getElementById('addUsername').value = '';
      document.getElementById('addPassword').value = '';
      document.querySelectorAll('.perm-cb').forEach(cb => cb.checked = false);
      
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
  loadUsers();
})();
