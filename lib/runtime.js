'use strict';
// First-run data layout: creates the data directories, seeds the live runtime
// (bundled snapshot first, npm-registry auto-install as fallback), and one-time
// migration of credentials/settings from a legacy ~/.dsh web install.

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const {
  dataDir,
  dshHomeDir,
  runtimeDir,
  logsDir,
  bundledRuntimeDir,
  dshCliPath,
} = require('./paths');
const settings = require('./settings');
const log = require('./log');

function ensureLayout() {
  for (const dir of [dataDir(), dshHomeDir(), logsDir()]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

const RUNTIME_MARKER = '.dsh-runtime-ok';
const REGISTRY = 'https://registry.npmjs.org';
const TRACKED = ['dsh', 'dsh-base', 'dsh-web-app'];

/** Maximum published version of a @deepseek-ai package (semver, tag-agnostic). */
async function registryMaxVersion(pkg) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 15000);
  try {
    const res = await fetch(`${REGISTRY}/@deepseek-ai%2F${pkg}`, {
      signal: ctl.signal,
      headers: { 'user-agent': 'deepseek-harness-desktop' },
    });
    if (!res.ok) return null;
    const doc = await res.json();
    const versions = Object.keys(doc.versions || {}).filter((v) => /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(v));
    if (!versions.length) return null;
    // semver max by core numbers, then prerelease identifiers
    versions.sort((a, b) => {
      const pa = a.split('-')[0].split('.').map(Number);
      const pb = b.split('-')[0].split('.').map(Number);
      for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
      const ra = a.split('-')[1] || '';
      const rb = b.split('-')[1] || '';
      if (!ra) return 1; // release after prerelease
      if (!rb) return -1;
      return ra < rb ? -1 : ra > rb ? 1 : 0;
    });
    return versions[versions.length - 1];
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

/**
 * Fallback install: no bundled snapshot is available, so build the runtime
 * manifest from the registry and `npm install` it into the live runtime
 * directory using the system npm (spawned with a dedicated cache). This makes
 * first launch self-sufficient: dsh is installed automatically when missing.
 * @returns {Promise<boolean>}
 */
async function installRuntimeFromRegistry() {
  const live = runtimeDir();
  log.log('bundled runtime missing; auto-installing dsh from npm registry…');
  const versions = {};
  for (const pkg of TRACKED) {
    const v = await registryMaxVersion(pkg);
    if (!v) {
      log.error(`auto-install: cannot resolve ${pkg} from registry`);
      return false;
    }
    versions[pkg] = v;
  }

  fs.rmSync(live, { recursive: true, force: true });
  fs.mkdirSync(live, { recursive: true });
  fs.writeFileSync(
    path.join(live, 'package.json'),
    JSON.stringify(
      {
        name: 'dsh-desktop-runtime',
        private: true,
        version: '1.0.0',
        dependencies: {
          '@deepseek-ai/dsh': versions.dsh,
          '@deepseek-ai/dsh-base': versions['dsh-base'],
          '@deepseek-ai/dsh-web-app': versions['dsh-web-app'],
          npm: '^11.0.0',
        },
      },
      null,
      2,
    ) + '\n',
  );

  return new Promise((resolve) => {
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const child = spawn(
      npm,
      ['install', '--omit=dev', '--no-audit', '--no-fund', '--loglevel=warn', '--cache', path.join(live, '.npm-cache')],
      { cwd: live, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env } },
    );
    let out = '';
    const collect = (c) => {
      const text = c.toString();
      out += text;
      log.log('[auto-install] ' + text.trim());
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.on('error', (err) => {
      log.error(`auto-install: cannot spawn npm (${err.message}); install Node.js or reinstall the app`);
      resolve(false);
    });
    child.on('exit', (code) => {
      if (code === 0 && fs.existsSync(dshCliPath(live))) {
        fs.writeFileSync(path.join(live, RUNTIME_MARKER), new Date().toISOString() + '\n');
        log.log(`auto-install done: dsh @${versions.dsh}`);
        resolve(true);
      } else {
        log.error(`auto-install failed (exit ${code}):\n${out.slice(-1500)}`);
        resolve(false);
      }
    });
  });
}

/**
 * Ensure the live runtime is usable. Prefers the bundled snapshot (copied once
 * into Application Support so updates have a writable home); falls back to an
 * automatic npm install when the bundle is missing.
 * @returns {Promise<boolean>}
 */
async function seedRuntime() {
  const live = runtimeDir();
  const marker = path.join(live, RUNTIME_MARKER);
  if (fs.existsSync(marker) && fs.existsSync(dshCliPath(live))) {
    return true;
  }

  const bundled = bundledRuntimeDir();
  if (!fs.existsSync(dshCliPath(bundled))) {
    log.warn(`bundled runtime missing dsh CLI at ${bundled}; trying auto-install`);
    return installRuntimeFromRegistry();
  }

  try {
    log.log(`seeding runtime: ${bundled} -> ${live}`);
    fs.rmSync(live, { recursive: true, force: true });
    fs.mkdirSync(live, { recursive: true });
    fs.cpSync(bundled, live, { recursive: true });
    fs.writeFileSync(marker, new Date().toISOString() + '\n');
    log.log('runtime seeded');
    return true;
  } catch (err) {
    log.error(`runtime seed failed: ${err.stack || err.message}; trying auto-install`);
    return installRuntimeFromRegistry();
  }
}

const LEGACY_HOME = path.join(os.homedir(), '.dsh');

/**
 * One-time import from a previous `dsh web` installation at ~/.dsh so the
 * desktop app starts with the same API keys, settings, presets and sessions
 * the user already configured for the web version. Never overwrites anything
 * that already exists in the app's own dsh-home.
 * @returns {{copied: string[], skipped: string[]}} what was imported.
 */
function migrateLegacyHome() {
  const s = settings.read();
  if (s.migratedFromLegacyHome) return { copied: [], skipped: [] };

  const target = dshHomeDir();
  const copied = [];
  const skipped = [];

  if (!fs.existsSync(LEGACY_HOME)) {
    settings.write({ migratedFromLegacyHome: true });
    return { copied, skipped };
  }

  const candidates = ['.env', 'settings.yaml', 'cordis.patch.yml', '.agent-presets', 'storages', 'profiles', 'sessions'];
  for (const name of candidates) {
    const src = path.join(LEGACY_HOME, name);
    const dst = path.join(target, name);
    if (!fs.existsSync(src)) continue;
    if (fs.existsSync(dst)) {
      skipped.push(name);
      continue;
    }
    try {
      fs.cpSync(src, dst, { recursive: true });
      copied.push(name);
    } catch (err) {
      log.warn(`legacy migration: failed to copy ${name}: ${err.message}`);
      skipped.push(name);
    }
  }

  settings.write({ migratedFromLegacyHome: true });
  log.log(`legacy home migration done. copied=[${copied.join(', ')}] skipped=[${skipped.join(', ')}]`);
  return { copied, skipped };
}

module.exports = { ensureLayout, seedRuntime, migrateLegacyHome, LEGACY_HOME };
