'use strict';
// Auto-update: detects new DeepSeek Harness releases and applies them.
//
// Release channel facts (verified against the registry):
//  - The GitHub repo (deepseek-ai/deepseek-harness) has no GitHub Releases;
//    published artifacts land on npm as @deepseek-ai/* packages.
//  - The `latest` dist-tag is stale for the bundle packages (dsh-base /
//    dsh-web-app point at an old rc), so the checker takes the maximum
//    published semver version of each package rather than trusting a tag.
//  - The GitHub default-branch HEAD is tracked as an early-warning signal:
//    when the repo moves but npm has not published yet, we report it instead
//    of updating.
//
// Applying an update stops the backend, runs the bundled npm CLI (again under
// Electron's Node) inside the live runtime directory, then the caller restarts
// the backend. Explicit versions are installed so a bundle bump is forced even
// when the CLI's dependency range did not move.

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const semver = require('./semver-lite');
const { runtimeDir, npmCliPath, installedVersion, dshHomeDir } = require('./paths');
const settings = require('./settings');
const log = require('./log');

const REGISTRY = 'https://registry.npmjs.org';
const GITHUB_REPO = 'deepseek-ai/deepseek-harness';
const GITHUB_API = 'https://api.github.com/repos/' + GITHUB_REPO;

// This desktop app's own repository: its GitHub Releases carry the desktop
// installers (dmg / setup.exe). checkAppRelease() surfaces a newer desktop
// release to the user (download-and-install is done manually for now).
const DESKTOP_REPO = 'werbinna-cmyk/deepseek-harness-desktop';
const DESKTOP_RELEASE_API = 'https://api.github.com/repos/' + DESKTOP_REPO + '/releases/latest';

// Packages that together define a release of the harness web surface. The CLI
// declares the bundles as its own dependencies, so installing explicit
// versions keeps all three in step.
const TRACKED_PACKAGES = ['dsh', 'dsh-base', 'dsh-web-app'];

const FETCH_TIMEOUT_MS = 15_000;

async function fetchJson(url) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctl.signal,
      headers: { accept: 'application/json', 'user-agent': 'deepseek-harness-desktop' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

/** Maximum published semver of a package, or null when unreachable/empty. */
async function registryMaxVersion(pkg) {
  const doc = await fetchJson(`${REGISTRY}/@deepseek-ai%2F${pkg}`);
  const versions = Object.keys(doc.versions || {}).filter((v) => semver.valid(v));
  if (versions.length === 0) return null;
  return versions.sort(semver.compare)[versions.length - 1];
}

/** HEAD sha of the GitHub default branch, or null on failure. */
async function githubHeadSha() {
  try {
    const doc = await fetchJson(`${GITHUB_API}/commits/master`);
    return doc && doc.sha ? doc.sha : null;
  } catch (err) {
    log.warn(`github head check failed: ${err.message}`);
    return null;
  }
}

/**
 * Check this desktop app's own GitHub Releases for a newer build.
 * @param {string} currentVersion the running app version (e.g. "1.0.0").
 * @returns {Promise<{available: boolean, tag?: string, name?: string, url?: string, assetUrl?: string|null}>}
 *          assetUrl is the installer for the current platform when the release
 *          ships one (macOS: .dmg, Windows: *-setup.exe).
 */
async function checkAppRelease(currentVersion) {
  const result = { available: false };
  try {
    const doc = await fetchJson(DESKTOP_RELEASE_API);
    const tag = typeof doc.tag_name === 'string' ? doc.tag_name : null;
    if (!tag) return result;
    const ver = tag.replace(/^v/i, '');
    if (!semver.valid(ver) || !semver.gt(ver, currentVersion)) return result;

    const isWin = process.platform === 'win32';
    const assets = Array.isArray(doc.assets) ? doc.assets : [];
    const match = isWin
      ? assets.find((a) => /-setup\.exe$/i.test(a.name)) || assets.find((a) => /\.exe$/i.test(a.name))
      : assets.find((a) => /\.dmg$/i.test(a.name)) || assets.find((a) => /\.zip$/i.test(a.name));
    result.available = true;
    result.tag = tag;
    result.name = doc.name || tag;
    result.url = doc.html_url || `https://github.com/${DESKTOP_REPO}/releases/tag/${tag}`;
    result.assetUrl = match && typeof match.browser_download_url === 'string' ? match.browser_download_url : null;
  } catch (err) {
    log.warn(`desktop release check failed: ${err.message}`);
  }
  return result;
}

/**
 * Check for updates without applying anything.
 * @returns {Promise<{available: boolean, pkgs: Array, github: object, error?: string}>}
 */
async function checkForUpdates() {
  const s = settings.read();
  const live = runtimeDir();
  const result = { available: false, pkgs: [], github: { headSha: null, newCommits: false } };

  try {
    const latestMap = {};
    await Promise.all(
      TRACKED_PACKAGES.map(async (pkg) => {
        try {
          latestMap[pkg] = await registryMaxVersion(pkg);
        } catch (err) {
          log.warn(`registry check failed for ${pkg}: ${err.message}`);
        }
      }),
    );

    for (const pkg of TRACKED_PACKAGES) {
      const to = latestMap[pkg];
      if (!to) continue;
      const from = installedVersion(live, pkg);
      if (from === null || semver.gt(to, from)) {
        result.pkgs.push({ name: pkg, from, to });
      }
    }
    result.available = result.pkgs.length > 0;
  } catch (err) {
    result.error = err.message;
    log.warn(`update check failed: ${err.message}`);
  }

  // GitHub early-warning signal.
  try {
    const head = await githubHeadSha();
    if (head) {
      result.github.headSha = head;
      if (s.lastGithubHeadSha && head !== s.lastGithubHeadSha) {
        result.github.newCommits = true;
        log.log('github HEAD moved without a publishable npm bump yet');
      }
      if (head !== s.lastGithubHeadSha) {
        settings.write({ lastGithubHeadSha: head });
      }
    }
  } catch (err) {
    log.warn(`github head tracking failed: ${err.message}`);
  }

  settings.write({ lastUpdateCheckAt: new Date().toISOString() });
  return result;
}

/**
 * Apply an update: run `npm install <explicit versions>` in the live runtime.
 * The backend must be stopped before calling and restarted after.
 * @param {{pkgs: Array<{name:string,to:string}>}} update result of checkForUpdates.
 * @returns {Promise<{ok: boolean, code: number|null, error?: string}>}
 */
function applyUpdate(update) {
  return new Promise((resolve) => {
    const live = runtimeDir();
    const npmCli = npmCliPath(live);
    if (!fs.existsSync(npmCli)) {
      resolve({ ok: false, code: null, error: `bundled npm missing at ${npmCli}` });
      return;
    }

    const specs = update.pkgs.map((p) => `@deepseek-ai/${p.name}@${p.to}`);
    log.log(`applying update: npm install ${specs.join(' ')}`);

    const env = {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      DSH_HOME: dshHomeDir(),
      npm_config_loglevel: 'warn',
      // Dedicated cache: the system ~/.npm may be unwritable (e.g. root-owned
      // leftovers from an old npm bug), which would fail every update.
      npm_config_cache: path.join(live, '.npm-cache'),
    };
    const child = spawn(process.execPath, [npmCli, 'install', '--omit=dev', '--no-audit', '--no-fund', ...specs], {
      env,
      cwd: live,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let out = '';
    const collect = (c) => {
      out += c.toString();
      log.log('[npm] ' + c.toString().trim());
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);

    child.on('error', (err) => resolve({ ok: false, code: null, error: err.message }));
    child.on('exit', (code) => {
      if (code === 0) {
        log.log('update applied successfully');
        resolve({ ok: true, code });
      } else {
        log.error(`update failed (exit ${code}):\n${out.slice(-2000)}`);
        resolve({ ok: false, code, error: out.slice(-2000) });
      }
    });
  });
}

module.exports = { checkForUpdates, checkAppRelease, applyUpdate, TRACKED_PACKAGES, REGISTRY, GITHUB_REPO, DESKTOP_REPO };
