// Standalone validation of the updater's decision logic (registry max-version
// selection + GitHub HEAD tracking), mirroring lib/updater.js exactly.
// Run with system node:  node scripts/verify-update-logic.mjs

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const semver = require('semver');

const REGISTRY = 'https://registry.npmjs.org';
const TRACKED = ['dsh', 'dsh-base', 'dsh-web-app'];
const INSTALLED = { dsh: '0.1.0-rc.6', 'dsh-base': '0.1.0-rc.6', 'dsh-web-app': '0.1.0-rc.6' };

async function fetchJson(url) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 15000);
  try {
    const res = await fetch(url, { signal: ctl.signal, headers: { 'user-agent': 'dsh-desktop-test' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

async function registryMaxVersion(pkg) {
  const doc = await fetchJson(`${REGISTRY}/@deepseek-ai%2F${pkg}`);
  const versions = Object.keys(doc.versions || {}).filter((v) => semver.valid(v));
  if (!versions.length) return null;
  return versions.sort(semver.compare).at(-1);
}

let failed = 0;
for (const pkg of TRACKED) {
  const latest = await registryMaxVersion(pkg);
  const installed = INSTALLED[pkg];
  const available = latest !== null && semver.gt(latest, installed);
  console.log(`${pkg.padEnd(10)} installed=${installed}  registryMax=${latest}  updateAvailable=${available}`);
  // sanity: the max must be >= the known current rc.6
  if (latest && !semver.gte(latest, '0.1.0-rc.6')) {
    console.log(`  !! max ${latest} is BELOW 0.1.0-rc.6 — version picker regression`);
    failed++;
  }
}

try {
  const gh = await fetchJson('https://api.github.com/repos/deepseek-ai/deepseek-harness/commits/master');
  console.log(`github HEAD sha: ${gh.sha ? gh.sha.slice(0, 12) + '…' : '(none)'}  ${gh.sha ? 'OK' : 'FAIL'}`);
  if (!gh.sha) failed++;
} catch (err) {
  console.log(`github HEAD: FAIL (${err.message})`);
  failed++;
}

console.log(failed === 0 ? 'UPDATE_LOGIC_OK' : `UPDATE_LOGIC_FAIL (${failed} issues)`);
process.exit(failed === 0 ? 0 : 1);
