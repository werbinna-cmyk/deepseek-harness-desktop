'use strict';
// settings.json persistence for desktop-level options (backend port,
// auto-update behaviour, last update state). Corrupt or missing files fall
// back to defaults; writes are atomic-ish (tmp + rename).

const fs = require('node:fs');
const path = require('node:path');
const { settingsPath } = require('./paths');
const log = require('./log');

const DEFAULTS = {
  port: 3620, // loopback port for the dsh backend (falls back to OS-assigned)
  autoUpdate: true, // check for new releases on launch and every interval
  checkIntervalHours: 6,
  lastUpdateCheckAt: null,
  lastGithubHeadSha: null,
  migratedFromLegacyHome: false,
};

let cache = null;

function read() {
  if (cache) return cache;
  try {
    const raw = fs.readFileSync(settingsPath(), 'utf8');
    cache = { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {
    cache = { ...DEFAULTS };
  }
  return cache;
}

function write(patch) {
  const next = { ...read(), ...patch };
  cache = next;
  try {
    fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
    const tmp = settingsPath() + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n');
    fs.renameSync(tmp, settingsPath());
  } catch (err) {
    log.warn(`settings write failed: ${err.message}`);
  }
}

module.exports = { read, write, DEFAULTS };
