let servers = [];
let users = [];
let editServerId = null;

async function fetchInitialData() {
  try {
    const [meRes, sRes, uRes] = await Promise.all([
      fetch('/api/me'),
      fetch('/api/servers'),
      fetch('/api/users')
    ]);
    const me = await meRes.json();
    if (me.username) {
      document.getElementById('sidebarUsername').textContent = me.username;
      document.getElementById('avatarInitial').textContent = me.username[0].toUpperCase();
    }
    
    servers = await sRes.json();
    users = await uRes.json();
    
    // Populate User Dropdown
    const userSelect = document.getElementById('userSelect');
    userSelect.innerHTML = '<option value="">-- No User (Unassigned) --</option>';
    users.forEach(u => {
      if (!u.is_admin) {
        userSelect.innerHTML += `<option value="${u.id}">${u.username}</option>`;
      }
    });

    renderServers();
  } catch (e) {
    console.error(e);
  }
}

function renderServers() {
  const tbody = document.getElementById('serversList');
  tbody.innerHTML = '';
  
  if (servers.length === 0) {
    tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;padding:24px;">No servers found.</td></tr>';
    return;
  }
  
  servers.forEach(s => {
    let ownerText = '<span style="color:var(--text-muted)">Unassigned</span>';
    if (s.owner_id) {
      const u = users.find(x => x.id === s.owner_id);
      ownerText = u ? `<b>${u.username}</b>` : `<i>Unknown (${s.owner_id})</i>`;
    }
    
    let expText = '<span style="color:var(--text-muted)">Permanent</span>';
    let isExpired = false;
    if (s.expire_at) {
      const diff = s.expire_at - Date.now();
      if (diff <= 0) {
        isExpired = true;
        expText = '<span class="expired-badge">Expired</span>';
      } else {
        const days = Math.ceil(diff / (1000 * 60 * 60 * 24));
        expText = `<span style="color:var(--green)">${days} days left</span>`;
      }
    }
    
    const tr = document.createElement('tr');
    if (isExpired) tr.classList.add('expired-row');
    
    tr.innerHTML = `
      <td>#${s.id}</td>
      <td>${s.name}</td>
      <td>${ownerText}</td>
      <td>${expText}</td>
      <td style="text-align:right">
        <button class="btn btn-sm" onclick="openManageForm(${s.id})">Manage Assignment</button>
      </td>
    `;
    tbody.appendChild(tr);
  });
}

function openManageForm(id) {
  editServerId = id;
  const s = servers.find(x => x.id === id);
  if (!s) return;
  
  document.getElementById('formCardTitle').textContent = `Manage Server #${id} (${s.name})`;
  document.getElementById('editServerId').value = id;
  document.getElementById('formCard').style.display = 'block';
  
  document.getElementById('alertSuccess').classList.add('hidden');
  document.getElementById('alertError').classList.add('hidden');
  
  // Set User
  document.getElementById('userSelect').value = s.owner_id || '';
  
  // Set expiration text
  const expText = document.getElementById('currentExpirationText');
  if (s.expire_at) {
    const d = new Date(s.expire_at);
    expText.textContent = `Currently expires on: ${d.toLocaleString()}`;
  } else {
    expText.textContent = 'Currently permanent (no expiration).';
  }
  document.getElementById('validitySelect').value = 'none'; // reset to none
  
  // Set Permissions
  document.querySelectorAll('.s-perm-cb').forEach(cb => cb.checked = false);
  if (s.owner_id) {
    const u = users.find(x => x.id === s.owner_id);
    if (u && u.permissions && u.permissions.servers && u.permissions.servers[id]) {
      const sPerms = u.permissions.servers[id];
      document.querySelectorAll('.s-perm-cb').forEach(cb => {
        if (sPerms.includes(cb.value)) cb.checked = true;
      });
    }
  } else {
    // Default perms for new assignment
    const defaults = ['start', 'stop', 'restart', 'console', 'files', 'settings', 'players', 'kick', 'ban', 'coordinates', 'delete'];
    document.querySelectorAll('.s-perm-cb').forEach(cb => {
      if (defaults.includes(cb.value)) cb.checked = true;
    });
  }
}

function closeForm() {
  document.getElementById('formCard').style.display = 'none';
  editServerId = null;
}

document.getElementById('assignmentForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = document.getElementById('saveBtn');
  btn.disabled = true;
  btn.textContent = 'Saving...';
  document.getElementById('alertSuccess').classList.add('hidden');
  document.getElementById('alertError').classList.add('hidden');
  
  const serverId = document.getElementById('editServerId').value;
  const userId = document.getElementById('userSelect').value; // could be empty string
  const validityStr = document.getElementById('validitySelect').value;
  
  let expire_at = undefined;
  if (validityStr === 'permanent') {
    expire_at = null;
  } else if (validityStr !== 'none') {
    const days = parseInt(validityStr, 10);
    // If server already has expiration and it's not expired yet, we extend it?
    // Let's just set it from NOW to avoid confusion, or set it from existing?
    // Better to just set it from NOW.
    expire_at = Date.now() + (days * 24 * 60 * 60 * 1000);
  }
  
  const perms = [];
  document.querySelectorAll('.s-perm-cb').forEach(cb => {
    if (cb.checked) perms.push(cb.value);
  });
  
  try {
    const res = await fetch(`/api/rentals/${serverId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ owner_id: userId || null, expire_at, perms })
    });
    
    if (!res.ok) {
      const data = await res.json();
      throw new Error(data.error || 'Failed to update assignment');
    }
    
    document.getElementById('alertSuccess').classList.remove('hidden');
    // Reload data
    await fetchInitialData();
    // Update form if still open
    if (editServerId) openManageForm(editServerId);
  } catch (err) {
    document.getElementById('alertError').textContent = err.message;
    document.getElementById('alertError').classList.remove('hidden');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Save Assignment';
  }
});

fetchInitialData();
