'use strict';

let currentFilePath = '';
let currentEditFile = '';
let selectedFiles = [];

window.addEventListener('click', (e) => {
  if (!e.target.matches('.dropbtn')) {
    document.querySelectorAll('.dropdown-content').forEach(d => d.parentElement.classList.remove('show'));
  }
});

// Check access
const canAccessFiles = () => {
  if (currentUser?.isAdmin) return true;
  const p = currentUser?.permissions;
  if (!p) return false;
  if (Array.isArray(p)) return p.includes('files');
  return (p.global && p.global.includes('files')) || (p.servers && p.servers[serverId] && p.servers[serverId].includes('files'));
};

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
  } else if (tab === 'plugins' && typeof initPlugins === 'function') {
    initPlugins();
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
    if (res.status === 401) { location.href = '/login'; return; }
    if (!res.ok) {
      const ct = res.headers.get('content-type') || '';
      let msg = 'Failed to load files';
      if (ct.includes('json')) { const d = await res.json(); msg = d.error || msg; }
      throw new Error(msg);
    }
    const files = await res.json();

    document.getElementById('currentPath').textContent = '/' + currentFilePath;

    selectedFiles = [];
    updateBulkActionsBar();
    const selectAllCb = document.getElementById('selectAllFiles');
    if (selectAllCb) selectAllCb.checked = false;

    if (files.length === 0) {
      tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;padding:24px;color:var(--text-muted)">Directory is empty.</td></tr>';
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
        <td style="text-align:center;">
          <input type="checkbox" class="file-checkbox" value="${esc(f.name)}" onchange="toggleFileSelection(this.value, this.checked)">
        </td>
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
    tbody.innerHTML = `<tr><td colspan="5" style="text-align:center;padding:24px;color:var(--red)">${e.message}</td></tr>`;
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
    updateEditorLineNumbers();
    setTimeout(() => {
      document.getElementById('editorContent').scrollTop = 0;
      syncEditorScroll();
    }, 10);
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
  updateEditorLineNumbers();
}

function closeEditor() {
  document.getElementById('editorModal').style.display = 'none';
  currentEditFile = '';
  closeEditorSearch();
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

function toggleFileSelection(filename, checked) {
  if (checked) {
    if (!selectedFiles.includes(filename)) selectedFiles.push(filename);
  } else {
    selectedFiles = selectedFiles.filter(f => f !== filename);
  }
  updateBulkActionsBar();
}

function toggleSelectAllFiles(checked) {
  const checkboxes = document.querySelectorAll('.file-checkbox');
  selectedFiles = [];
  checkboxes.forEach(cb => {
    cb.checked = checked;
    if (checked) selectedFiles.push(cb.value);
  });
  updateBulkActionsBar();
}

function updateBulkActionsBar() {
  const bar = document.getElementById('bulkActionsBar');
  const countSpan = document.getElementById('bulkSelectedCount');
  if (!bar || !countSpan) return;
  
  if (selectedFiles.length > 0) {
    countSpan.textContent = `${selectedFiles.length} file(s) selected`;
    bar.classList.remove('hidden');
  } else {
    bar.classList.add('hidden');
  }
}

async function bulkDelete() {
  if (selectedFiles.length === 0) return;
  if (!confirm(`Are you sure you want to delete ${selectedFiles.length} item(s)? This cannot be undone.`)) return;
  
  const paths = selectedFiles.map(f => currentFilePath ? `${currentFilePath}/${f}` : f);
  try {
    const res = await fetch(`/api/servers/${serverId}/files`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths })
    });
    const d = await res.json();
    if (!res.ok) throw new Error(d.error);
    selectedFiles = [];
    loadFiles();
  } catch (e) { alert('Delete failed: ' + e.message); }
}

async function bulkMove() {
  if (selectedFiles.length === 0) return;
  const newDir = prompt(`Enter destination directory for ${selectedFiles.length} item(s) (e.g. plugins or /):`, currentFilePath);
  if (newDir === null) return;
  
  const destDir = newDir === '/' ? '' : newDir.replace(/^\/+|\/+$/g, '');
  const paths = selectedFiles.map(f => currentFilePath ? `${currentFilePath}/${f}` : f);
  
  try {
    const res = await fetch(`/api/servers/${serverId}/files/move`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths, newDir: destDir })
    });
    const d = await res.json();
    if (!res.ok) throw new Error(d.error);
    selectedFiles = [];
    loadFiles();
  } catch (e) { alert('Move failed: ' + e.message); }
}

async function bulkArchive() {
  if (selectedFiles.length === 0) return;
  
  const paths = selectedFiles.map(f => currentFilePath ? `${currentFilePath}/${f}` : f);
  try {
    const res = await fetch(`/api/servers/${serverId}/files/archive`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'compress', paths })
    });
    const d = await res.json();
    if (!res.ok) throw new Error(d.error);
    selectedFiles = [];
    loadFiles();
    alert(`Archived successfully to ${d.archive}`);
  } catch (e) { alert('Archive failed: ' + e.message); }
}

// ── Enhanced Editor Logic ──

function updateEditorLineNumbers() {
  const content = document.getElementById('editorContent').value;
  // +1 line if content is empty or doesn't end in newline, to always match textarea lines
  const linesCount = content.split('\n').length;
  const lineNumbers = document.getElementById('editorLineNumbers');
  
  if (lineNumbers.children.length !== linesCount) {
    let html = '';
    for (let i = 1; i <= linesCount; i++) {
      html += `<div>${i}</div>`;
    }
    lineNumbers.innerHTML = html;
  }
}

function syncEditorScroll() {
  const textarea = document.getElementById('editorContent');
  const lineNumbers = document.getElementById('editorLineNumbers');
  if (lineNumbers && textarea) {
    lineNumbers.scrollTop = textarea.scrollTop;
  }
}

// Search Logic
let editorSearchMatches = [];
let editorSearchIndex = -1;

function openEditorSearch() {
  document.getElementById('editorSearchToolbar').style.display = 'flex';
  const input = document.getElementById('editorSearchInput');
  input.focus();
  input.select();
  performEditorSearch();
}

function closeEditorSearch() {
  const toolbar = document.getElementById('editorSearchToolbar');
  if (toolbar) toolbar.style.display = 'none';
  const textarea = document.getElementById('editorContent');
  if (textarea) textarea.focus();
  editorSearchMatches = [];
  editorSearchIndex = -1;
  const countSpan = document.getElementById('editorSearchCount');
  if (countSpan) countSpan.textContent = '0/0';
}

function performEditorSearch() {
  const input = document.getElementById('editorSearchInput');
  const textarea = document.getElementById('editorContent');
  const countLabel = document.getElementById('editorSearchCount');
  
  if (!input || !textarea || !countLabel) return;
  
  const query = input.value.toLowerCase();
  const content = textarea.value;
  
  editorSearchMatches = [];
  editorSearchIndex = -1;
  
  if (!query) {
    countLabel.textContent = '0/0';
    return;
  }
  
  const lowerContent = content.toLowerCase();
  let pos = 0;
  while (true) {
    const idx = lowerContent.indexOf(query, pos);
    if (idx === -1) break;
    editorSearchMatches.push({ start: idx, end: idx + query.length });
    pos = idx + query.length;
  }
  
  if (editorSearchMatches.length > 0) {
    editorSearchIndex = 0;
    highlightCurrentMatch();
  } else {
    countLabel.textContent = '0/0';
  }
}

function highlightCurrentMatch() {
  if (editorSearchIndex < 0 || editorSearchIndex >= editorSearchMatches.length) return;
  const match = editorSearchMatches[editorSearchIndex];
  const textarea = document.getElementById('editorContent');
  
  textarea.focus();
  textarea.setSelectionRange(match.start, match.end);
  
  // Calculate vertical scroll offset (assuming 21px line height)
  const textBefore = textarea.value.substring(0, match.start);
  const lineIndex = textBefore.split('\n').length - 1;
  const lineHeight = 21;
  const targetScrollTop = lineIndex * lineHeight - (textarea.clientHeight / 2) + lineHeight;
  
  textarea.scrollTop = Math.max(0, targetScrollTop);
  syncEditorScroll();
  
  document.getElementById('editorSearchCount').textContent = `${editorSearchIndex + 1}/${editorSearchMatches.length}`;
}

function editorSearchNext() {
  if (editorSearchMatches.length === 0) return;
  editorSearchIndex = (editorSearchIndex + 1) % editorSearchMatches.length;
  highlightCurrentMatch();
}

function editorSearchPrev() {
  if (editorSearchMatches.length === 0) return;
  editorSearchIndex = (editorSearchIndex - 1 + editorSearchMatches.length) % editorSearchMatches.length;
  highlightCurrentMatch();
}
