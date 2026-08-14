'use strict';
// 在线工作区插件：把工作区目录（文件/资源/代码）与对应 DSH 会话/上下文同步到
// GitHub 或 Gitee。OAuth 浏览器登录（GitHub device flow / Gitee 授权码回调），
// 令牌存入 settings.json；定期 + 退出时 push，启动时 pull，实现跨设备流转。
//
// 同步目录布局（工作区目录 W）：
//   W/                —— 用户文件、资源、代码（git 仓库根）
//   W/.dsh/sessions/  —— 该工作区对应的 DSH 会话/上下文（来自 $DSH_HOME/sessions/<projectKey(W)>）

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { projectKey } = require('./lib/keys');
const git = require('./lib/git');
const oauth = require('./lib/oauth');

const SYNC_INTERVAL_MS = 5 * 60_000;
const DEFAULT_WORKSPACE = path.join(os.homedir(), 'Documents', 'DSH Online Workspace');

function readState(settings) {
  const s = settings.read();
  return s.onlineWorkspace || {};
}

function writeState(settings, patch) {
  const s = settings.read();
  settings.write({ onlineWorkspace: { ...(s.onlineWorkspace || {}), ...patch } });
}

/** The remote repo name for a workspace dir. */
function repoNameFor(dir, preferred) {
  if (preferred) return preferred.replace(/[^\w.-]/g, '-');
  const base = path.basename(dir.trim().replace(/[\\/]+$/, '')) || 'dsh-online-workspace';
  return base.replace(/[^\w.-]/g, '-') || 'dsh-online-workspace';
}

module.exports = {
  activate(ctx) {
    const { menu, settings, dialog, shell, BrowserWindow, ipcMain, log, onQuit, getMainWindow, paths } = ctx;

    let state = readState(settings);
    let configWindow = null;
    let syncing = false;

    // ── menu ────────────────────────────────────────────────────────────────

    const refreshMenuLabel = () => {
      // (menu rebuilt lazily by the app on next launch; label kept simple)
    };
    menu.add({
      label: '在线工作区',
      submenu: [
        { label: '连接 GitHub / Gitee…', click: () => connectFlow(true) },
        { label: '同步设置…', click: () => openConfigWindow() },
        { label: '立即同步', click: () => syncNow(true) },
        { type: 'separator' },
        { label: '同步状态…', click: () => showStatus() },
      ],
    });

    // ── config window & IPC ─────────────────────────────────────────────────

    ipcMain.handle('ow:get', () => {
      state = readState(settings);
      return {
        provider: state.provider || '',
        githubClientId: state.githubClientId || '',
        giteeClientId: state.giteeClientId || '',
        giteeClientSecret: state.giteeClientSecret || '',
        workspaceDir: state.workspaceDir || DEFAULT_WORKSPACE,
        repoName: state.repoName || '',
        private: state.private !== false,
      };
    });

    ipcMain.handle('ow:save', (_e, cfg) => {
      writeState(settings, {
        provider: cfg.provider,
        githubClientId: cfg.githubClientId,
        giteeClientId: cfg.giteeClientId,
        giteeClientSecret: cfg.giteeClientSecret,
        workspaceDir: cfg.workspaceDir,
        repoName: cfg.repoName,
        private: !!cfg.private,
      });
      state = readState(settings);
      return { ok: true };
    });

    ipcMain.handle('ow:connect', async () => {
      state = readState(settings);
      const res = await connectFlow(false);
      return res;
    });

    function openConfigWindow() {
      if (configWindow && !configWindow.isDestroyed()) {
        configWindow.focus();
        return;
      }
      configWindow = new BrowserWindow({
        width: 520,
        height: 640,
        resizable: false,
        title: '在线工作区设置',
        backgroundColor: '#0d1117',
        parent: getMainWindow() || undefined,
        webPreferences: {
          preload: path.join(ctx.rootDir, 'preload.js'),
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
        },
      });
      configWindow.setMenuBarVisibility(false);
      configWindow.loadFile(path.join(ctx.rootDir, 'ui.html'));
      configWindow.on('closed', () => {
        configWindow = null;
      });
    }

    // ── connect flow ────────────────────────────────────────────────────────

    async function connectFlow(manual) {
      state = readState(settings);
      const win = getMainWindow();

      if (manual) {
        const choice = await dialog.showMessageBox(win, {
          type: 'question',
          buttons: ['GitHub', 'Gitee', '取消'],
          defaultId: 0,
          cancelId: 2,
          title: '选择同步平台',
          message: '在线工作区将把工作区内容同步到哪个平台？',
          detail: '首次使用需要浏览器登录对应平台授权。',
        });
        if (choice.response === 2) return { ok: false, error: '已取消' };
        writeState(settings, { provider: choice.response === 0 ? 'github' : 'gitee' });
        state = readState(settings);
      }

      // Credential check: GitHub needs client_id; Gitee needs id + secret.
      const missing =
        state.provider === 'gitee'
          ? !state.giteeClientId || !state.giteeClientSecret
          : !state.githubClientId;
      if (missing) {
        const go = await dialog.showMessageBox(win, {
          type: 'info',
          buttons: ['去填写', '取消'],
          defaultId: 0,
          cancelId: 1,
          title: '需要 OAuth 客户端信息',
          message: state.provider === 'gitee'
            ? '请先填写 Gitee OAuth 应用的 Client ID 与 Client Secret'
            : '请先填写 GitHub OAuth App 的 Client ID',
          detail: '在同步设置中填写后保存并连接。',
        });
        if (go.response === 0) openConfigWindow();
        return { ok: false, error: '缺少 OAuth 配置' };
      }

      let token;
      try {
        if (state.provider === 'github') {
          token = await oauth.githubDeviceFlow(state.githubClientId, (msg) => {
            log.log(`[online-workspace] github: ${msg}`);
            dialog.showMessageBox(win, { type: 'info', title: 'GitHub 登录', message: msg, detail: '登录完成后请回到本应用等待自动继续。' }).catch(() => {});
          });
        } else {
          token = await oauth.giteeAuthCodeFlow(state.giteeClientId, state.giteeClientSecret, (msg) => log.log(`[online-workspace] gitee: ${msg}`));
        }
      } catch (err) {
        log.error(`[online-workspace] oauth failed: ${err.message}`);
        return { ok: false, error: `登录失败：${err.message}` };
      }
      writeState(settings, { token });
      state = readState(settings);

      // Workspace dir default + remote repo.
      const workspaceDir = state.workspaceDir || DEFAULT_WORKSPACE;
      writeState(settings, { workspaceDir });
      state = readState(settings);

      try {
        const repoName = repoNameFor(workspaceDir, state.repoName);
        log.log(`[online-workspace] creating remote repo ${repoName} on ${state.provider}`);
        const { url, web } = await oauth.createRemoteRepo(state.provider, token, repoName, state.private !== false);
        writeState(settings, { remoteUrl: url, remoteWeb: web, repoName });
        state = readState(settings);

        await git.ensureRepo(workspaceDir);
        await git.setRemote(workspaceDir, url);
        await syncNow(false);
        return { ok: true, remote: web || url };
      } catch (err) {
        log.error(`[online-workspace] connect/sync failed: ${err.message}`);
        return { ok: false, error: `连接后同步失败：${err.message}` };
      }
    }

    // ── sync engine ─────────────────────────────────────────────────────────

    async function syncNow(manual) {
      state = readState(settings);
      const win = getMainWindow();
      if (!state.token || !state.workspaceDir) {
        if (manual) dialog.showMessageBox(win, { type: 'info', title: '在线工作区', message: '尚未连接，请先「连接 GitHub / Gitee」。' });
        return { ok: false, error: 'not connected' };
      }
      if (syncing) return { ok: false, error: 'syncing' };
      syncing = true;
      try {
        const dir = state.workspaceDir;
        await git.ensureRepo(dir);

        // Sessions in: $DSH_HOME/sessions/<projectKey(dir)> -> <dir>/.dsh/sessions
        const srcSessions = path.join(paths.dshHomeDir(), 'sessions', projectKey(dir));
        const dstSessions = path.join(dir, '.dsh', 'sessions');
        if (fs.existsSync(srcSessions)) {
          fs.mkdirSync(path.dirname(dstSessions), { recursive: true });
          fs.cpSync(srcSessions, dstSessions, { recursive: true });
        }

        // Pull remote changes first (cross-machine), then push ours.
        const branch = await git.currentBranch(dir);
        const pulled = await git.pull(dir, branch);
        if (!pulled.ok) log.warn(`[online-workspace] pull: ${pulled.error}`);

        const res = await git.commitAndPush(dir, branch, `sync ${new Date().toISOString()}`);
        writeState(settings, { lastSyncAt: new Date().toISOString() });
        log.log(`[online-workspace] sync ok (${res.pushed ? res.changedCount + ' changed' : 'no changes'})`);
        return { ok: true, pushed: res.pushed };
      } catch (err) {
        log.error(`[online-workspace] sync failed: ${err.message}`);
        if (manual) dialog.showMessageBox(win, { type: 'error', title: '同步失败', message: err.message });
        return { ok: false, error: err.message };
      } finally {
        syncing = false;
      }
    }

    async function showStatus() {
      state = readState(settings);
      const win = getMainWindow();
      if (!state.token || !state.workspaceDir) {
        dialog.showMessageBox(win, { type: 'info', title: '在线工作区', message: '尚未连接。' });
        return;
      }
      const st = await git.status(state.workspaceDir);
      dialog.showMessageBox(win, {
        type: 'info',
        title: '在线工作区状态',
        message: `平台：${state.provider === 'github' ? 'GitHub' : 'Gitee'}`,
        detail: [
          `工作区：${state.workspaceDir}`,
          `远端：${state.remoteWeb || state.remoteUrl || st.remote || '(未设置)'}`,
          `待提交：${st.error ? st.error : st.changed + ' 项'}`,
          `最近提交：${st.lastCommit || '(无)'}`,
          `上次同步：${state.lastSyncAt ? new Date(state.lastSyncAt).toLocaleString() : '(未同步)'}`,
        ].join('\n'),
      });
    }

    // ── lifecycle ───────────────────────────────────────────────────────────

    const timer = setInterval(() => {
      state = readState(settings);
      if (state.token && state.workspaceDir) syncNow(false);
    }, SYNC_INTERVAL_MS);

    onQuit(async () => {
      clearInterval(timer);
      state = readState(settings);
      if (state.token && state.workspaceDir) {
        await syncNow(false);
      }
    });

    // Startup: pull + sync shortly after boot when already connected.
    if (state.token && state.workspaceDir) {
      setTimeout(() => syncNow(true), 8_000);
    }

    log.log('[online-workspace] plugin activated');
    return [];
  },
};
