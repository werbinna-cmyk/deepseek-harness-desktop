'use strict';
// Thin git wrapper for the online-workspace plugin. Uses the system `git`
// binary (macOS ships it; Windows requires Git for Windows). Auth rides the
// token embedded in the remote URL, so no credential prompts: GIT_TERMINAL_PROMPT
// is disabled and any auth failure surfaces as an error instead of a hang.

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const IGNORE = ['node_modules/', 'runtime/', 'dist/', 'logs/', '.DS_Store', '.git/', '.npm-cache/', '.electron-cache/', '*.log'];

function git(cwd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'echo' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (c) => (out += c.toString()));
    child.stderr.on('data', (c) => (err += c.toString()));
    child.on('error', (e) => reject(e));
    child.on('exit', (code) => {
      if (code === 0) resolve(out);
      else reject(new Error((err.trim() || out.trim() || `git exited ${code}`).slice(0, 500)));
    });
  });
}

/** mkdir + git init + local identity + .gitignore + initial commit (if empty). */
async function ensureRepo(dir, displayName) {
  fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(path.join(dir, '.git'))) {
    await git(dir, ['init', '-q', '-b', 'main']);
    await git(dir, ['config', 'user.name', 'DSH Online Workspace']);
    await git(dir, ['config', 'user.email', 'sync@dsh.desktop']);
    const ignorePath = path.join(dir, '.gitignore');
    if (!fs.existsSync(ignorePath)) fs.writeFileSync(ignorePath, IGNORE.join('\n') + '\n');
    await git(dir, ['add', '-A']);
    const st = await git(dir, ['status', '--porcelain']);
    if (st.trim()) await git(dir, ['commit', '-q', '-m', 'init']);
  } else {
    const ignorePath = path.join(dir, '.gitignore');
    if (!fs.existsSync(ignorePath)) fs.writeFileSync(ignorePath, IGNORE.join('\n') + '\n');
  }
  return dir;
}

async function setRemote(dir, url) {
  try {
    await git(dir, ['remote', 'add', 'origin', url]);
  } catch {
    await git(dir, ['remote', 'set-url', 'origin', url]);
  }
}

async function remoteUrl(dir) {
  try {
    return (await git(dir, ['remote', 'get-url', 'origin'])).trim();
  } catch {
    return null;
  }
}

async function currentBranch(dir) {
  try {
    return (await git(dir, ['branch', '--show-current'])).trim() || 'main';
  } catch {
    return 'main';
  }
}

async function pull(dir, branch) {
  try {
    await git(dir, ['pull', '-q', 'origin', branch, '--no-rebase']);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/** Stage everything, commit if there are changes, push. */
async function commitAndPush(dir, branch, message) {
  await git(dir, ['add', '-A']);
  const st = await git(dir, ['status', '--porcelain']);
  const changed = st.trim().split('\n').filter(Boolean);
  if (changed.length > 0) {
    await git(dir, ['commit', '-q', '-m', message]);
  }
  await git(dir, ['push', '-q', 'origin', branch]);
  return { pushed: changed.length > 0, changedCount: changed.length };
}

async function status(dir) {
  try {
    const st = await git(dir, ['status', '--porcelain']);
    const changed = st.trim().split('\n').filter(Boolean).length;
    let lastCommit = null;
    try {
      lastCommit = (await git(dir, ['log', '-1', '--format=%h %cI'])).trim();
    } catch {
      lastCommit = null;
    }
    return { changed, lastCommit, remote: await remoteUrl(dir), branch: await currentBranch(dir) };
  } catch (err) {
    return { error: err.message };
  }
}

module.exports = { ensureRepo, setRemote, remoteUrl, currentBranch, pull, commitAndPush, status };
