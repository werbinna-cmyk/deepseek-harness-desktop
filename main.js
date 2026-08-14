'use strict';
// DeepSeek Harness desktop main process.
//
// Responsibilities:
//  1. Single-instance lock.
//  2. On ready: data layout, runtime seed (from the bundled snapshot), one-time
//     migration of a legacy ~/.dsh web install, then spawn the dsh backend.
//  3. BrowserWindow that loads the backend's web UI once it is reachable.
//  4. Menu: restart backend, open data/log dirs, update controls.
//  5. Auto-update: npm registry (source of truth) + GitHub HEAD as early
//     warning; applies updates by npm-installing in the live runtime and
//     restarting the backend.
//  6. Clean teardown: SIGTERM the backend on quit.
//
// `--smoke-test` runs headless-ish: starts the backend with an OS-assigned
// port, prints SMOKE_OK <url> / SMOKE_FAIL and exits — used by CI and dev.

const { app, BrowserWindow, Menu, dialog, Notification, shell } = require('electron');
const paths = require('./lib/paths');
const log = require('./lib/log');
const settings = require('./lib/settings');
const runtime = require('./lib/runtime');
const backend = require('./lib/backend');
const updater = require('./lib/updater');

let mainWindow = null;
let quitting = false;
let updating = false;
let backendFailed = false;

// ── status pages (dark, minimal) ──────────────────────────────────────────

function statusPage(title, bodyHtml, spin) {
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
      background:#0d1117;color:#e6edf3;font-family:-apple-system,"PingFang SC",sans-serif;text-align:center}
    .box{max-width:560px;padding:40px}
    h1{font-size:20px;font-weight:600;margin:0 0 12px}
    p{font-size:14px;line-height:1.6;color:#8b949e;word-break:break-all}
    .spin{width:28px;height:28px;margin:0 auto 24px;border-radius:50%;
      border:3px solid #21262d;border-top-color:#4c9aff;animation:r 1s linear infinite}
    @keyframes r{to{transform:rotate(360deg)}}
  </style></head><body><div class="box">
    ${spin ? '<div class="spin"></div>' : ''}
    <h1>${title}</h1><p>${bodyHtml}</p>
  </div></body></html>`;
  return 'data:text/html;charset=utf-8,' + encodeURIComponent(html);
}

function loadingPage() {
  return statusPage('正在启动 DeepSeek Harness…', '正在拉起本地后端服务，请稍候。', true);
}

function errorPage(detail) {
  return statusPage('后端启动失败', (detail || '') + '<br>请检查日志，或通过菜单“重启后端”重试。', false);
}

// ── backend orchestration ─────────────────────────────────────────────────

function backendOpts() {
  return {
    port: settings.read().port,
    onUrl: (url) => {
      backendFailed = false;
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.loadURL(url);
      }
      log.log(`UI loaded from ${url}`);
    },
    onExit: (info) => {
      if (quitting || updating) return;
      backendFailed = true;
      log.error(`backend stopped unexpectedly: ${JSON.stringify(info)}`);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.loadURL(errorPage(info.reason === 'runtime-missing'
          ? '内置运行时缺失，请重新安装应用。'
          : `后端进程退出（${info.reason || info.code || ''}）。`));
      }
      if (Notification.isSupported()) {
        new Notification({ title: 'DeepSeek Harness', body: '后端已停止，请通过菜单“重启后端”恢复。' }).show();
      }
    },
  };
}

function startBackend() {
  backendFailed = false;
  backend.start(backendOpts());
}

// ── update flow ───────────────────────────────────────────────────────────

async function checkNow(manual) {
  if (updating) return;
  log.log(`manual update check: ${manual}`);
  const res = await updater.checkForUpdates();

  if (!res.available) {
    if (manual) {
      let detail = '当前已是最新版本。';
      if (res.github.newCommits) {
        detail = '上游 GitHub 仓库（deepseek-ai/deepseek-harness）有新提交，但 npm 尚未发布新版本，暂不更新。';
      }
      dialog.showMessageBox(mainWindow, { type: 'info', title: '检查更新', message: '没有可用更新', detail });
    }
    return;
  }

  const latest = res.pkgs.map((p) => `  ${p.name}: ${p.from || '(未安装)'} → ${p.to}`).join('\n');
  log.log(`update available:\n${latest}`);

  if (manual) {
    const choice = await dialog.showMessageBox(mainWindow, {
      type: 'info',
      buttons: ['立即更新', '稍后'],
      defaultId: 0,
      cancelId: 1,
      title: '发现新版本',
      message: 'DeepSeek Harness 有新版本可用',
      detail: `${latest}\n\n更新需要短暂停止后端并重新启动。`,
    });
    if (choice.response !== 0) return;
  }

  await doUpdate(res);
}

async function doUpdate(res) {
  updating = true;
  try {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.loadURL(statusPage('正在更新 DeepSeek Harness…', '正在下载并安装新版本，请稍候（约 1–3 分钟）。'));
    }
    await backend.stop();
    const r = await updater.applyUpdate(res);
    if (!r.ok) {
      log.error(`update install failed: ${r.error}`);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.loadURL(errorPage('更新安装失败：' + (r.error || '未知错误')));
      }
      dialog.showMessageBox(mainWindow, { type: 'error', title: '更新失败', message: '更新安装失败', detail: r.error });
      startBackend();
      return;
    }
    settings.write({ lastUpdateInstalledAt: new Date().toISOString() });
    log.log('update applied; restarting backend');
    startBackend();
    if (Notification.isSupported()) {
      new Notification({ title: 'DeepSeek Harness', body: `已更新到 ${res.pkgs[0]?.to || '最新版本'}` }).show();
    }
  } finally {
    updating = false;
  }
}

function scheduleAutoUpdate() {
  const s = settings.read();
  if (!s.autoUpdate) return;
  // first check shortly after boot, then on the configured interval
  setTimeout(() => checkNow(false), 10_000);
  setInterval(() => checkNow(false), Math.max(1, s.checkIntervalHours || 6) * 3600_000);
}

// ── menu ──────────────────────────────────────────────────────────────────

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    }] : []),
    {
      label: '后端',
      submenu: [
        {
          label: '重启后端',
          accelerator: 'CmdOrCtrl+Shift+R',
          click: () => {
            if (updating) return;
            if (mainWindow && !mainWindow.isDestroyed()) mainWindow.loadURL(loadingPage());
            backend.restart(backendOpts());
          },
        },
        { type: 'separator' },
        { label: '打开数据目录…', click: () => shell.openPath(paths.dataDir()) },
        { label: '打开日志目录…', click: () => shell.openPath(paths.logsDir()) },
      ],
    },
    {
      label: '更新',
      submenu: [
        { label: '立即检查更新…', accelerator: 'CmdOrCtrl+U', click: () => checkNow(true) },
        {
          label: '自动更新',
          type: 'checkbox',
          checked: settings.read().autoUpdate,
          click: (item) => settings.write({ autoUpdate: item.checked }),
        },
      ],
    },
    { role: 'windowMenu' },
    {
      label: '帮助',
      submenu: [
        { label: 'GitHub 仓库', click: () => shell.openExternal(`https://github.com/${updater.GITHUB_REPO}`) },
        { label: '报告问题', click: () => shell.openExternal(`https://github.com/${updater.GITHUB_REPO}/issues`) },
        { role: 'about' },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ── window ────────────────────────────────────────────────────────────────

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 720,
    minHeight: 480,
    show: false,
    title: 'DeepSeek Harness',
    backgroundColor: '#0d1117',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.loadURL(loadingPage());

  // Keep the shell on the local backend; everything else goes to the browser.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const current = backend.currentUrl();
    if (current && !url.startsWith(current) && !url.startsWith('data:')) {
      event.preventDefault();
      if (/^https?:/i.test(url)) shell.openExternal(url);
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// ── lifecycle ─────────────────────────────────────────────────────────────

const SMOKE = process.argv.includes('--smoke-test');

if (SMOKE) {
  app.whenReady().then(async () => {
    log.init(paths.mainLogPath());
    runtime.ensureLayout();
    // Smoke mode has no app lifecycle handlers; without this, destroying the
    // last (hidden) window makes Electron exit immediately.
    app.on('window-all-closed', () => {});
    const seeded = await runtime.seedRuntime();
    const finish = (code, label) => backend.stop().then(() => {
      // log.log does a synchronous appendFileSync, so the result line always
      // lands in logs/main.log even if the stdout pipe write is lost on exit.
      log.log(label);
      setTimeout(() => app.exit(code), 200);
    });

    if (!seeded) {
      finish(1, 'SMOKE_FAIL runtime-seed');
      return;
    }

    backend.start({
      port: 0,
      onUrl: (u) => finish(0, 'SMOKE_OK ' + u),
      onExit: (info) => finish(1, 'SMOKE_FAIL ' + JSON.stringify(info)),
    });
    setTimeout(() => finish(2, 'SMOKE_TIMEOUT'), 90_000);
  });
} else {
  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) {
    app.quit();
  } else {
    app.on('second-instance', () => {
      if (mainWindow) {
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.focus();
      }
    });

    app.whenReady().then(async () => {
      log.init(paths.mainLogPath());
      log.log(`DeepSeek Harness desktop starting (packaged=${app.isPackaged})`);
      runtime.ensureLayout();

      if (!(await runtime.seedRuntime())) {
        createWindow();
        mainWindow.loadURL(errorPage('内置运行时缺失或无法初始化，请重新安装应用（或安装 Node.js 后重试自动安装）。'));
        return;
      }

      const migrated = runtime.migrateLegacyHome();
      if (migrated.copied.length > 0) {
        log.log(`imported from legacy ~/.dsh: ${migrated.copied.join(', ')}`);
      }

      createWindow();
      buildMenu();
      startBackend();
      scheduleAutoUpdate();

      app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
      });
    });

    app.on('window-all-closed', () => {
      app.quit();
    });

    // Graceful backend teardown before exit.
    app.on('before-quit', (event) => {
      if (quitting) return;
      event.preventDefault();
      quitting = true;
      backend.stop().then(() => {
        app.exit(0);
      });
    });
  }
}
