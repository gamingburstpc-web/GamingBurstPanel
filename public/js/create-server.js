'use strict';

// ── Sidebar ───────────────────────────────────────────────────────────────────
function toggleSidebar(){const s=document.getElementById('sidebar'),o=document.getElementById('sidebarOverlay'),h=document.getElementById('hamburger'),open=s?.classList.toggle('open');o?.classList.toggle('visible',open);h?.classList.toggle('open',open);}
function closeSidebar(){document.getElementById('sidebar')?.classList.remove('open');document.getElementById('sidebarOverlay')?.classList.remove('visible');document.getElementById('hamburger')?.classList.remove('open');}
document.addEventListener('keydown',e=>{if(e.key==='Escape')closeSidebar();});

let currentMode = 'basic';
let lastPayload = null;

function switchTab(mode) {
  currentMode = mode;
  document.getElementById('tabBasic').classList.toggle('active', mode === 'basic');
  document.getElementById('tabAdv').classList.toggle('active',   mode === 'advanced');
  document.getElementById('tabBasicBtn').classList.toggle('active', mode === 'basic');
  document.getElementById('tabAdvBtn').classList.toggle('active',   mode === 'advanced');
}

function updateSoftwareOptions(prefix) {
  const plat = document.getElementById(prefix + 'Platform').value;
  const swGroup = document.getElementById(prefix + 'SoftwareGroup');
  if (plat === 'bedrock') {
    swGroup.style.display = 'none';
  } else {
    swGroup.style.display = 'block';
  }
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

  let payload = null;

  if (currentMode === 'basic') {
    const name = document.getElementById('basicName').value.trim();
    if (!name) { showError('Server name is required.'); return; }
    payload = {
      name,
      mode: 'basic',
      platform: document.getElementById('basicPlatform').value,
      software: document.getElementById('basicSoftware').value,
      version:  document.getElementById('basicVersion').value.trim() || 'latest'
    };
  } else {
    const name = document.getElementById('advName').value.trim();
    const jar  = document.getElementById('advJar').value.trim();
    if (!name) { showError('Server name is required.'); return; }

    let envCustom = document.getElementById('advEnvCustom').value.trim();
    try { JSON.parse(envCustom); } catch { showError('Custom env vars must be valid JSON.'); return; }

    payload = {
      name,
      mode:       'advanced',
      platform:   document.getElementById('advPlatform').value,
      software:   document.getElementById('advSoftware').value,
      version:    document.getElementById('advVersion').value.trim() || 'latest',
      port:       document.getElementById('advPort').value     || undefined,
      memory_min: document.getElementById('advMemMax').value  || 2048,
      memory_max: document.getElementById('advMemMax').value  || 2048,
      jar_path:   jar || undefined,
      jvm_flags:  document.getElementById('advJvmFlags').value.trim(),
      env_tz:     document.getElementById('advTz').value.trim() || 'Asia/Kolkata',
      env_custom: envCustom,
    };
  }

  await submitServerForm(payload);
});

// ── Fallback UI Modal ─────────────────────────────────────────────────────────
function closeFallbackModal() {
  document.getElementById('fallbackModal').style.display = 'none';
  const btn = document.getElementById('createBtn');
  btn.disabled = false;
  btn.innerHTML = '🚀 Create Server';
}

function showDirectUrlInput() {
  document.getElementById('directUrlSection').classList.remove('hidden');
}

async function useLatestVersionFallback() {
  if (!lastPayload) return;
  lastPayload.version = 'latest';
  document.getElementById('fallbackModal').style.display = 'none';
  await submitServerForm(lastPayload);
}

async function submitDirectUrlFallback() {
  if (!lastPayload) return;
  const url = document.getElementById('directUrlInput').value.trim();
  if (!url) { alert('Please enter a valid URL.'); return; }
  lastPayload.download_url = url;
  document.getElementById('fallbackModal').style.display = 'none';
  await submitServerForm(lastPayload);
}

// ── Submit & SSE stream ───────────────────────────────────────────────────────
async function submitServerForm(payload) {
  lastPayload = payload;
  const btn = document.getElementById('createBtn');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Creating...';

  const progressBox = document.getElementById('downloadProgress');
  const progressLog = document.getElementById('progressLog');
  progressBox.classList.remove('hidden');
  progressLog.innerHTML = '';

  // Show it in the UI depending on tab
  if (currentMode === 'advanced') {
    // Move the progress box to the advanced tab temporarily or just ensure it's visible.
    // For simplicity, we just inject it into the advanced card if it's not there.
    const advCard = document.querySelector('#tabAdv .card');
    if (advCard && !advCard.contains(progressBox)) advCard.appendChild(progressBox);
  } else {
    const basicCard = document.querySelector('#tabBasic .card');
    if (basicCard && !basicCard.contains(progressBox)) basicCard.appendChild(progressBox);
  }

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
      body: JSON.stringify(payload),
    });

    const isJson = res.headers.get('content-type')?.includes('application/json');
    
    if (!res.ok) {
      if (isJson) {
        const d = await res.json().catch(() => ({ error: 'Unknown error' }));
        showError(d.error || 'Failed to create server.');
      } else {
        showError(`HTTP Error: ${res.status}`);
      }
      btn.disabled = false;
      btn.innerHTML = '🚀 Create Server';
      return;
    }

    if (isJson) {
      // Backend returned instant JSON (e.g., custom jar path provided)
      const data = await res.json();
      showSuccess(`Server "${payload.name}" created! Redirecting...`);
      setTimeout(() => { window.location.href = `/servers/${data.id}`; }, 1200);
      return;
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
          if (msg.action === 'PROMPT_FALLBACK') {
            document.getElementById('fallbackMessage').textContent = `Version ${msg.version} was not found on any available source.`;
            document.getElementById('fallbackModal').style.display = 'flex';
            document.getElementById('directUrlSection').classList.add('hidden');
            // Stop parsing further, wait for user input
            reader.cancel();
            return;
          }
          if (msg.error) {
            showError(msg.error);
            btn.disabled = false;
            btn.innerHTML = '🚀 Create Server';
            return;
          }
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
    btn.disabled = false;
    btn.innerHTML = '🚀 Create Server';
  }
}
