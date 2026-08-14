'use strict';
// OAuth for the online-workspace plugin.
//
// GitHub:  device flow — no client secret needed. The app opens the browser to
//          github.com/login/device, the user enters the shown code, the app
//          polls until the token is issued (scope: repo).
// Gitee:   authorization-code flow with a localhost callback. Requires a
//          user-registered Gitee OAuth app (client_id + client_secret), which
//          are stored in settings.json.
//
// Remote repo creation also lives here (both providers expose a REST API).

const http = require('node:http');
const { shell } = require('electron');

const GITHUB_DEVICE_URL = 'https://github.com/login/device/code';
const GITHUB_TOKEN_URL = 'https://github.com/login/oauth/access_token';
const GITHUB_API = 'https://api.github.com';
const GITEE_AUTHORIZE = 'https://gitee.com/oauth/authorize';
const GITEE_TOKEN = 'https://gitee.com/oauth/token';
const GITEE_API = 'https://gitee.com/api/v5';

async function postForm(url, params, headers = {}) {
  const body = new URLSearchParams(params).toString();
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 30_000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
        'user-agent': 'dsh-online-workspace',
        ...headers,
      },
      body,
      signal: ctl.signal,
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* form-encoded fallback */
    }
    if (!json) {
      const paramsOut = {};
      for (const [k, v] of new URLSearchParams(text)) paramsOut[k] = v;
      json = paramsOut;
    }
    if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}: ${JSON.stringify(json).slice(0, 300)}`);
    return json;
  } finally {
    clearTimeout(t);
  }
}

async function getJson(url, headers = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 30_000);
  try {
    const res = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'dsh-online-workspace', ...headers }, signal: ctl.signal });
    if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

async function postJson(url, payload, headers = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 30_000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json', 'user-agent': 'dsh-online-workspace', ...headers },
      body: JSON.stringify(payload),
      signal: ctl.signal,
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}: ${text.slice(0, 300)}`);
    return json;
  } finally {
    clearTimeout(t);
  }
}

/**
 * GitHub device flow.
 * @param {string} clientId GitHub OAuth app client_id (device flow needs no secret).
 * @param {(msg: string) => void} onProgress surfaced to the user (open URI, code).
 * @returns {Promise<string>} access token (scope: repo).
 */
async function githubDeviceFlow(clientId, onProgress) {
  const start = await postForm(GITHUB_DEVICE_URL, { client_id: clientId, scope: 'repo' });
  const { device_code: deviceCode, user_code: userCode, verification_uri: verifyUri, interval = 5, expires_in: expiresIn = 900 } = start;
  if (!deviceCode) throw new Error('GitHub device flow: no device_code in response');
  onProgress(`请在浏览器中打开 ${verifyUri} 并输入代码 ${userCode}`);
  shell.openExternal(verifyUri);

  const deadline = Date.now() + expiresIn * 1000;
  let waitMs = interval * 1000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, waitMs));
    let json;
    try {
      json = await postForm(GITHUB_TOKEN_URL, {
        client_id: clientId,
        device_code: deviceCode,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      });
    } catch {
      continue;
    }
    if (json.access_token) return json.access_token;
    if (json.error === 'slow_down') waitMs += 5000;
    else if (json.error === 'authorization_pending') {
      /* keep polling */
    } else if (json.error === 'expired_token' || json.error === 'access_denied') {
      throw new Error(`GitHub 授权失败：${json.error_description || json.error}`);
    }
  }
  throw new Error('GitHub 授权超时，请重试');
}

/**
 * Gitee authorization-code flow with a localhost callback server.
 * @param {string} clientId Gitee OAuth client_id.
 * @param {string} clientSecret Gitee OAuth client_secret.
 * @param {(msg: string) => void} onProgress.
 * @returns {Promise<string>} access token.
 */
async function giteeAuthCodeFlow(clientId, clientSecret, onProgress) {
  const port = await new Promise((resolve) => {
    const srv = http.createServer();
    srv.listen(0, '127.0.0.1', () => resolve(srv.address().port));
  });
  const redirectUri = `http://127.0.0.1:${port}/callback`;

  const token = await new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url, redirectUri);
      if (url.pathname !== '/callback') {
        res.writeHead(404).end();
        return;
      }
      const code = url.searchParams.get('code');
      const error = url.searchParams.get('error');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<h3>已收到授权，可以关闭此页面并返回应用。</h3>');
      server.close();
      if (error || !code) {
        reject(new Error(`Gitee 授权失败：${error || '缺少 code'}`));
        return;
      }
      try {
        const json = await postForm(GITEE_TOKEN, {
          grant_type: 'authorization_code',
          code,
          client_id: clientId,
          client_secret: clientSecret,
          redirect_uri: redirectUri,
        });
        if (!json.access_token) reject(new Error(`Gitee 换取令牌失败：${JSON.stringify(json).slice(0, 200)}`));
        else resolve(json.access_token);
      } catch (err) {
        reject(err);
      }
    });
    server.listen(port, '127.0.0.1');
    server.on('error', reject);
  });

  onProgress(`请在浏览器中完成 Gitee 登录（回调 ${redirectUri}）`);
  const authorize = `${GITEE_AUTHORIZE}?client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code`;
  shell.openExternal(authorize);
  return token;
}

/**
 * Create the remote repository for the workspace.
 * @param {'github'|'gitee'} provider
 * @param {string} token access token
 * @param {string} name repo name
 * @param {boolean} isPrivate
 * @returns {Promise<string>} the git remote URL (with token embedded for pushing).
 */
async function createRemoteRepo(provider, token, name, isPrivate) {
  if (provider === 'github') {
    const doc = await getJson(`${GITHUB_API}/user`, { authorization: `token ${token}` });
    const owner = doc.login;
    const created = await postJson(`${GITHUB_API}/user/repos`, { name, private: isPrivate, auto_init: false }, { authorization: `token ${token}` });
    return { url: `https://${token}@github.com/${owner}/${created.name || name}.git`, web: created.html_url || `https://github.com/${owner}/${name}` };
  }
  // Gitee
  const body = new URLSearchParams({ access_token: token, name, private: isPrivate ? 'true' : 'false' });
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 30_000);
  const res = await fetch(`${GITEE_API}/user/repos`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': 'dsh-online-workspace' }, body: body.toString(), signal: ctl.signal });
  clearTimeout(t);
  const text = await res.text();
  let doc = null;
  try {
    doc = JSON.parse(text);
  } catch {
    doc = null;
  }
  if (!res.ok) throw new Error(`Gitee 创建仓库失败：HTTP ${res.status} ${text.slice(0, 200)}`);
  const owner = doc.owner ? doc.owner.login : doc.owner_id || 'owner';
  const pathname = doc.full_name || `${owner}/${name}`;
  return { url: `https://oauth2:${token}@gitee.com/${pathname}.git`, web: doc.html_url || `https://gitee.com/${pathname}` };
}

module.exports = { githubDeviceFlow, giteeAuthCodeFlow, createRemoteRepo };
