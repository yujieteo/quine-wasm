// nvim.html: runs Neovim (Wasm, `nvim --embed`) and draws its UI in xterm.js.
// The user's files live in the #store block. Save writes a new copy of this
// page with the current files in a new #store block.
'use strict';
(async () => {
  const HOME = '/home/user';
  const WORK = HOME + '/work';
  const RUNTIME_DIR = '/usr/share/nvim/runtime';
  const STORE_VERSION = 1;
  // Test control only: the acceptance test sets it to true. Files then live in
  // IndexedDB, like Emscripten's IDBFS, and not in the saved page.
  const CONTROL_IDBFS = false;
  const LIMITS = { file: 32 << 20, total: 256 << 20, count: 20000, page: 1 << 30 };
  const t0 = performance.now();
  const $ = (id) => document.getElementById(id);
  const setStatus = (msg) => { $('status').textContent = msg; };
  const utf8 = new TextEncoder();
  const utf8d = new TextDecoder();
  const strictUtf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

  // ---- base64 -------------------------------------------------------------

  function b64encode(bytes) {
    if (bytes.toBase64) return bytes.toBase64();
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
      s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(s);
  }

  function b64decode(text) {
    if (Uint8Array.fromBase64) return Uint8Array.fromBase64(text.trim());
    const s = atob(text.trim());
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  }

  // ---- msgpack --------------------------------------------------------------

  function mpEncode(value) {
    let buf = new Uint8Array(256);
    let view = new DataView(buf.buffer);
    let n = 0;
    const need = (k) => {
      if (n + k <= buf.length) return;
      const b = new Uint8Array(Math.max(buf.length * 2, n + k));
      b.set(buf);
      buf = b;
      view = new DataView(buf.buffer);
    };
    const u8 = (x) => { need(1); buf[n++] = x; };
    const u16 = (t, x) => { need(3); buf[n++] = t; view.setUint16(n, x); n += 2; };
    const u32 = (t, x) => { need(5); buf[n++] = t; view.setUint32(n, x); n += 4; };
    const put = (bytes) => { need(bytes.length); buf.set(bytes, n); n += bytes.length; };
    const header = (len, fix, fixMax, t8, t16, t32) => {
      if (fix !== null && len <= fixMax) u8(fix | len);
      else if (t8 !== null && len < 0x100) { u8(t8); u8(len); }
      else if (len < 0x10000) u16(t16, len);
      else u32(t32, len);
    };
    const enc = (v) => {
      if (v === null || v === undefined) u8(0xc0);
      else if (v === false) u8(0xc2);
      else if (v === true) u8(0xc3);
      else if (typeof v === 'number') {
        if (Number.isInteger(v) && v >= 0 && v < 0x100000000) {
          if (v < 0x80) u8(v);
          else if (v < 0x100) { u8(0xcc); u8(v); }
          else if (v < 0x10000) u16(0xcd, v);
          else u32(0xce, v);
        } else if (Number.isInteger(v) && v < 0 && v >= -0x80000000) {
          if (v >= -32) u8(v & 0xff);
          else { need(5); buf[n++] = 0xd2; view.setInt32(n, v); n += 4; }
        } else { need(9); buf[n++] = 0xcb; view.setFloat64(n, v); n += 8; }
      } else if (typeof v === 'string') {
        const b = utf8.encode(v);
        header(b.length, 0xa0, 31, 0xd9, 0xda, 0xdb);
        put(b);
      } else if (v instanceof Uint8Array) {
        header(v.length, null, 0, 0xc4, 0xc5, 0xc6);
        put(v);
      } else if (Array.isArray(v)) {
        header(v.length, 0x90, 15, null, 0xdc, 0xdd);
        v.forEach(enc);
      } else {
        const keys = Object.keys(v);
        header(keys.length, 0x80, 15, null, 0xde, 0xdf);
        for (const k of keys) { enc(k); enc(v[k]); }
      }
    };
    enc(value);
    return buf.subarray(0, n);
  }

  const MORE = Symbol('need more bytes');

  // Streaming decoder: push() bytes as they come, onMessage() gets each value.
  class MpDecoder {
    constructor(onMessage) {
      this.onMessage = onMessage;
      this.buf = new Uint8Array(0);
    }

    push(chunk) {
      if (this.buf.length) {
        const b = new Uint8Array(this.buf.length + chunk.length);
        b.set(this.buf);
        b.set(chunk, this.buf.length);
        this.buf = b;
      } else {
        this.buf = chunk;
      }
      while (this.buf.length) {
        this.pos = 0;
        this.view = new DataView(this.buf.buffer, this.buf.byteOffset, this.buf.byteLength);
        let msg;
        try {
          msg = this.read();
        } catch (e) {
          if (e === MORE) return;
          throw e;
        }
        this.buf = this.buf.subarray(this.pos);
        this.onMessage(msg);
      }
    }

    need(k) { if (this.pos + k > this.buf.length) throw MORE; }
    bytes(len) { this.need(len); const b = this.buf.subarray(this.pos, this.pos + len); this.pos += len; return b; }
    str(len) { return utf8d.decode(this.bytes(len)); }
    arr(len) { const a = new Array(len); for (let i = 0; i < len; i++) a[i] = this.read(); return a; }
    map(len) { const m = {}; for (let i = 0; i < len; i++) { const k = this.read(); m[k] = this.read(); } return m; }
    ext(len) { this.need(1); const type = this.view.getInt8(this.pos++); return { ext: type, data: this.bytes(len) }; }
    num(size, get) { this.need(size); const v = get.call(this.view, this.pos); this.pos += size; return v; }

    read() {
      const v = this.view;
      this.need(1);
      const t = this.buf[this.pos++];
      if (t < 0x80) return t;
      if (t < 0x90) return this.map(t & 0x0f);
      if (t < 0xa0) return this.arr(t & 0x0f);
      if (t < 0xc0) return this.str(t & 0x1f);
      if (t >= 0xe0) return t - 0x100;
      switch (t) {
        case 0xc0: return null;
        case 0xc2: return false;
        case 0xc3: return true;
        case 0xc4: return this.bytes(this.num(1, v.getUint8));
        case 0xc5: return this.bytes(this.num(2, v.getUint16));
        case 0xc6: return this.bytes(this.num(4, v.getUint32));
        case 0xc7: return this.ext(this.num(1, v.getUint8));
        case 0xc8: return this.ext(this.num(2, v.getUint16));
        case 0xc9: return this.ext(this.num(4, v.getUint32));
        case 0xca: return this.num(4, v.getFloat32);
        case 0xcb: return this.num(8, v.getFloat64);
        case 0xcc: return this.num(1, v.getUint8);
        case 0xcd: return this.num(2, v.getUint16);
        case 0xce: return this.num(4, v.getUint32);
        case 0xcf: return Number(this.num(8, v.getBigUint64));
        case 0xd0: return this.num(1, v.getInt8);
        case 0xd1: return this.num(2, v.getInt16);
        case 0xd2: return this.num(4, v.getInt32);
        case 0xd3: return Number(this.num(8, v.getBigInt64));
        case 0xd4: return this.ext(1);
        case 0xd5: return this.ext(2);
        case 0xd6: return this.ext(4);
        case 0xd7: return this.ext(8);
        case 0xd8: return this.ext(16);
        case 0xd9: return this.str(this.num(1, v.getUint8));
        case 0xda: return this.str(this.num(2, v.getUint16));
        case 0xdb: return this.str(this.num(4, v.getUint32));
        case 0xdc: return this.arr(this.num(2, v.getUint16));
        case 0xdd: return this.arr(this.num(4, v.getUint32));
        case 0xde: return this.map(this.num(2, v.getUint16));
        case 0xdf: return this.map(this.num(4, v.getUint32));
        default: throw new Error('msgpack: bad type byte 0x' + t.toString(16));
      }
    }
  }

  // ---- tar (ustar) ------------------------------------------------------------

  function untar(buf) {
    const out = [];
    for (let off = 0; off + 512 <= buf.length;) {
      const h = buf.subarray(off, off + 512);
      if (h[0] === 0) break;
      const field = (a, n) => {
        const s = utf8d.decode(h.subarray(a, a + n));
        const z = s.indexOf('\0');
        return z < 0 ? s : s.slice(0, z);
      };
      const size = parseInt(field(124, 12).trim() || '0', 8);
      const type = h[156] ? String.fromCharCode(h[156]) : '0';
      const prefix = field(345, 155);
      const name = (prefix ? prefix + '/' : '') + field(0, 100);
      off += 512;
      if (type === '0') out.push({ path: name, data: buf.subarray(off, off + size) });
      else if (type === '5') out.push({ path: name.replace(/\/$/, ''), dir: true });
      off += Math.ceil(size / 512) * 512;
    }
    return out;
  }

  function tar(entries) {
    const parts = [];
    const mtime = Math.floor(Date.now() / 1000);
    const octal = (x, len) => x.toString(8).padStart(len - 1, '0') + '\0';
    const header = (name, size, type) => {
      const h = new Uint8Array(512);
      const put = (s, off, len) => h.set(utf8.encode(s).subarray(0, len), off);
      let prefix = '';
      if (utf8.encode(name).length > 100) {
        const cut = name.lastIndexOf('/', name.length - 1);
        for (let i = cut; i > 0; i = name.lastIndexOf('/', i - 1)) {
          if (utf8.encode(name.slice(0, i)).length <= 155 && utf8.encode(name.slice(i + 1)).length <= 100) {
            prefix = name.slice(0, i);
            name = name.slice(i + 1);
            break;
          }
        }
      }
      put(name, 0, 100);
      put(type === '5' ? '0000755\0' : '0000644\0', 100, 8);
      put('0000000\0', 108, 8);
      put('0000000\0', 116, 8);
      put(octal(size, 12), 124, 12);
      put(octal(mtime, 12), 136, 12);
      put('        ', 148, 8);
      put(type, 156, 1);
      put('ustar\0', 257, 6);
      put('00', 263, 2);
      put(prefix, 345, 155);
      let sum = 0;
      for (const b of h) sum += b;
      put(octal(sum, 7) + ' ', 148, 8);
      return h;
    };
    const pad = (size) => new Uint8Array((512 - (size % 512)) % 512);
    for (const e of entries) {
      let name = e.dir ? e.path + '/' : e.path;
      if (tooLong(name)) {
        // A pax header carries a path that does not fit the ustar fields.
        const rec = (len) => `${len} path=${name}\n`;
        let len = utf8.encode(rec(0)).length;
        while (utf8.encode(rec(len)).length !== len) len = utf8.encode(rec(len)).length;
        const body = utf8.encode(rec(len));
        parts.push(header('PaxHeader', body.length, 'x'), body, pad(body.length));
        name = name.slice(-100);
      }
      const data = e.dir ? new Uint8Array(0) : e.data;
      parts.push(header(name, data.length, e.dir ? '5' : '0'), data, pad(data.length));
    }
    parts.push(new Uint8Array(1024));
    return new Blob(parts, { type: 'application/x-tar' });

    function tooLong(name) {
      if (utf8.encode(name).length <= 100) return false;
      for (let i = name.lastIndexOf('/', name.length - 1); i > 0; i = name.lastIndexOf('/', i - 1)) {
        if (utf8.encode(name.slice(0, i)).length <= 155 && utf8.encode(name.slice(i + 1)).length <= 100) return false;
      }
      return true;
    }
  }

  // ---- store ----------------------------------------------------------------

  const storeEl = $('store');
  const filter = JSON.parse(storeEl.dataset.filter);
  const globRe = (g) => new RegExp('^' + g.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\0').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]').replace(/\0/g, '.*') + '$');
  const includeRe = filter.include.map(globRe);
  const excludeRe = filter.exclude.map(globRe);
  const inFilter = (rel) => includeRe.some((r) => r.test(rel)) && !excludeRe.some((r) => r.test(rel));
  const validTitle = (t) => typeof t === 'string' && t !== '' && !t.startsWith('/') &&
    !t.split('/').some((s) => s === '' || s === '.' || s === '..');

  // Returns {files, refused}. files: [{path, data} | {path, dir: true}], paths relative to HOME.
  function loadStore() {
    const version = Number(storeEl.dataset.version);
    if (!(version <= STORE_VERSION)) {
      console.warn(`store version ${version} is newer than ${STORE_VERSION}: not loaded, kept as is`);
      return { files: [], refused: true };
    }
    let tiddlers;
    try {
      tiddlers = JSON.parse(storeEl.textContent);
    } catch (e) {
      console.warn('store: bad JSON, not loaded', e);
      return { files: [], refused: true };
    }
    const files = [];
    let total = 0;
    for (const t of tiddlers) {
      const dir = t && t.type === 'directory';
      const title = t && (dir ? String(t.title).replace(/\/$/, '') : t.title);
      if (!validTitle(title) || !inFilter(title)) { console.warn('store: skipped entry', t && t.title); continue; }
      if (files.length >= LIMITS.count) { console.warn('store: too many entries, skipped', title); continue; }
      if (dir) { files.push({ path: title, dir: true }); continue; }
      if (typeof t.text !== 'string') { console.warn('store: skipped entry without text', title); continue; }
      let data;
      try {
        data = t.type === 'application/octet-stream' ? b64decode(t.text) : utf8.encode(t.text);
      } catch (e) {
        console.warn('store: skipped bad base64', title);
        continue;
      }
      if (data.length > LIMITS.file || total + data.length > LIMITS.total) {
        console.warn('store: skipped entry over the size cap', title);
        continue;
      }
      total += data.length;
      files.push({ path: title, data });
    }
    return { files, refused: false };
  }

  function serializeStore(files) {
    const lines = files.map((f) => {
      if (f.dir) return JSON.stringify({ title: f.path + '/', type: 'directory' });
      try {
        return JSON.stringify({ title: f.path, text: strictUtf8.decode(f.data) });
      } catch (e) {
        return JSON.stringify({ title: f.path, type: 'application/octet-stream', text: b64encode(f.data) });
      }
    });
    return ('[\n' + lines.join(',\n') + '\n]').replace(/</g, '\\u003c');
  }

  // Reads the files under HOME. Keeps directories only when they are empty.
  function snapshot(FS, useFilter) {
    const out = [];
    const walk = (dir, rel) => {
      let empty = true;
      for (const name of FS.readdir(dir)) {
        if (name === '.' || name === '..') continue;
        const path = dir + '/' + name;
        const r = rel ? rel + '/' + name : name;
        const mode = FS.lstat(path).mode;
        if (FS.isDir(mode)) {
          empty = false;
          if (walk(path, r) && (!useFilter || inFilter(r))) out.push({ path: r, dir: true });
        } else if (FS.isFile(mode)) {
          empty = false;
          if (!useFilter || inFilter(r)) out.push({ path: r, data: FS.readFile(path) });
        }
      }
      return empty;
    };
    walk(HOME, '');
    return out;
  }

  function restore(FS, files, root) {
    for (const f of files) {
      const path = root + '/' + f.path;
      if (f.dir) { FS.mkdirTree(path); continue; }
      FS.mkdirTree(path.slice(0, path.lastIndexOf('/')));
      FS.writeFile(path, f.data);
    }
  }

  function fnv1a(s) {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
    return h >>> 0;
  }

  // ---- screen: Neovim grid -> xterm.js ---------------------------------------

  const term = new Terminal({
    fontFamily: 'Menlo, Consolas, "DejaVu Sans Mono", "Liberation Mono", monospace',
    fontSize: 14,
    scrollback: 0,
    allowProposedApi: true,
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open($('term'));

  const hex = (c) => '#' + c.toString(16).padStart(6, '0');
  const rgb = (c) => `${(c >> 16) & 255};${(c >> 8) & 255};${c & 255}`;
  const CURSOR = { block: 2, horizontal: 4, vertical: 6 };

  const screen = {
    cols: 0, rows: 0, text: [], hl: [], dirty: new Set(),
    attrs: new Map(), sgr: new Map(), fg: 0xffffff, bg: 0x000000, sp: 0xff0000,
    row: 0, col: 0, modes: [], mode: 0, busy: false, flushed: 0,

    resize(cols, rows) {
      this.cols = cols;
      this.rows = rows;
      this.text = Array.from({ length: rows }, () => new Array(cols).fill(' '));
      this.hl = Array.from({ length: rows }, () => new Array(cols).fill(0));
      for (let r = 0; r < rows; r++) this.dirty.add(r);
      if (term.cols !== cols || term.rows !== rows) term.resize(cols, rows);
    },

    style(id) {
      let s = this.sgr.get(id);
      if (s) return s;
      const a = this.attrs.get(id) || {};
      let fg = a.foreground ?? this.fg;
      let bg = a.background ?? this.bg;
      if (a.reverse) [fg, bg] = [bg, fg];
      s = '\x1b[0';
      if (a.bold) s += ';1';
      if (a.italic) s += ';3';
      if (a.undercurl) s += ';4:3';
      else if (a.underdouble) s += ';4:2';
      else if (a.underdotted) s += ';4:4';
      else if (a.underdashed) s += ';4:5';
      else if (a.underline) s += ';4';
      if (a.strikethrough) s += ';9';
      s += `;38;2;${rgb(fg)};48;2;${rgb(bg)}`;
      if (a.special !== undefined) s += `;58;2;${rgb(a.special)}`;
      s += 'm';
      this.sgr.set(id, s);
      return s;
    },

    // One "redraw" notification: a list of [event, ...argument tuples].
    redraw(batch) {
      for (const [name, ...calls] of batch) {
        const fn = this.events[name];
        if (fn) for (const args of calls) fn.apply(this, args);
      }
    },

    events: {
      grid_resize(grid, cols, rows) { this.resize(cols, rows); },
      default_colors_set(fg, bg, sp) {
        if (fg >= 0) this.fg = fg;
        if (bg >= 0) this.bg = bg;
        if (sp >= 0) this.sp = sp;
        this.sgr.clear();
        term.options.theme = { foreground: hex(this.fg), background: hex(this.bg), cursor: hex(this.fg) };
        document.body.style.background = hex(this.bg);
        for (let r = 0; r < this.rows; r++) this.dirty.add(r);
      },
      hl_attr_define(id, attrs) { this.attrs.set(id, attrs); this.sgr.delete(id); },
      grid_line(grid, row, col, cells) {
        const text = this.text[row];
        const hls = this.hl[row];
        if (!text) return;
        let hl = 0;
        for (const cell of cells) {
          if (cell.length > 1) hl = cell[1];
          const repeat = cell.length > 2 ? cell[2] : 1;
          for (let i = 0; i < repeat && col < this.cols; i++, col++) {
            text[col] = cell[0];
            hls[col] = hl;
          }
        }
        this.dirty.add(row);
      },
      grid_clear() { this.resize(this.cols, this.rows); },
      grid_cursor_goto(grid, row, col) { this.row = row; this.col = col; },
      grid_scroll(grid, top, bot, left, right, rows) {
        const copy = (to, from) => {
          for (let c = left; c < right; c++) {
            this.text[to][c] = this.text[from][c];
            this.hl[to][c] = this.hl[from][c];
          }
        };
        if (rows > 0) for (let r = top; r + rows < bot; r++) copy(r, r + rows);
        else for (let r = bot - 1; r + rows >= top; r--) copy(r, r + rows);
        for (let r = top; r < bot; r++) this.dirty.add(r);
      },
      mode_info_set(enabled, modes) { this.modes = modes; },
      mode_change(name, idx) { this.mode = idx; },
      busy_start() { this.busy = true; },
      busy_stop() { this.busy = false; },
      set_title(title) { document.title = title || 'nvim.html'; },
      flush() { this.paint(); },
    },

    paint() {
      let out = '\x1b[?25l';
      for (const r of this.dirty) {
        const text = this.text[r];
        const hls = this.hl[r];
        if (!text) continue;
        out += `\x1b[${r + 1};1H`;
        let cur = -1;
        for (let c = 0; c < this.cols; c++) {
          if (text[c] === '') continue; // right half of a wide character
          if (hls[c] !== cur) { cur = hls[c]; out += this.style(cur); }
          out += text[c];
        }
      }
      this.dirty.clear();
      const shape = CURSOR[this.modes[this.mode]?.cursor_shape] || 2;
      out += `\x1b[0m\x1b[${this.row + 1};${this.col + 1}H\x1b[${shape} q`;
      if (!this.busy) out += '\x1b[?25h';
      term.write(out);
      if (!this.flushed++) setStatus(`Ready in ${Math.round(performance.now() - t0)} ms`);
    },

    lines() { return this.text.map((row) => row.join('')); },
  };

  // ---- keys -------------------------------------------------------------------

  const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
  const SPECIAL = {
    Escape: 'Esc', Enter: 'CR', Backspace: 'BS', Tab: 'Tab', Delete: 'Del', Insert: 'Insert',
    Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown',
    ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
  };
  const MODIFIERS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'NumLock', 'AltGraph', 'OS']);

  // Returns Neovim key notation, '' for a key to drop, or null to let the browser have it.
  function keyToInput(e) {
    if (e.isComposing || e.key === 'Process' || e.key === 'Dead' || e.key === 'Unidentified') return null;
    if (MODIFIERS.has(e.key)) return '';
    if (e.metaKey) return null; // Cmd shortcuts stay with the browser (copy, paste)
    if (!isMac && e.ctrlKey && e.shiftKey && e.code === 'KeyV') return null; // paste
    const altGr = !isMac && e.getModifierState('AltGraph') && [...e.key].length === 1;
    let mods = altGr ? '' : (e.ctrlKey ? 'C-' : '') + (e.altKey ? 'M-' : '');
    const name = SPECIAL[e.key] || (/^F\d{1,2}$/.test(e.key) ? e.key : null);
    if (name) return `<${e.shiftKey ? 'S-' : ''}${mods}${name}>`;
    if ([...e.key].length !== 1) return null;
    let ch = e.key;
    if (e.altKey && isMac && /^Key[A-Z]$/.test(e.code)) {
      ch = e.shiftKey ? e.code[3] : e.code[3].toLowerCase(); // Option+letter types a symbol on macOS
    }
    if (ch === ' ' && mods) ch = 'Space';
    if (ch === '<') return `<${mods}lt>`;
    return mods ? `<${mods}${ch}>` : ch;
  }

  // ---- Neovim instance --------------------------------------------------------

  let nvim = null; // the running instance: {FS, request, notify}
  let carried = null; // files carried over after Neovim exits
  let dirty = false;
  let savedHash = 0;
  let pendingSave = false;
  let storeRefused = false;

  function startNvim(files, runtime) {
    let nextId = 1;
    const pending = new Map();
    const input = [];
    let inputNode = null;
    let stderr = '';

    const send = (msg) => {
      input.push(mpEncode(msg));
      inputNode?.notifyListeners(1); // POLLIN: wake Neovim's poll()
    };
    const request = (method, params) => new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      send([0, id, method, params]);
    });
    const notify = (method, params) => send([2, method, params]);

    const decoder = new MpDecoder((msg) => {
      if (msg[0] === 1) {
        const p = pending.get(msg[1]);
        pending.delete(msg[1]);
        if (msg[2]) p?.reject(new Error(Array.isArray(msg[2]) ? msg[2][1] : String(msg[2])));
        else p?.resolve(msg[3]);
      } else if (msg[0] === 2 && msg[1] === 'redraw') {
        screen.redraw(msg[2]);
      } else if (msg[0] === 2 && msg[1] === 'nvim_html') {
        if (msg[2][0] === 'save') requestSave(true);
      } else if (msg[0] === 0) {
        send([1, msg[1], [0, 'nvim.html handles no requests'], null]);
      }
    });

    // Neovim talks msgpack-RPC on fd 0 and 1. These stream ops replace the
    // default stdio devices: reads never block (EAGAIN), poll() reports input.
    const rpcOps = {
      read(stream, buffer, offset, length) {
        if (!input.length) throw new instance.FS.ErrnoError(6); // EAGAIN
        let n = 0;
        while (n < length && input.length) {
          const chunk = input[0];
          const k = Math.min(chunk.length, length - n);
          buffer.set(chunk.subarray(0, k), offset + n);
          n += k;
          if (k === chunk.length) input.shift();
          else input[0] = chunk.subarray(k);
        }
        return n;
      },
      write(stream, buffer, offset, length) {
        decoder.push(new Uint8Array(buffer.buffer, buffer.byteOffset + offset, length).slice());
        return length;
      },
      poll() { return (input.length ? 1 : 0) | 4; }, // POLLIN | POLLOUT
    };

    let instance = null;
    const startedAt = performance.now();
    return createNvim({
      arguments: ['--embed'],
      preRun: [(M) => {
        instance = M;
        const { FS, ENV } = M;
        ENV.HOME = HOME;
        ENV.USER = 'user';
        ENV.VIMRUNTIME = RUNTIME_DIR;
        ENV.LANG = 'C.UTF-8';
        restore(FS, runtime, RUNTIME_DIR);
        restore(FS, files, HOME);
        FS.mkdirTree(WORK);
        FS.chdir(WORK);
        FS.init(() => undefined, () => {}, (c) => {
          if (c === 10) { console.log('nvim:', stderr); stderr = ''; } else if (c !== null) stderr += String.fromCharCode(c);
        });
        for (const fd of [0, 1]) FS.getStream(fd).stream_ops = rpcOps;
        inputNode = FS.getStream(0).node;
        trackDirty(FS);
      }],
      print: (s) => console.log('nvim:', s),
      printErr: (s) => console.log('nvim:', s),
      onExit: (code) => {
        carried = snapshot(instance.FS, false);
        nvim = null;
        setStatus(`Neovim exited (${code}). Your files stay in this page.`);
        $('run').hidden = false;
        $('run').focus();
      },
    }).then((M) => {
      nvim = { FS: M.FS, request, notify };
      console.log(`nvim: engine ready in ${Math.round(performance.now() - startedAt)} ms`);
      return nvim;
    });
  }

  // Marks the page dirty when Neovim changes a file under HOME.
  function trackDirty(FS) {
    const under = (p) => typeof p === 'string' && (p === HOME || p.startsWith(HOME + '/'));
    const wrap = (name, pathOf) => {
      const orig = FS[name];
      FS[name] = function (...args) {
        if (under(pathOf(...args))) dirty = true;
        return orig.apply(this, args);
      };
    };
    wrap('write', (stream) => stream.path);
    wrap('truncate', (p) => (typeof p === 'string' ? p : FS.getPath(p)));
    for (const name of ['mknod', 'rename', 'unlink', 'rmdir', 'symlink']) wrap(name, (p) => p);
  }

  async function attach() {
    const { cols, rows } = size();
    screen.resize(cols, rows);
    await nvim.request('nvim_ui_attach', [cols, rows, { ext_linegrid: true, rgb: true }]);
    term.focus();
  }

  function size() {
    const d = fit.proposeDimensions();
    return d && d.cols > 1 && d.rows > 1 ? { cols: d.cols, rows: d.rows } : { cols: 80, rows: 24 };
  }

  // ---- save, export, run again ------------------------------------------------

  function currentFiles(FS, useFilter) {
    if (FS) return snapshot(FS, useFilter);
    const files = carried || [];
    return useFilter ? files.filter((f) => inFilter(f.path)) : files;
  }

  async function flushNvim() {
    if (!nvim) return;
    // Neovim answers no request while it waits for a key (a prompt, getchar()).
    const timeout = new Promise((resolve) => setTimeout(resolve, 2000));
    await Promise.race([nvim.request('nvim_exec_lua', ['_G.nvim_html_flush()', []]).catch(() => {}), timeout]);
  }

  function download(name, blob) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Fallback where a download does not start (some iOS browsers): open the copy.
    $('status').replaceChildren(`Downloaded ${name} `, Object.assign(document.createElement('a'), {
      href: url, target: '_blank', textContent: '(open)', style: 'color: inherit',
    }));
    setTimeout(() => URL.revokeObjectURL(url), 10 * 60 * 1000);
  }

  function pageName() {
    const file = decodeURIComponent(location.pathname.split('/').pop() || 'nvim.html');
    return file.replace(/\.html?$/i, '').replace(/-[0-9a-f]{8}-r\d+-\d{8}T\d{6}$/, '') || 'nvim';
  }

  // Deferred until a user gesture when Neovim asks without one (:HtmlSave from a timer).
  function requestSave(fromApi) {
    if (fromApi && navigator.userActivation && !navigator.userActivation.isActive) {
      pendingSave = true;
      $('save').classList.add('pending');
      setStatus('Click Save to download the copy');
      return;
    }
    save();
  }

  async function save() {
    pendingSave = false;
    $('save').classList.remove('pending');
    if (storeRefused) {
      setStatus('Save is off: this page has a newer store format');
      return;
    }
    await flushNvim();
    const files = currentFiles(nvim?.FS, true);
    if (CONTROL_IDBFS) await controlDb('readwrite', (s) => s.put(files, 'home')).catch(() => {});
    const body = serializeStore(CONTROL_IDBFS ? [] : files);
    const lineage = storeEl.dataset.lineage || Array.from(crypto.getRandomValues(new Uint8Array(4)),
      (b) => b.toString(16).padStart(2, '0')).join('');
    const revision = Number(storeEl.dataset.revision || 0) + 1;
    const block = `<script type="application/json" id="store" data-version="${STORE_VERSION}"` +
      ` data-filter="${storeEl.dataset.filter.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}"` +
      ` data-lineage="${lineage}" data-revision="${revision}">${body}<\/script>`;
    const shell = JSON.parse($('shell').textContent);
    const html = shell.replace(/\x3c!--@([a-z-]+)--\x3e/g, (m, id) => (id === 'store' ? block : $(id).outerHTML));
    if (html.length > LIMITS.page) {
      setStatus(`Save refused: the page would be ${Math.round(html.length / 1e6)} MB`);
      return;
    }
    const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15);
    download(`${pageName()}-${lineage}-r${revision}-${stamp}.html`, new Blob([html], { type: 'text/html' }));
    storeEl.dataset.lineage = lineage;
    storeEl.dataset.revision = String(revision);
    savedHash = fnv1a(body);
    dirty = false;
  }

  function controlDb(mode, op) {
    return new Promise((resolve, reject) => {
      const open = indexedDB.open('nvim-html-control', 1);
      open.onupgradeneeded = () => open.result.createObjectStore('fs');
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const req = op(open.result.transaction('fs', mode).objectStore('fs'));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      };
    });
  }

  async function exportTar() {
    await flushNvim();
    download('nvim-home.tar', tar(currentFiles(nvim?.FS, true)));
  }

  async function run(files) {
    $('run').hidden = true;
    setStatus('Starting…');
    await startNvim(files, runtime);
    await attach();
  }

  // Keys go back to Neovim after a click; a focused button would take Enter.
  $('save').addEventListener('click', () => { term.focus(); save(); });
  $('export').addEventListener('click', () => { term.focus(); exportTar(); });
  $('run').addEventListener('click', () => run(carried));
  $('term').addEventListener('click', () => term.focus());
  window.addEventListener('beforeunload', (e) => {
    if (!dirty) return;
    if (fnv1a(serializeStore(currentFiles(nvim?.FS, true))) === savedHash) return;
    e.preventDefault();
    e.returnValue = '';
  });

  term.attachCustomKeyEventHandler((e) => {
    // Keys go to Neovim on keydown only; keypress would type them twice.
    if (e.type !== 'keydown' || !nvim) return false;
    if (pendingSave) save();
    const key = keyToInput(e);
    if (key === null) return true;
    e.preventDefault();
    if (key) nvim.request('nvim_input', [key]);
    return false;
  });
  // Text that does not come from keydown: paste and input methods.
  term.onData((data) => {
    if (!nvim) return;
    if (data.length > 1) nvim.request('nvim_paste', [data.replace(/\r\n?/g, '\n'), true, -1]);
    else nvim.request('nvim_input', [data === '<' ? '<lt>' : data]);
  });
  new ResizeObserver(() => {
    const { cols, rows } = size();
    if (nvim && screen.cols && (cols !== screen.cols || rows !== screen.rows)) {
      nvim.request('nvim_ui_try_resize', [cols, rows]);
    }
  }).observe($('term'));

  // ---- boot -------------------------------------------------------------------

  const gz = b64decode($('runtime').textContent);
  const tarBytes = new Uint8Array(await new Response(
    new Blob([gz]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
  const runtime = untar(tarBytes);
  const store = loadStore();
  storeRefused = store.refused;
  carried = store.files;
  savedHash = fnv1a(serializeStore(store.files));

  // Test and automation hook.
  window.nvimHtml = {
    save, exportTar, lines: () => screen.lines(),
    request: (method, params) => nvim.request(method, params),
    get running() { return !!nvim; },
    get flushes() { return screen.flushed; },
  };

  if (CONTROL_IDBFS) carried = (await controlDb('readonly', (s) => s.get('home')).catch(() => null)) || carried;
  await run(carried);
})().catch((e) => {
  console.error(e);
  document.getElementById('status').textContent = 'Error: ' + e.message;
});
