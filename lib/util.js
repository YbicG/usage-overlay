'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

const HOME = os.homedir();

/** Recursively list files under dir matching predicate. Never throws. */
function walk(dir, pred, out = [], depth = 0, maxDepth = 8) {
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (depth < maxDepth) walk(p, pred, out, depth + 1, maxDepth); }
    else if (pred(p, e.name)) out.push(p);
  }
  return out;
}

function sigOf(file) {
  try {
    const s = fs.statSync(file);
    // include the -wal sibling so live SQLite writes are noticed
    let wal = 0;
    try { wal = fs.statSync(file + '-wal').mtimeMs; } catch {}
    return `${s.size}:${Math.floor(s.mtimeMs)}:${Math.floor(wal)}`;
  } catch { return null; }
}

function mtimeOf(file) { try { return fs.statSync(file).mtimeMs; } catch { return 0; } }

function baseName(p) {
  if (!p) return 'unknown';
  const s = String(p).replace(/[\\/]+$/, '');
  const parts = s.split(/[\\/]/);
  return parts[parts.length - 1] || s;
}

/** Minimal protobuf reader (varint / length-delimited / fixed). Returns array of {f,w,v}. */
function readVarint(b, i) {
  let r = 0, mul = 1;
  for (let n = 0; n < 10; n++) {
    if (i >= b.length) throw new Error('eof');
    const x = b[i++];
    r += (x & 127) * mul;
    if (x < 128) return [r, i];
    mul *= 128;
  }
  throw new Error('varint');
}
function pbDecode(b) {
  const out = [];
  let i = 0;
  while (i < b.length) {
    let k; [k, i] = readVarint(b, i);
    const f = Math.floor(k / 8), w = k % 8;
    if (f === 0) throw new Error('bad field');
    if (w === 0) { let v; [v, i] = readVarint(b, i); out.push({ f, w, v }); }
    else if (w === 2) {
      let l; [l, i] = readVarint(b, i);
      if (i + l > b.length) throw new Error('len');
      out.push({ f, w, v: b.subarray(i, i + l) }); i += l;
    } else if (w === 1) { out.push({ f, w, v: b.subarray(i, i + 8) }); i += 8; }
    else if (w === 5) { out.push({ f, w, v: b.subarray(i, i + 4) }); i += 4; }
    else throw new Error('wire');
  }
  return out;
}
function pbTry(b) { try { return pbDecode(b); } catch { return null; } }
function pbGet(fields, f) { return fields && fields.find(x => x.f === f); }
function pbAll(fields, f) { return fields ? fields.filter(x => x.f === f) : []; }

/** Kill a spawned CLI and anything it started (Windows doesn't do this for us). */
function killTree(child) {
  if (!child || child.exitCode != null) return;
  if (process.platform === 'win32' && child.pid) {
    try { require('child_process').spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); return; } catch {}
  }
  try { child.kill(); } catch {}
}

function readJsonSafe(file, dflt) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return dflt; }
}

module.exports = { HOME, walk, sigOf, mtimeOf, baseName, pbDecode, pbTry, pbGet, pbAll, readJsonSafe, killTree };
