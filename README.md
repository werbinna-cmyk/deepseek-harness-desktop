# DeepSeek Harness Desktop（macOS / Windows）

> 仓库：<https://github.com/werbinna-cmyk/deepseek-harness-desktop>

DeepSeek Harness 的桌面版（macOS + Windows）。功能与网页版完全一致：应用启动时自动
拉起本地 `dsh web` 后端服务（Cordis 运行时，同时提供 API 与前端静态资源），并在
Electron 窗口中加载同一套 Web UI（会话、工具、插件、设置、目标、工作流等全部可用）。

核心特性：

- **开箱即用**：应用内置完整的 dsh 运行时快照，首次启动自动从 `~/.dsh` 迁移
  已有的 `.env` / 设置 / 预设 / 会话数据（一次性，不覆盖已有文件）。
- **首次启动自动安装 dsh**：应用自带 dsh 运行时，无需预先安装；若内置快照缺失
  （例如被精简或损坏），首次启动会自动从 npm registry 解析最新版本并执行
  `npm install` 完成安装（兜底路径），之后一切照常。
- **启动即拉起后端**：主进程用 Electron 自带 Node（`ELECTRON_RUN_AS_NODE`）以子进程
  方式启动 `dsh --profile web`，解析其打印的 URL 后加载界面；退出时优雅地 SIGTERM
  停掉后端。
- **复制粘贴**：应用不依赖系统菜单的 Edit 项，主进程通过 `before-input-event`
  拦截 Cmd/Ctrl+C/V/X/A/Z 并驱动 `webContents` 剪贴板 API，嵌入式 Web UI 内的
  复制/粘贴/剪切/全选/撤销重做均可用。
- **自动更新**：定期（启动后 10 秒 + 每 6 小时，可在“更新”菜单关闭）检查
  [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)
  的新版本。由于该仓库没有 GitHub Release，真正的发布通道是 npm（`@deepseek-ai/*`），
  更新检测以 npm registry 为准（对每个包取已发布 semver 最大值，规避 `latest`
  dist-tag 滞后问题），同时跟踪 GitHub master 分支 HEAD 作为“上游有新提交”的
  提前告警。发现新版本后自动在本地运行时目录执行 `npm install` 并重启后端。
## 目录结构

```
deepseek-harness-desktop/
├── main.js                     # Electron 主进程：窗口 / 菜单 / 生命周期 / 更新交互
├── lib/
│   ├── paths.js                # 数据目录解析（支持 DSH_DESKTOP_DATA_DIR 覆盖）
│   ├── log.js                  # 日志（写入 <数据目录>/logs）
│   ├── settings.js             # settings.json（端口、自动更新开关、更新状态）
│   ├── runtime.js              # 首次运行：数据布局、运行时种子拷贝、~/.dsh 迁移
│   ├── backend.js              # 后端子进程生命周期：spawn/URL 解析/端口回退/停止
│   └── updater.js              # npm + GitHub 版本检测、npm 安装更新
├── scripts/
│   ├── prepare-runtime.mjs     # 构建期：生成 runtime-mac/ 或 runtime-win/ 运行时快照
│   └── make-icon.mjs           # 生成应用图标（--from <图片> 或内置绘制）
├── resources/                  # icon.icns 等
├── runtime-mac/ / runtime-win/ # 平台运行时快照（构建产物，随应用按平台打包）
└── electron-builder.yml        # 打包配置
```

## 数据目录

默认 `~/Library/Application Support/DeepSeek Harness/`，可通过环境变量
`DSH_DESKTOP_DATA_DIR` 覆盖（开发/测试用）：

| 路径 | 内容 |
| --- | --- |
| `dsh-home/` | 后端进程的 `DSH_HOME`（profiles / sessions / storages / settings.yaml / .env） |
| `runtime/` | 实时 dsh 运行时（首次启动从 .app 内置快照拷贝，之后就地更新） |
| `logs/` | `main.log`（主进程）与 `backend.log`（后端子进程） |
| `settings.json` | 桌面端设置（后端端口、自动更新开关等） |

菜单「后端 → 打开数据目录 / 打开日志目录」可直接访问。

## 自动更新机制

1. 启动后与每 6 小时（可关）调用 `updater.checkForUpdates()`：
   - 对 `@deepseek-ai/dsh`、`@deepseek-ai/dsh-base`、`@deepseek-ai/dsh-web-app`
     查询 `https://registry.npmjs.org`，取全部已发布版本中 semver 最大者；
   - 与本地 `runtime/` 中安装的版本比较，任一更新则视为有新版本；
   - 同时请求 GitHub `commits/master`，记录 HEAD sha —— 若 npm 无更新但上游有新
     提交，则提示“上游有新提交但尚未发布”。
2. 有更新时（自动模式）或用户确认后（手动「立即检查更新…」）：
   - 停止后端 → 用内置 npm（`runtime/node_modules/npm`，仍以 Electron-as-Node 运行）
     在 `runtime/` 执行 `npm install @deepseek-ai/<pkg>@<新版本> ...`（显式版本，
     避免 CLI 依赖范围未变导致 bundle 不升级）→ 重启后端并刷新窗口 → 系统通知。
3. 更新状态记录在 `settings.json`（`lastUpdateCheckAt` / `lastUpdateInstalledAt`）。

> 说明：GitHub 仓库本身不发布二进制 Release，代码更新通过 npm 包发布落地，
> 因此 npm registry 是“仓库更新 → 可安装”的唯一真实信号；GitHub HEAD 检测用于
> 提前感知上游变动。

## 构建

前置条件：macOS + Node.js ≥ 22 + npm（构建机网络可访问 npm registry / GitHub）。

```bash
npm install                    # 安装 electron / electron-builder（缓存写本地 .npm-cache）
npm run prepare:runtime        # 解析最新版本并生成 runtime-mac/ 运行时快照（约 300MB）
npm run make:icon              # 生成 resources/icon.icns + icon.ico（内置绘制）
npm run make:icon -- --from ~/Downloads/xxx.webp   # 或用指定图片生成图标
npm run build                  # 打包 macOS .app + .dmg + .zip（electron-builder，输出到 dist/）
```

- 无 dmg 需求可只跑 `npm run build:dir`（只生成 .app）。
- electron-builder 默认只打 `arm64`（Apple Silicon）；如需 Intel 版在
  `electron-builder.yml` 的 `mac.target` 中追加 `x64`。
- 国内网络下若 electron-builder 仍需要拉取辅助工具，可先手动把
  `dmgbuild-bundle-arm64-75c8a6c.tar.gz` 放入 `~/Library/Caches/electron-builder/
  dmg-builder@1.2.5/`（下载源：
  `https://npmmirror.com/mirrors/electron-builder-binaries/dmg-builder@1.2.5/`），
  或在构建命令前加 `ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/`。

### Windows 安装版

在 macOS 上交叉打包 Windows x64（NSIS 安装程序 + 便携 zip）：

```bash
node scripts/prepare-runtime.mjs --platform win32 --arch x64   # 生成 runtime-win/（win32 原生二进制）
npx electron-builder --win                                      # 输出 dist/DeepSeek Harness-1.0.0-x64-setup.exe
```

- Windows 运行时用 `--os=win32 --cpu=x64 --ignore-scripts` 安装（原生包如 koffi/sharp
  通过平台 optional 依赖提供预编译二进制，跳过安装脚本即可）。
- Windows 数据目录为 `%APPDATA%\DeepSeek Harness`（代码里已按平台区分）。
- Windows 差异：`child.kill('SIGTERM')` 在 Windows 上是强制结束（无优雅退出钩子）；
  后端会话数据为增量持久化，影响有限。

产物示例（`dist/`）：

```
macOS:
DeepSeek Harness.app/                  # 解包后的应用（直接可运行）
DeepSeek Harness-1.0.0-arm64.dmg       # 安装镜像
DeepSeek Harness-1.0.0-arm64-mac.zip   # 压缩包（自动更新/分发用）

Windows:
DeepSeek Harness-1.0.0-x64-setup.exe   # NSIS 安装程序
DeepSeek Harness-1.0.0-win.zip         # 便携 zip
```

## 发布与 Release 使用说明

### 获取安装包

GitHub Release 页面：<https://github.com/werbinna-cmyk/deepseek-harness-desktop/releases>

| 平台 | 文件 | 安装方式 |
| --- | --- | --- |
| macOS（Apple Silicon） | `DeepSeek.Harness-1.0.0-arm64.dmg` | 打开 dmg，把 **DeepSeek Harness** 拖入「应用程序」；首次打开如提示“无法验证开发者”，右键 → 打开 → 打开 |
| macOS（Apple Silicon） | `DeepSeek.Harness-1.0.0-arm64-mac.zip` | 解压后把 `DeepSeek Harness.app` 放入「应用程序」 |
| Windows x64 | `DeepSeek.Harness-1.0.0-x64-setup.exe` | 运行安装向导（可选安装目录、桌面/开始菜单快捷方式）；**未签名**，SmartScreen 提示请选「仍要运行」 |
| Windows x64 | `DeepSeek.Harness-1.0.0-win.zip` | 解压到任意目录，运行 `DeepSeek Harness.exe`（便携版） |

数据与配置：macOS 在 `~/Library/Application Support/DeepSeek Harness/`，Windows 在
`%APPDATA%\DeepSeek Harness\`。首次启动会自动迁移旧 `~/.dsh` 的 `.env` / 设置 / 预设。

### 标签与版本

- `v1.0.0` — 发布标签（对应 Release）
- `dsh`、`deepseek-harness` — 语义标签（均指向 v1.0.0 提交）
- 新版本流程：修改 `package.json` 的 `version` → 推送 `vX.Y.Z` 标签 →
  [GitHub Actions](#github-actions-双平台自动构建) 自动构建并把安装包附加到该标签的
  Release。

### 应用内更新提示

- 菜单「更新 → 立即检查更新…（⌘/Ctrl+U）」与后台自动检查会同时做两件事：
  1. **dsh 运行时**：检查 npm 上 `@deepseek-ai/*` 的新版本并**自动就地更新**（无需重装）；
  2. **桌面版本身**：检查本仓库 GitHub Release，若有新版本弹窗/通知引导前往下载
     （macOS 下载 .dmg，Windows 下载 setup.exe）——桌面版应用目前不做静默自升级，
     安装新版前请先退出旧版。

## GitHub Actions 双平台自动构建

仓库内置 `.github/workflows/build.yml`：

- 推送 `main`：macOS（arm64）与 Windows（x64）各自在原生 runner 上构建运行时并
  打包，产物作为 Actions Artifacts（预览构建）。
- 推送 `v*` 标签：构建后把 `dmg/zip/setup.exe` 自动附加到该标签对应的 GitHub
  Release（`softprops/action-gh-release`）。
- 手动触发：仓库 Actions 页 → **Run workflow**。

## 运行与冒烟测试

```bash
npm start                      # 开发模式运行（未打包，使用仓库内 runtime-mac/）
npm run smoke                  # 冒烟测试：拉起后端 → 打印 SMOKE_OK <url> → 退出
node scripts/verify-update-logic.mjs   # 校验更新检测逻辑（registry 版本 + GitHub HEAD）
```

冒烟测试默认使用临时数据目录（`DSH_DESKTOP_DATA_DIR`），不会触碰真实用户数据；
对打包后的应用同样可用：
`DSH_DESKTOP_DATA_DIR=$(mktemp -d) "dist/mac-arm64/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness" --smoke-test`。

## 已知限制

- 后端端口默认 3620（`settings.json` 可改）；被占用时自动回退到系统分配端口。
- 桌面版使用独立的 `DSH_HOME`（见数据目录），与 `dsh web`（`~/.dsh`）数据隔离；
  首次启动会主动迁移一次旧数据。
- 更新需要网络与本地磁盘空间（npm 安装）。
- 当前仅支持 macOS（Apple Silicon / Intel 可分别构建）。
