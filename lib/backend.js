'use strict';
// Backend lifecycle: spawn the dsh web backend as a child process using
// Electron's bundled Node (ELECTRON_RUN_AS_NODE), wait for the printed URL,
// retry on a busy port with an OS-assigned one, and tear it down cleanly on
// quit. Everything the child prints is appended to <data>/logs/backend.log.

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');
const { dshHomeDir, runtimeDir, dshCliPath, backendLogPath, logsDir } = require('./paths');
const log = require('./log');

const URL_LINE_RE = /dsh web:\s*(https?:\/\/127\.0\.0\.1:\d+)/;
const BIND_ERROR_RE = /EADDRINUSE|address already in use|listen EACCES/i;
const READY_POLL_MS = 250;
const READY_TIMEOUT_MS = 15_000;
const STOP_GRACE_MS = 6_000;

let child = null;
let stopping = false;
let url = null;
let attempt = 0;

/** @returns {string|null} the last known backend URL. */
function currentUrl() {
  return url;
}

/** @returns {boolean} whether the backend process is currently alive. */
function isRunning() {
  return !!child && child.exitCode === null && !child.killed;
}

/**
 * Spawn the dsh web backend.
 * @param {object} opts
 * @param {number} [opts.port] preferred port (settings.port); pass 0 for OS-assigned.
 * @param {(u: string) => void} opts.onUrl fired once the backend is reachable.
 * @param {(info: object) => void} opts.onExit fired on unexpected child exit.
 */
function start(opts = {}) {
  const { onUrl = () => {}, onExit = () => {} } = opts;
  if (isRunning()) {
    log.warn('backend start requested while already running');
    return;
  }

  const runtime = runtimeDir();
  const cli = dshCliPath(runtime);
  if (!fs.existsSync(cli)) {
    log.error(`dsh CLI not found at ${cli} (runtime not seeded?)`);
    onExit({ code: 1, signal: null, reason: 'runtime-missing' });
    return;
  }

  stopping = false;
  url = null;
  attempt += 1;
  const port = opts.port ?? 0;

  // Log file: one stream per backend instance.
  fs.mkdirSync(logsDir(), { recursive: true });
  const outStream = fs.createWriteStream(backendLogPath(), { flags: 'a' });
  const stamp = `\n=== backend start #${attempt} (${new Date().toISOString()}) port=${port} ===\n`;
  outStream.write(stamp);

  const env = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    DSH_HOME: dshHomeDir(),
    DSH_DESKTOP: '1',
  };

  log.log(`spawning backend: port=${port} dshHome=${dshHomeDir()}`);
  // ELECTRON_RUN_AS_NODE makes process.execPath behave as plain Node, so
  // argv[1] (index 0 of the args array) must be the script to run.
  const args = [cli, '--profile', 'web', '--host', '127.0.0.1', '--port', String(port)];
  child = spawn(process.execPath, args, { env, cwd: runtime, stdio: ['ignore', 'pipe', 'pipe'] });

  let stdoutBuf = '';
  let stderrBuf = '';
  let ready = false;
  let urlSeen = null;

  const handleData = (chunk, isErr) => {
    const text = chunk.toString();
    if (isErr) stderrBuf += text;
    else stdoutBuf += text;
    outStream.write(text);
    if (urlSeen === null) {
      const m = text.match(URL_LINE_RE) || stdoutBuf.match(URL_LINE_RE);
      if (m) urlSeen = m[1];
    }
  };

  child.stdout.on('data', (c) => handleData(c, false));
  child.stderr.on('data', (c) => handleData(c, true));

  const verifyReachable = async (candidateUrl, resolveReady) => {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      try {
        const ctl = new AbortController();
        const t = setTimeout(() => ctl.abort(), 3_000);
        const res = await fetch(candidateUrl, { signal: ctl.signal });
        clearTimeout(t);
        if (res.ok) {
          ready = true;
          url = candidateUrl;
          log.log(`backend ready at ${candidateUrl}`);
          resolveReady(candidateUrl);
          return;
        }
      } catch {
        /* not up yet */
      }
      await new Promise((r) => setTimeout(r, READY_POLL_MS));
    }
    log.warn(`backend not reachable at ${candidateUrl} within ${READY_TIMEOUT_MS}ms`);
  };

  const waitForUrl = () =>
    new Promise((resolve) => {
      const deadline = Date.now() + READY_TIMEOUT_MS;
      const tick = () => {
        if (urlSeen) {
          verifyReachable(urlSeen, resolve);
          return;
        }
        if (Date.now() > deadline) {
          resolve(null);
          return;
        }
        setTimeout(tick, READY_POLL_MS);
      };
      tick();
    });

  child.on('error', (err) => {
    log.error(`backend spawn error: ${err.message}`);
    outStream.end();
    onExit({ code: null, signal: null, reason: 'spawn-error', error: err.message });
  });

  child.on('exit', (code, signal) => {
    const wasStopping = stopping;
    const didReady = ready;
    log.log(`backend exited code=${code} signal=${signal} stopping=${wasStopping} ready=${didReady} urlSeen=${urlSeen}`);
    outStream.end();
    child = null;

    if (wasStopping || app.isQuitting) {
      return;
    }

    // Busy port / transient startup failure → retry once with OS-assigned port.
    if (!didReady && attempt === 1 && (code !== 0 || (stderrBuf + stdoutBuf).match(BIND_ERROR_RE))) {
      log.warn('first backend attempt failed; retrying with OS-assigned port');
      start({ onUrl, onExit });
      return;
    }

    onExit({ code, signal, reason: didReady ? 'crashed' : 'startup-failed', log: stderrBuf.slice(-2000) });
  });

  waitForUrl().then((resolvedUrl) => {
    if (resolvedUrl) onUrl(resolvedUrl);
    // if unresolved, the exit handler reports startup failure
  });
}

/**
 * Stop the backend gracefully (SIGTERM, escalate to SIGKILL after a grace
 * period). Resolves once the child has exited.
 * @returns {Promise<void>}
 */
function stop() {
  return new Promise((resolve) => {
    if (!child) {
      stopping = false;
      resolve();
      return;
    }
    stopping = true;
    const proc = child;
    const killTimer = setTimeout(() => {
      try {
        proc.kill('SIGKILL');
      } catch {
        /* already gone */
      }
    }, STOP_GRACE_MS);
    proc.once('exit', () => {
      clearTimeout(killTimer);
      child = null;
      attempt = 0; // next start gets a fresh port-fallback retry
      resolve();
    });
    try {
      proc.kill('SIGTERM');
    } catch {
      /* already gone */
    }
  });
}

/** Restart the backend. */
async function restart(opts) {
  await stop();
  start(opts);
}

module.exports = { start, stop, restart, isRunning, currentUrl };
