// Store format and tar helpers. This file runs in the page and in the Node CLI.
'use strict';

var QUINE_STORE_VERSION = 1;
var QUINE_SYSTEM_TITLE = '$:/quine/system';
var QUINE_BINARY_TYPE = 'application/octet-stream;base64';
var QUINE_DIR_TYPE = 'directory';

var quineUtf8Strict = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

// Returns the text if the bytes are strictly valid UTF-8, else null.
function quineDecodeText(bytes) {
  try { return quineUtf8Strict.decode(bytes); } catch (e) { return null; }
}

function quineBytesToBase64(bytes) {
  var s = '';
  for (var i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

function quineBase64ToBytes(b64) {
  var s = atob(b64);
  var out = new Uint8Array(s.length);
  for (var i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

// One glob to a RegExp over a path relative to the prefix: ** crosses "/", * and ? do not.
function quineGlob(glob) {
  var re = '';
  for (var i = 0; i < glob.length; i++) {
    var c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      i++;
      if (glob[i + 1] === '/') { i++; re += '(?:.*/)?'; } else re += '.*';
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp('^' + re + '$');
}

// filter = { prefix, include: [globs], exclude: [globs] }. Returns a test for an absolute path.
function quineFilter(filter) {
  var inc = filter.include.map(quineGlob);
  var exc = filter.exclude.map(quineGlob);
  var prefix = filter.prefix;
  return function (path) {
    if (path.indexOf(prefix + '/') !== 0) return false;
    var rel = path.slice(prefix.length + 1);
    var parts = rel.split('/');
    if (parts.some(function (p) { return p === '' || p === '.' || p === '..'; })) return false;
    for (var i = 1; i <= parts.length; i++) {
      var sub = parts.slice(0, i).join('/');
      if (exc.some(function (r) { return r.test(sub); })) return false;
    }
    return inc.some(function (r) { return r.test(rel); });
  };
}

// entries: [{ path, dir: true } | { path, bytes }]. Returns tiddler objects.
function quineTiddlers(entries) {
  return entries.map(function (e) {
    if (e.dir) return { title: e.path, type: QUINE_DIR_TYPE };
    var text = quineDecodeText(e.bytes);
    if (text !== null) return { title: e.path, text: text };
    return { title: e.path, type: QUINE_BINARY_TYPE, text: quineBytesToBase64(e.bytes) };
  });
}

// The store block body: a JSON array, one tiddler per line, "<" escaped.
function quineSerialize(tiddlers) {
  var lines = tiddlers.map(function (t) {
    return JSON.stringify(t).replace(/</g, '\\u003c');
  });
  return '[\n' + lines.join(',\n') + '\n]';
}

// Fill each @@QUINE_BLOCK:id@@ in the template in one pass, so inserted text is never rescanned.
function quineAssemble(template, blocks) {
  return template.replace(/@@QUINE_BLOCK:([a-z-]+)@@/g, function (m, id) {
    if (!(id in blocks)) throw new Error('no block for ' + id);
    return blocks[id];
  });
}

// Minimal ustar. entries: [{ name, dir: true } | { name, bytes }].
function quineTarWrite(entries) {
  var enc = new TextEncoder();
  var chunks = [];
  var skipped = [];
  entries.forEach(function (e) {
    var name = e.dir ? e.name + '/' : e.name;
    var split = quineTarSplit(enc.encode(name));
    if (!split) { skipped.push(e.name); return; }
    var size = e.dir ? 0 : e.bytes.length;
    var h = new Uint8Array(512);
    h.set(split.name, 0);
    quineTarOctal(h, 100, 8, e.dir ? 493 : 420);
    quineTarOctal(h, 108, 8, 0);
    quineTarOctal(h, 116, 8, 0);
    quineTarOctal(h, 124, 12, size);
    quineTarOctal(h, 136, 12, Math.floor(Date.now() / 1000));
    h[156] = e.dir ? 53 : 48;
    h.set(enc.encode('ustar\u000000'), 257);
    h.set(split.prefix, 345);
    for (var i = 148; i < 156; i++) h[i] = 32;
    var sum = 0;
    for (i = 0; i < 512; i++) sum += h[i];
    quineTarOctal(h, 148, 7, sum);
    chunks.push(h);
    if (size) {
      chunks.push(e.bytes);
      if (size % 512) chunks.push(new Uint8Array(512 - (size % 512)));
    }
  });
  chunks.push(new Uint8Array(1024));
  var total = chunks.reduce(function (n, c) { return n + c.length; }, 0);
  var out = new Uint8Array(total);
  var off = 0;
  chunks.forEach(function (c) { out.set(c, off); off += c.length; });
  return { bytes: out, skipped: skipped };
}

function quineTarOctal(h, off, len, value) {
  var s = value.toString(8);
  while (s.length < len - 1) s = '0' + s;
  for (var i = 0; i < len - 1; i++) h[off + i] = s.charCodeAt(i);
}

// Split a name into ustar name (<=100 bytes) and prefix (<=155 bytes) at a "/".
function quineTarSplit(b) {
  if (b.length <= 100) return { name: b, prefix: new Uint8Array(0) };
  for (var i = b.length - 101; i < b.length && i <= 155; i++) {
    if (i >= 0 && b[i] === 47) return { name: b.subarray(i + 1), prefix: b.subarray(0, i) };
  }
  return null;
}

// Reads the files and directories of a ustar archive.
function quineTarRead(bytes) {
  var dec = new TextDecoder();
  var str = function (off, len) {
    var end = off;
    while (end < off + len && bytes[end]) end++;
    return dec.decode(bytes.subarray(off, end));
  };
  var out = [];
  for (var off = 0; off + 512 <= bytes.length;) {
    if (!bytes[off]) break;
    var name = str(off, 100);
    var prefix = str(off + 345, 155);
    if (prefix) name = prefix + '/' + name;
    var size = parseInt(str(off + 124, 12), 8) || 0;
    var type = bytes[off + 156];
    off += 512;
    if (type === 53) out.push({ name: name.replace(/\/$/, ''), dir: true });
    else if (type === 48 || type === 0) out.push({ name: name, bytes: bytes.slice(off, off + size) });
    off += Math.ceil(size / 512) * 512;
  }
  return out;
}

if (typeof module !== 'undefined') {
  module.exports = {
    QUINE_STORE_VERSION, QUINE_SYSTEM_TITLE, QUINE_BINARY_TYPE, QUINE_DIR_TYPE,
    quineDecodeText, quineBytesToBase64, quineBase64ToBytes, quineFilter, quineTiddlers,
    quineSerialize, quineAssemble, quineTarWrite, quineTarRead,
  };
}
