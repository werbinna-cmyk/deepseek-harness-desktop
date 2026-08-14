'use strict';
// Tiny file logger. Everything the main process and the backend child print
// lands in <data>/logs for diagnostics. Never throws: logging must not take
// the app down.

const fs = require('node:fs');
const path = require('node:path');

let mainLogFile = null;

function ensureDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    /* ignore */
  }
}

function init(file) {
  mainLogFile = file;
  if (mainLogFile) ensureDir(path.dirname(mainLogFile));
}

function ts() {
  return new Date().toISOString();
}

function write(line) {
  try {
    if (mainLogFile) fs.appendFileSync(mainLogFile, line + '\n');
  } catch {
    /* ignore */
  }
}

function log(...args) {
  const line = `[${ts()}] ${args.map(String).join(' ')}`;
  console.log(line);
  write(line);
}

function warn(...args) {
  const line = `[${ts()}] [warn] ${args.map(String).join(' ')}`;
  console.warn(line);
  write(line);
}

function error(...args) {
  const line = `[${ts()}] [error] ${args.map(String).join(' ')}`;
  console.error(line);
  write(line);
}

module.exports = { init, log, warn, error, ts };
