'use strict';

let currentFilePath = '';
let currentEditFile = '';

window.addEventListener('click', (e) => {
  if (!e.target.matches('.dropbtn')) {
    document.querySelectorAll('.dropdown-content').forEach(d => d.parentElement.classList.remove('show'));
  }
});

// Check access
const canAccessFiles = () => currentUser?.isAdmin || currentUser?.permissions?.includes('files');

function switchServerTab(tab) {
  // Hide all tabs
  document.querySelectorAll('.server-tab').forEach(el => el.classList.add('hidden'));
  // Show target
  const target = document.getElementById('tab' + tab.charAt(0).toUpperCase() + tab.slice(1));
  if (target) target.classList.remove('hidden');

  // Update all buttons
  const allBtns = ['Console', 'Files', 'Plugins', 'Playit', 'Players', 'Settings'];
  allBtns.forEach(name => {
    const btn = document.getElementById('tabBtn' + name);
    if (btn) {
      const isActive = tab === name.toLowerCase();
      btn.classList.toggle('active', isActive);
      btn.classList.toggle('btn-primary', isActive);
      btn.classList.toggle('btn-secondary', !isActive);
    }
  });

  if (tab === 'files') {
    if (!canAccessFiles()) {
      document.getElementById('filesList').innerHTML = '<tr><td colspan="4" style="text-align:center;padding:32px;color:var(--text-muted)"><div style="font-size:32px;margin-bottom:12px">🔒</div><div style="font-weight:600;color:var(--text-secondary)">Files access restricted</div></td></tr>';
    } else {
      loadFiles();
    }
  } else if (tab === 'plugins' && typeof loadPlugins === 'function') {
    loadPlugins();
  } else if (tab === 'playit' && typeof loadPlayitStatus === 'function') {
    loadPlayitStatus();
  } else if (tab === 'players' && typeof loadOnlinePlayers === 'function') {
    loadOnlinePlayers();
    if (typeof loadPlayerLists === 'function') loadPlayerLists();
  }
}

async function loadFiles() {
  if (!canAccessFiles()) return;
  const tbody = document.getElementById('filesList');
  tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;padding:24px;">Loading...</td></tr>';
  
  try {
    const res = await fetch(`/api/servers/${serverId}/files?path=${encodeURIComponent(currentFilePath)}`);
    const files = await res.json();
    if (!res.ok) throw new Error(files.error || 'Failed to load files');

    document.getElementById('currentPath').textContent = '/' + currentFilePath;

    if (files.length === 0) {
      tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;padding:24px;color:var(--text-muted)">Directory is empty.</td></tr>';
      return;
    }

    let html = '';
    for (const f of files) {
      const icon = f.isDir ? '📁' : '📄';
      let sizeStr = '';
      if (f.size > 1024 * 1024 * 1024) sizeStr = (f.size / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
      else if (f.size > 1024 * 1024) sizeStr = (f.size / (1024 * 1024)).toFixed(1) + ' MB';
      else sizeStr = (f.size / 1024).toFixed(1) + ' KB';
      
      let actionButtons = `
        <div class="dropdown">
          <button class="btn btn-sm btn-secondary dropbtn" onclick="this.parentElement.classList.toggle('show')" title="Actions">⋮</button>
          <div class="dropdown-content">
      `;
      
      if (!f.isDir) {
        actionButtons += `<button onclick="downloadFile('${f.name}')">📥 Download</button>`;
        actionButtons += `<button onclick="editFile('${f.name}')">✏️ Edit</button>`;
      }
      
      if (f.name.endsWith('.tar.gz') || f.name.endsWith('.zip') || f.name.endsWith('.tgz')) {
        actionButtons += `<button onclick="archiveAction('decompress', '${f.name}')">🔓 Unarchive</button>`;
      } else {
        actionButtons += `<button onclick="archiveAction('compress', '${f.name}')">🔒 Archive</button>`;
      }

      actionButtons += `<button onclick="renameFile('${f.name}')">📝 Rename</button>`;
      actionButtons += `<button onclick="moveFile('${f.name}')">✂️ Move</button>`;
      actionButtons += `<button style="color:var(--red);" onclick="deleteFile('${f.name}')">🗑 Delete</button>`;
      
      actionButtons += `</div></div>`;

      html += `<tr>
        <td>
          <span style="margin-right:8px">${icon}</span>
          ${f.isDir 
            ? `<a href="#" onclick="navDir('${f.name}')" style="color:var(--accent);text-decoration:none;font-weight:600">${esc(f.name)}</a>`
            : `<a href="#" onclick="editFile('${f.name}')" style="color:var(--text-primary);text-decoration:none">${esc(f.name)}</a>`
          }
        </td>
        <td class="text-muted text-sm">${sizeStr}</td>
        <td class="text-muted text-sm">${new Date(f.modified).toLocaleString()}</td>
        <td style="text-align:right">
          ${actionButtons}
        </td>
      </tr>`;
    }
    tbody.innerHTML = html;
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="4" style="text-align:center;padding:24px;color:var(--red)">${e.message}</td></tr>`;
  }
}

function navDir(dir) {
  if (dir === '..') {
    const parts = currentFilePath.split('/').filter(Boolean);
    parts.pop();
    currentFilePath = parts.join('/');
  } else {
    currentFilePath = currentFilePath ? currentFilePath + '/' + dir : dir;
  }
  loadFiles();
}

async function editFile(filename) {
  const path = currentFilePath ? currentFilePath + '/' + filename : filename;
  try {
    const res = await fetch(`/api/servers/${serverId}/files/content?path=${encodeURIComponent(path)}`);
    if (!res.ok) {
      const d = await res.json();
      throw new Error(d.error || 'Cannot read file');
    }
    const text = await res.text();
    currentEditFile = path;
    document.getElementById('editorTitle').textContent = `Editing: /${path}`;
    document.getElementById('editorContent').value = text;
    document.getElementById('editorModal').style.display = 'flex';
  } catch (e) { alert(e.message); }
}

function newFile() {
  const name = prompt('Enter new file name (e.g. server.properties):');
  if (!name) return;
  const path = currentFilePath ? currentFilePath + '/' + name : name;
  currentEditFile = path;
  document.getElementById('editorTitle').textContent = `New File: /${path}`;
  document.getElementById('editorContent').value = '';
  document.getElementById('editorModal').style.display = 'flex';
}

function closeEditor() {
  document.getElementById('editorModal').style.display = 'none';
  currentEditFile = '';
}

async function saveFile() {
  const text = document.getElementById('editorContent').value;
  try {
    const res = await fetch(`/api/servers/${serverId}/files/content?path=${encodeURIComponent(currentEditFile)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'text/plain' },
      body: text
    });
    const d = await res.json();
    if (!res.ok) throw new Error(d.error || 'Failed to save');
    closeEditor();
    loadFiles();
  } catch (e) { alert('Save error: ' + e.message); }
}

async function deleteFile(filename) {
  if (!confirm(`Delete ${filename}? This cannot be undone.`)) return;
  const path = currentFilePath ? currentFilePath + '/' + filename : filename;
  try {
    const res = await fetch(`/api/servers/${serverId}/files?path=${encodeURIComponent(path)}`, { method: 'DELETE' });
    const d = await res.json();
    if (!res.ok) throw new Error(d.error || 'Failed to delete');
    loadFiles();
  } catch (e) { alert(e.message); }
}

function downloadFile(filename) {
  const path = currentFilePath ? currentFilePath + '/' + filename : filename;
  window.open(`/api/servers/${serverId}/files/download?path=${encodeURIComponent(path)}`, '_blank');
}

async function archiveAction(action, filename) {
  const path = currentFilePath ? currentFilePath + '/' + filename : filename;
  const alertE = document.getElementById('alert');
  const alertS = document.getElementById('alertSuccess');
  alertE.classList.add('hidden');
  alertS.classList.remove('hidden');
  alertS.querySelector('#alertSuccessMsg').textContent = action === 'compress' ? 'Archiving...' : 'Unarchiving...';

  try {
    const res = await fetch(`/api/servers/${serverId}/files/archive`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, path })
    });
    const d = await res.json();
    if (!res.ok) throw new Error(d.error || 'Archive operation failed');
    alertS.classList.add('hidden');
    loadFiles();
  } catch (e) {
    alertS.classList.add('hidden');
    alertE.classList.remove('hidden');
    alertE.querySelector('#alertMsg').textContent = e.message;
  }
}

async function uploadFile(file) {
  if (!file) return;
  const path = currentFilePath ? currentFilePath + '/' + file.name : file.name;
  const alertE = document.getElementById('alert');
  const alertS = document.getElementById('alertSuccess');
  alertE.classList.add('hidden');
  alertS.classList.remove('hidden');
  alertS.querySelector('#alertSuccessMsg').textContent = `Uploading ${file.name}...`;

  try {
    const res = await fetch(`/api/servers/${serverId}/files/upload?path=${encodeURIComponent(path)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: file
    });
    const d = await res.json();
    if (!res.ok) throw new Error(d.error || 'Upload failed');
    alertS.querySelector('#alertSuccessMsg').textContent = `Uploaded ${file.name} successfully!`;
    document.getElementById('fileUpload').value = ''; // reset input
    loadFiles();
  } catch (e) {
    alertS.classList.add('hidden');
    alertE.classList.remove('hidden');
    alertE.querySelector('#alertMsg').textContent = e.message;
    document.getElementById('fileUpload').value = '';
  }
}

async function renameFile(oldName) {
  const newName = prompt(`Enter new name for ${oldName}:`, oldName);
  if (!newName || newName === oldName) return;
  const oldPath = currentFilePath ? currentFilePath + '/' + oldName : oldName;
  const newPath = currentFilePath ? currentFilePath + '/' + newName : newName;
  
  try {
    const res = await fetch(`/api/servers/${serverId}/files/rename`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ oldPath, newPath })
    });
    const d = await res.json();
    if (!res.ok) throw new Error(d.error || 'Failed to rename');
    loadFiles();
  } catch (e) {
    showAlert('error', e.message);
  }
}

async function moveFile(filename) {
  const destPath = prompt(`Enter destination path for ${filename} (relative to server root):`, currentFilePath);
  if (destPath === null) return;
  
  const oldPath = currentFilePath ? currentFilePath + '/' + filename : filename;
  const newPath = destPath ? destPath + '/' + filename : filename;
  
  if (oldPath === newPath) return;
  
  try {
    const res = await fetch(`/api/servers/${serverId}/files/move`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ oldPath, newPath })
    });
    const d = await res.json();
    if (!res.ok) throw new Error(d.error || 'Failed to move');
    loadFiles();
  } catch (e) {
    showAlert('error', e.message);
  }
}
