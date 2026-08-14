'use strict';
// Minimal semver comparison for the updater. The packaged app ships with NO
// node_modules (main.js + lib/* are pure JS), so we cannot depend on the
// `semver` package at runtime. Handles the version shapes dsh publishes:
// 0.x.y, 0.x.y-rc.N, 0.x.y-rc.N-alpha etc. (numeric and alphanumeric
// prerelease identifiers, per semver precedence rules).

function parseVersion(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(String(v).trim());
  if (!m) return null;
  return { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] ? m[4].split('.') : [] };
}

/** -1 | 0 | 1; invalid input compares as equal (callers filter with valid() first). */
function compare(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return 0;
  for (const k of ['major', 'minor', 'patch']) {
    if (pa[k] !== pb[k]) return pa[k] < pb[k] ? -1 : 1;
  }
  // a release outranks a prerelease of the same core
  if (pa.pre.length === 0 && pb.pre.length === 0) return 0;
  if (pa.pre.length === 0) return 1;
  if (pb.pre.length === 0) return -1;
  const n = Math.max(pa.pre.length, pb.pre.length);
  for (let i = 0; i < n; i++) {
    const x = pa.pre[i];
    const y = pb.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const nx = /^\d+$/.test(x);
    const ny = /^\d+$/.test(y);
    if (nx && ny) {
      if (+x !== +y) return +x < +y ? -1 : 1;
    } else if (nx) {
      return -1; // numeric identifiers sort below alphanumeric ones
    } else if (ny) {
      return 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

function valid(v) {
  return parseVersion(v) !== null;
}

function gt(a, b) {
  return compare(a, b) > 0;
}

function gte(a, b) {
  return compare(a, b) >= 0;
}

module.exports = { valid, compare, gt, gte };
