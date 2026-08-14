'use strict';
// Path resolution for the desktop app. In production every mutable file lives
// under ~/Library/Application Support/DeepSeek Harness; DSH_DESKTOP_DATA_DIR
// overrides that root (used by dev and smoke tests so nothing leaks outside
// the workspace).

const path = require('node:path');
const os = require('node:os');
const { app } = require('electron');

const APP_DATA_NAME = 'DeepSeek Harness';

/** Root directory holding runtime, dsh-home, logs and settings. */
function dataDir() {
  const override = process.env.DSH_DESKTOP_DATA_DIR;
  if (override) return path.resolve(override);
  return path.join(os.homedir(), 'Library', 'Application Support', APP_DATA_NAME);
}

/** The DSH_HOME handed to the spawned dsh backend (its own profiles/sessions/storages). */
function dshHomeDir() {
  return path.join(dataDir(), 'dsh-home');
}

/** The live dsh runtime (node_modules snapshot + package.json), updatable in place. */
function runtimeDir() {
  return path.join(dataDir(), 'runtime');
}

/** Log file directory. */
function logsDir() {
  return path.join(dataDir(), 'logs');
}

/** Desktop settings.json. */
function settingsPath() {
  return path.join(dataDir(), 'settings.json');
}

/** Backend log file. */
function backendLogPath() {
  return path.join(logsDir(), 'backend.log');
}

/** Main-process log file. */
function mainLogPath() {
  return path.join(logsDir(), 'main.log');
}

/**
 * The runtime snapshot bundled inside the app.
 *  - packaged: <app>/Contents/Resources/runtime (extraResources)
 *  - dev:      <repo>/runtime
 */
function bundledRuntimeDir() {
  if (app.isPackaged) return path.join(process.resourcesPath, 'runtime');
  return path.join(__dirname, '..', 'runtime');
}

/** The dsh CLI entry inside a runtime directory. */
function dshCliPath(runtimeRoot) {
  return path.join(runtimeRoot, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
}

/** The bundled npm CLI inside a runtime directory (used by the updater). */
function npmCliPath(runtimeRoot) {
  return path.join(runtimeRoot, 'node_modules', 'npm', 'bin', 'npm-cli.js');
}

/** Installed version of a @deepseek-ai package inside a runtime, or null. */
function installedVersion(runtimeRoot, pkg) {
  try {
    const p = path.join(runtimeRoot, 'node_modules', '@deepseek-ai', pkg, 'package.json');
    return require(p).version || null;
  } catch {
    return null;
  }
}

module.exports = {
  APP_DATA_NAME,
  dataDir,
  dshHomeDir,
  runtimeDir,
  logsDir,
  settingsPath,
  backendLogPath,
  mainLogPath,
  bundledRuntimeDir,
  dshCliPath,
  npmCliPath,
  installedVersion,
};
