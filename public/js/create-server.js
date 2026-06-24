'use strict';

// ── Sidebar ───────────────────────────────────────────────────────────────────
function toggleSidebar(){const s=document.getElementById('sidebar'),o=document.getElementById('sidebarOverlay'),h=document.getElementById('hamburger'),open=s?.classList.toggle('open');o?.classList.toggle('visible',open);h?.classList.toggle('open',open);}
function closeSidebar(){document.getElementById('sidebar')?.classList.remove('open');document.getElementById('sidebarOverlay')?.classList.remove('visible');document.getElementById('hamburger')?.classList.remove('open');}
document.addEventListener('keydown',e=>{if(e.key==='Escape')closeSidebar();});

let currentMode = 'basic';

function switchTab(mode) {
  currentMode = mode;
  document.getElementById('tabBasic').classList.toggle('active', mode === 'basic');
  document.getElementById('tabAdv').classList.toggle('active',   mode === 'advanced');
  document.getElementById('tabBasicBtn').classList.toggle('active', mode === 'basic');
  document.getElementById('tabAdvBtn').classList.toggle('active',   mode === 'advanced');
}

function showError(msg) {
  const el = document.getElementById('alert');
  document.getElementById('alertMsg').textContent = msg;
  el.classList.remove('hidden');
  el.classList.add('fade-in');
  document.getElementById('alertSuccess').classList.add('hidden');
}

function showSuccess(msg) {
  const el = document.getElementById('alertSuccess');
  document.getElementById('alertSuccessMsg').textContent = msg;
  el.classList.remove('hidden');
  document.getElementById('alert').classList.add('hidden');
}

document.getElementById('createForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  document.getElementById('alert').classList.add('hidden');
  document.getElementById('alertSuccess').classList.add('hidden');

  const btn = document.getElementById('createBtn');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Creating...';

  if (currentMode === 'basic') {
    await createBasic();
  } else {
    await createAdvanced();
  }

  btn.disabled = false;
  btn.innerHTML = '🚀 Create Server';
});

// ── Basic: SSE progress stream ────────────────────────────────────────────────
async function createBasic() {
  const name = document.getElementById('basicName').value.trim();
  if (!name) { showError('Server name is required.'); return; }

  const progressBox = document.getElementById('downloadProgress');
  const progressLog = document.getElementById('progressLog');
  progressBox.classList.remove('hidden');
  progressLog.innerHTML = '';

  const addLine = (text) => {
    const div = document.createElement('div');
    div.className = 'terminal-line';
    div.textContent = text;
    progressLog.appendChild(div);
    progressLog.scrollTop = progressLog.scrollHeight;
  };

  try {
    const res = await fetch('/api/servers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, mode: 'basic' }),
    });

    if (!res.ok) {
      const d = await res.json().catch(() => ({ error: 'Unknown error' }));
      showError(d.error || 'Failed to create server.'); return;
    }

    // Read SSE stream
    const reader  = res.body.getReader();
    const decoder = new TextDecoder();
    let   buffer  = '';
    let   doneId  = null;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const events = buffer.split('\n\n');
      buffer = events.pop();
      for (const event of events) {
        const line = event.replace(/^data:\s*/, '');
        if (!line) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.msg) addLine(msg.msg);
          if (msg.done) {
            doneId = msg.id;
            addLine('✓ Done!');
          }
        } catch {}
      }
    }

    if (doneId) {
      showSuccess(`Server created! Redirecting to console...`);
      setTimeout(() => { window.location.href = `/servers/${doneId}`; }, 1500);
    }
  } catch (err) {
    showError('Error: ' + err.message);
  }
}

// ── Advanced: JSON POST ───────────────────────────────────────────────────────
async function createAdvanced() {
  const name = document.getElementById('advName').value.trim();
  const jar  = document.getElementById('advJar').value.trim();
  if (!name) { showError('Server name is required.'); return; }
  if (!jar)  { showError('JAR path is required in Advanced mode.'); return; }

  let envCustom = document.getElementById('advEnvCustom').value.trim();
  try { JSON.parse(envCustom); } catch { showError('Custom env vars must be valid JSON.'); return; }

  try {
    const res = await fetch('/api/servers', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name,
        mode:       'advanced',
        port:        document.getElementById('advPort').value     || undefined,
        memory_min:  document.getElementById('advMemMin').value  || 512,
        memory_max:  document.getElementById('advMemMax').value  || 2048,
        jar_path:    jar,
        jvm_flags:   document.getElementById('advJvmFlags').value.trim(),
        env_tz:      document.getElementById('advTz').value.trim() || 'Asia/Kolkata',
        env_custom:  envCustom,
      }),
    });
    const data = await res.json();
    if (!res.ok) { showError(data.error); return; }
    showSuccess(`Server "${name}" created! Redirecting...`);
    setTimeout(() => { window.location.href = `/servers/${data.id}`; }, 1200);
  } catch (err) {
    showError('Error: ' + err.message);
  }
}
