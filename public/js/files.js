'use strict';

let currentFilePath = '';
let currentEditFile = '';

// Check access
const canAccessFiles = () => currentUser?.isAdmin || currentUser?.permissions?.includes('files');

function switchServerTab(tab) {
  document.getElementById('tabConsole').classList.toggle('hidden', tab !== 'console');
  document.getElementById('tabFiles').classList.toggle('hidden', tab !== 'files');
  
  document.getElementById('tabBtnConsole').classList.toggle('active', tab === 'console');
  document.getElementById('tabBtnConsole').classList.toggle('btn-primary', tab === 'console');
  document.getElementById('tabBtnConsole').classList.toggle('btn-secondary', tab !== 'console');
  
  document.getElementById('tabBtnFiles').classList.toggle('active', tab === 'files');
  document.getElementById('tabBtnFiles').classList.toggle('btn-primary', tab === 'files');
  document.getElementById('tabBtnFiles').classList.toggle('btn-secondary', tab !== 'files');

  if (tab === 'files') {
    if (!canAccessFiles()) {
      document.getElementById('filesList').innerHTML = '<tr><td colspan="4" style="text-align:center;padding:32px;color:var(--text-muted)"><div style="font-size:32px;margin-bottom:12px">🔒</div><div style="font-weight:600;color:var(--text-secondary)">Files access restricted</div></td></tr>';
    } else {
      loadFiles();
    }
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
      
      let actionButtons = '';
      if (!f.isDir) {
        actionButtons += `<button class="btn btn-sm btn-ghost" onclick="downloadFile('${f.name}')" title="Download">📥</button> `;
        actionButtons += `<button class="btn btn-sm btn-ghost" onclick="editFile('${f.name}')" title="Edit">✏️</button> `;
      }
      
      if (f.name.endsWith('.tar.gz') || f.name.endsWith('.zip') || f.name.endsWith('.tgz')) {
        actionButtons += `<button class="btn btn-sm btn-ghost" onclick="archiveAction('decompress', '${f.name}')" title="Unarchive">🔓</button> `;
      } else {
        actionButtons += `<button class="btn btn-sm btn-ghost" onclick="archiveAction('compress', '${f.name}')" title="Archive">🔒</button> `;
      }

      actionButtons += `<button class="btn btn-sm btn-ghost" style="color:var(--red);" onclick="deleteFile('${f.name}')" title="Delete">🗑</button>`;

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
