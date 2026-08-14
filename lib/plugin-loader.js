'use strict';
// Desktop plugin loader.
//
// Loads plugins from <repo>/plugins (dev) or <app>/Resources/plugins (packaged):
// each plugin is a directory with package.json {name, main}. main must export
// `activate(ctx)` (and optionally `deactivate`). Plugins run in the main
// process and receive a bounded ctx so they can add menu items, register IPC
// handlers, schedule work, and hook app quit — without touching core code.
//
// The online-workspace feature ships as such a plugin (plugins/online-workspace).

const fs = require('node:fs');
const path = require('node:path');

/** The plugins root (dev vs packaged). */
function pluginsDir() {
  const { app } = require('electron');
  if (app.isPackaged) return path.join(process.resourcesPath, 'plugins');
  return path.join(__dirname, '..', 'plugins');
}

/**
 * Load every desktop plugin and activate it.
 * @param {object} core shared core capabilities (menu contributions, settings,
 *                      ipc registration, quit hooks, dialogs…).
 * @returns {Promise<Array<{name:string, deactivate?:Function}>>} loaded plugins.
 */
async function loadPlugins(core) {
  const root = pluginsDir();
  const loaded = [];
  if (!fs.existsSync(root)) return loaded;

  const dirs = fs
    .readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();

  for (const dir of dirs) {
    const manifestPath = path.join(root, dir, 'package.json');
    if (!fs.existsSync(manifestPath)) continue;
    let manifest;
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    } catch (err) {
      console.error(`[plugins] ${dir}: bad package.json: ${err.message}`);
      continue;
    }
    if (!manifest.main || !manifest.name) continue;
    try {
      const entry = require(path.join(root, dir, manifest.main));
      if (typeof entry.activate !== 'function') {
        console.warn(`[plugins] ${manifest.name}: no activate() export, skipped`);
        continue;
      }
      const pluginCtx = {
        ...core,
        name: manifest.name,
        rootDir: path.join(root, dir),
      };
      const disposers = await entry.activate(pluginCtx);
      const plugin = { name: manifest.name, deactivate: entry.deactivate };
      if (disposers && Array.isArray(disposers)) plugin.disposers = disposers;
      loaded.push(plugin);
      console.log(`[plugins] loaded ${manifest.name} v${manifest.version || '?'}`);
    } catch (err) {
      console.error(`[plugins] ${manifest.name}: activate failed: ${err.stack || err.message}`);
    }
  }
  return loaded;
}

module.exports = { loadPlugins, pluginsDir };
