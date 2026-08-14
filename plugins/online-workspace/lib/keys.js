'use strict';
// DSH session project-key encoding (mirrors dsh-session-persistence-jsonl):
// separators (`/`, `\`, `:`) collapse to `-`, safe chars stay literal, other
// code units become `~XXXX`, wrapped in `--…--`. Used to locate the sessions
// of a given workspace directory under $DSH_HOME/sessions.

function projectKey(cwd) {
  if (!cwd || cwd.length === 0) return '--root--';
  let readable = '';
  let separatorRun = false;
  for (let i = 0; i < cwd.length; i++) {
    const code = cwd.charCodeAt(i);
    const ch = String.fromCharCode(code);
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-';
      separatorRun = true;
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch;
      separatorRun = false;
    } else {
      readable += '~' + code.toString(16).toUpperCase().padStart(4, '0');
      separatorRun = false;
    }
  }
  return `--${(readable.replace(/^-+/, '') || 'root').slice(0, 251)}--`;
}

module.exports = { projectKey };
