'use strict';

const fs   = require('fs');
const path = require('path');

// ── Read /proc/<pid>/status → VmRSS (resident RAM in KB) ─────────────────────
function getRamKb(pid) {
  try {
    const content = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
    const match   = content.match(/^VmRSS:\s+(\d+)\s+kB/m);
    return match ? parseInt(match[1], 10) : 0;
  } catch {
    return 0;
  }
}

// ── Read /proc/<pid>/stat → calculate CPU % ───────────────────────────────────
// We store the previous reading and compare jiffies delta
const _prevCpu = new Map(); // pid → { utime, stime, ts }

function getCpuPct(pid) {
  try {
    const stat     = fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(' ');
    const utime    = parseInt(stat[13], 10);
    const stime    = parseInt(stat[14], 10);
    const total    = utime + stime;
    const now      = Date.now();

    const prev = _prevCpu.get(pid);
    _prevCpu.set(pid, { total, ts: now });

    if (!prev) return 0;

    const dtMs     = now - prev.ts;
    const dtJiffy  = total - prev.total;
    // Jiffies per second = 100 (CLK_TCK on Linux)
    const pct      = ((dtJiffy / 100) / (dtMs / 1000)) * 100;
    return Math.min(Math.round(pct * 10) / 10, 100 * require('os').cpus().length);
  } catch {
    return 0;
  }
}

// ── Single snapshot (called by WS metrics handler) ───────────────────────────
function getMetrics(pid) {
  const ramKb  = getRamKb(pid);
  const cpuPct = getCpuPct(pid);
  return {
    pid,
    ram_mb:  Math.round(ramKb / 1024),
    ram_kb:  ramKb,
    cpu_pct: cpuPct,
    ts:      Date.now(),
  };
}

// ── Cleanup CPU state when process dies ──────────────────────────────────────
function clearPidState(pid) {
  _prevCpu.delete(pid);
}

module.exports = { getMetrics, clearPidState };
