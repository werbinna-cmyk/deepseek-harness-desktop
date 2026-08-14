// Build-time step: create the bundled runtime snapshot at <repo>/runtime.
//
// The runtime is a self-contained node_modules tree holding the dsh CLI (which
// declares @deepseek-ai/dsh-base and @deepseek-ai/dsh-web-app as its own
// dependencies, so it IS the web runtime) plus the standalone npm CLI used by
// the auto-updater. Versions are pinned to the maximum published semver of
// each package — the `latest` dist-tag of the bundle packages is stale, so a
// plain `npm i @deepseek-ai/dsh` would resolve the wrong bundles.
//
// Usage: node scripts/prepare-runtime.mjs

import { spawnSync } from 'node:child_process';
import { writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RUNTIME_DIR = join(ROOT, 'runtime');
const NPM_CACHE = join(ROOT, '.npm-cache');
const REGISTRY = 'https://registry.npmjs.org';
const PKGS = ['dsh', 'dsh-base', 'dsh-web-app'];
const FALLBACK = { dsh: '0.1.0-rc.6', 'dsh-base': '0.1.0-rc.6', 'dsh-web-app': '0.1.0-rc.6' };

// Prefer the app's semver package; fall back to a small correct comparator.
let semver = null;
try {
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  semver = require('semver');
} catch {
  /* fallback below */
}
function isHigher(a, b) {
  if (semver) return semver.gt(a, b);
  const pa = a.split('-')[0].split('.').map(Number);
  const pb = b.split('-')[0].split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] > pb[i];
  }
  const ra = a.split('-')[1] || '';
  const rb = b.split('-')[1] || '';
  if (!ra) return false; // release cannot be higher than itself
  if (!rb) return true; // a prerelease is lower than a release of the same core
  const na = ra.split('.').map((s) => (Number.isNaN(Number(s)) ? s : Number(s)));
  const nb = rb.split('.').map((s) => (Number.isNaN(Number(s)) ? s : Number(s)));
  for (let i = 0; i < Math.max(na.length, nb.length); i++) {
    const x = na[i] ?? -1;
    const y = nb[i] ?? -1;
    if (typeof x === 'number' && typeof y === 'number') {
      if (x !== y) return x > y;
    } else if (String(x) !== String(y)) {
      return String(x) > String(y);
    }
  }
  return false;
}

async function fetchJson(url, timeoutMs = 15000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctl.signal, headers: { 'user-agent': 'dsh-desktop-build' } });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

function maxVersion(versions) {
  let best = null;
  for (const v of versions) {
    if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(v)) continue;
    if (best === null || isHigher(v, best)) best = v;
  }
  return best;
}

async function resolveVersions() {
  const versions = {};
  for (const pkg of PKGS) {
    try {
      const doc = await fetchJson(`${REGISTRY}/@deepseek-ai%2F${pkg}`);
      const v = maxVersion(Object.keys(doc.versions || {}));
      versions[pkg] = v || FALLBACK[pkg];
      console.log(`  ${pkg} -> ${versions[pkg]}`);
    } catch (err) {
      console.warn(`  ${pkg}: registry unreachable (${err.message}), using fallback ${FALLBACK[pkg]}`);
      versions[pkg] = FALLBACK[pkg];
    }
  }
  return versions;
}

async function main() {
  console.log('Preparing runtime snapshot...');
  const versions = await resolveVersions();

  // npm itself: use the `latest` dist-tag (a range is fine for tooling).
  // npm itself: pin to the v11 line. npm 12 warns (and may later refuse) on
  // Node < 22.22.2, while Electron 37 ships Node 22.21.1; npm 11 supports it.
  let npmRange = '^11.0.0';

  const manifest = {
    name: 'dsh-desktop-runtime',
    private: true,
    version: '1.0.0',
    description: 'Bundled DeepSeek Harness runtime (dsh CLI + bundles + npm). Managed by DeepSeek Harness Desktop.',
    dependencies: {
      '@deepseek-ai/dsh': versions.dsh,
      '@deepseek-ai/dsh-base': versions['dsh-base'],
      '@deepseek-ai/dsh-web-app': versions['dsh-web-app'],
      npm: npmRange,
    },
  };

  mkdirSync(RUNTIME_DIR, { recursive: true });
  writeFileSync(join(RUNTIME_DIR, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');

  const lock = join(RUNTIME_DIR, 'package-lock.json');
  if (existsSync(lock)) rmSync(lock, { force: true });

  console.log(`Installing into ${RUNTIME_DIR} ...`);
  // --cache keeps the build out of a possibly root-owned ~/.npm.
  const r = spawnSync('npm', ['install', '--omit=dev', '--no-audit', '--no-fund', '--loglevel=warn', '--cache', NPM_CACHE], {
    cwd: RUNTIME_DIR,
    stdio: 'inherit',
  });
  if (r.status !== 0) {
    console.error(`npm install failed (exit ${r.status})`);
    process.exit(r.status || 1);
  }

  console.log('Runtime snapshot ready:');
  console.log(`  dsh          @${versions.dsh}`);
  console.log(`  dsh-base     @${versions['dsh-base']}`);
  console.log(`  dsh-web-app  @${versions['dsh-web-app']}`);
  console.log(`  npm          ${npmRange}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
