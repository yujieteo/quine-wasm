// Page runtime: terminal, store restore and save, file panel, tar export, Run again.
// The build puts src/store.js in front of this file.
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var config = JSON.parse($('quine-config').textContent);
  var storeEl = $('quine-store');
  var filter = JSON.parse(storeEl.getAttribute('data-filter'));
  var saveable = quineFilter(filter);
  var prefix = filter.prefix;

  // ---- Status line ----
  function status(msg, warn) {
    var el = $('quine-status');
    el.textContent = msg;
    el.className = warn ? 'warn' : '';
    if (warn) console.warn('quine-wasm: ' + msg);
  }
  var warnings = [];
  function warn(msg) { warnings.push(msg); console.warn('quine-wasm: ' + msg); }

  // ---- Store parse (before the Wasm boots) ----
  var system = Object.assign({ title: QUINE_SYSTEM_TITLE, revision: 0 }, config.system);
  var tiddlers = [];
  var storeRefused = false;
  (function parseStore() {
    var version = Number(storeEl.getAttribute('data-version'));
    if (!(version <= QUINE_STORE_VERSION)) {
      storeRefused = true;
      return;
    }
    var list;
    try { list = JSON.parse(storeEl.textContent); } catch (e) { warn('store block is not valid JSON: ' + e.message); return; }
    if (!Array.isArray(list)) { warn('store block is not a JSON array'); return; }
    var count = 0;
    list.forEach(function (t, i) {
      if (!t || typeof t.title !== 'string') { warn('entry ' + i + ': no title, skipped'); return; }
      if (t.title === QUINE_SYSTEM_TITLE) { Object.assign(system, t); return; }
      if (!saveable(t.title)) { warn(t.title + ': outside the save filter, skipped'); return; }
      if (++count > config.maxFiles) { warn(t.title + ': more than ' + config.maxFiles + ' entries, skipped'); return; }
      if (t.type === QUINE_DIR_TYPE) { tiddlers.push({ path: t.title, dir: true }); return; }
      if (typeof t.text !== 'string') { warn(t.title + ': no text, skipped'); return; }
      var bytes;
      if (t.type === QUINE_BINARY_TYPE) {
        try { bytes = quineBase64ToBytes(t.text); } catch (e) { warn(t.title + ': bad base64, skipped'); return; }
      } else if (t.type === undefined) {
        bytes = new TextEncoder().encode(t.text);
      } else { warn(t.title + ': unknown type ' + t.type + ', skipped'); return; }
      if (bytes.length > config.maxFileBytes) { warn(t.title + ': larger than the file size limit, skipped'); return; }
      tiddlers.push({ path: t.title, bytes: bytes });
    });
  })();
  if (!system.lineage) {
    system.lineage = Array.from(crypto.getRandomValues(new Uint8Array(4)), function (b) {
      return b.toString(16).padStart(2, '0');
    }).join('');
  }

  // ---- Terminal ----
  var term = new Terminal({ scrollback: 5000, fontFamily: 'ui-monospace, Menlo, Consolas, monospace', fontSize: 14 });
  var fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open($('quine-term'));
  fit.fit();
  new ResizeObserver(function () { fit.fit(); }).observe($('quine-term'));

  // termios flag values from musl.
  var ICRNL = 256, OPOST = 1, ONLCR = 4, ICANON = 2, ECHO = 8;
  var host = {
    rows: term.rows,
    cols: term.cols,
    sleeping: false,
    termios: {
      c_iflag: ICRNL | 1024 | 8192 | 16384,
      c_oflag: OPOST | ONLCR,
      c_cflag: 15 | 48 | 128,
      c_lflag: 1 | ICANON | ECHO | 16 | 32 | 512 | 2048 | 32768,
      c_cc: [3, 28, 127, 21, 4, 0, 1, 0, 17, 19, 26, 0, 18, 15, 23, 22,
        0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    },
    input: [],
    waiters: [],
    line: '',
    out: [],
    module: null,
    setTermios: function (t) { host.termios = t; },
    hasInput: function () { return host.input.length > 0; },
    waitInput: function () {
      if (host.input.length) return Promise.resolve();
      return new Promise(function (resolve) { host.waiters.push(resolve); });
    },
    // Returns a byte, null for end of file, or undefined for no input.
    getChar: function () {
      if (!host.input.length) return undefined;
      return host.input.shift();
    },
    write: function (b) {
      if (b === 10 && (host.termios.c_oflag & (OPOST | ONLCR)) === (OPOST | ONLCR)) host.out.push(13);
      host.out.push(b);
      if (host.out.length === 1 || (host.out.length === 2 && b === 10)) queueMicrotask(flushOut);
    },
    requestSave: function () { save('api'); },
  };
  function flushOut() {
    if (!host.out.length) return;
    term.write(new Uint8Array(host.out));
    host.out = [];
  }
  function push(bytes) {
    for (var i = 0; i < bytes.length; i++) host.input.push(bytes[i]);
    var w = host.waiters;
    host.waiters = [];
    w.forEach(function (r) { r(); });
  }
  var enc = new TextEncoder();
  function echo(s) { if (host.termios.c_lflag & ECHO) term.write(s); }
  // Cooked mode (ICANON) is a small line discipline here. Raw mode passes keys through.
  function onKeys(data) {
    if (!running) return;
    var t = host.termios;
    if (!(t.c_lflag & ICANON)) {
      if (t.c_iflag & ICRNL) data = data.replace(/\r/g, '\n');
      echo(data);
      push(enc.encode(data));
      return;
    }
    for (var i = 0; i < data.length; i++) {
      var c = data[i];
      if (c === '\x1b') { i = data.length; break; } // drop escape sequences such as arrow keys
      if (c === '\r' || c === '\n') {
        echo('\r\n');
        push(enc.encode(host.line + '\n'));
        host.line = '';
      } else if (c === '\x7f' || c === '\b') {
        if (host.line) {
          host.line = Array.from(host.line).slice(0, -1).join('');
          echo('\b \b');
        }
      } else if (c === '\x04') {
        if (host.line) { push(enc.encode(host.line)); host.line = ''; } else { host.input.push(null); push([]); }
      } else if (c === '\x03') {
        echo('^C\r\n');
        host.line = '';
      } else if (c === '\x15') {
        echo('\b \b'.repeat(Array.from(host.line).length));
        host.line = '';
      } else if (c >= ' ' || c === '\t') {
        host.line += c;
        echo(c);
      }
    }
  }
  term.onData(onKeys);
  term.onResize(function (size) {
    host.rows = size.rows;
    host.cols = size.cols;
    // SIGWINCH (28). JS only runs while the program sleeps or after it ends.
    if (running && host.sleeping && host.module._raise) host.module._raise(28);
  });
  term.attachCustomKeyEventHandler(function (e) {
    var key = e.key && e.key.toLowerCase();
    if (e.type === 'keydown' && key === 's' && (e.metaKey || (e.ctrlKey && config.ctrlS !== 'program'))) {
      e.preventDefault();
      save('key');
      return false;
    }
    return true;
  });
  document.addEventListener('keydown', function (e) {
    if ((e.key || '').toLowerCase() === 's' && (e.metaKey || e.ctrlKey) && !term.element.contains(e.target)) {
      e.preventDefault();
      save('key');
    }
  });

  // ---- User gestures, for saves that the program asks for ----
  var lastGesture = 0;
  var pendingSave = false;
  ['keydown', 'pointerdown'].forEach(function (type) {
    window.addEventListener(type, function () {
      lastGesture = Date.now();
      if (pendingSave) { pendingSave = false; setTimeout(function () { save('deferred'); }, 0); }
    }, true);
  });

  // ---- MEMFS access ----
  function FS() { return host.module.FS; }
  // Walks the save filter. Returns entries for files, and for empty directories.
  function snapshot() {
    var out = [];
    var fs = FS();
    function walk(dir) {
      var names;
      try { names = fs.readdir(dir); } catch (e) { return; }
      var kept = 0;
      names.forEach(function (n) {
        if (n === '.' || n === '..') return;
        var p = dir + '/' + n;
        var st = fs.lstat(p);
        if (fs.isLink(st.mode) || !saveable(p)) return;
        if (fs.isDir(st.mode)) {
          kept++;
          if (!walk(p)) out.push({ path: p, dir: true });
        } else if (fs.isFile(st.mode)) {
          kept++;
          out.push({ path: p, bytes: fs.readFile(p) });
        }
      });
      return kept;
    }
    walk(prefix);
    return out;
  }
  function restore(fs, entries) {
    entries.forEach(function (e) {
      try {
        if (e.dir) { fs.mkdirTree(e.path); return; }
        fs.mkdirTree(e.path.slice(0, e.path.lastIndexOf('/')) || '/');
        fs.writeFile(e.path, e.bytes);
      } catch (err) { warn(e.path + ': could not restore (' + err + ')'); }
    });
  }

  // ---- Dirty tracking: FS calls mark a check, a hash of the store decides ----
  var savedHash = null;
  var dirty = false;
  var checkTimer = 0;
  function hash(s) {
    var h = 0x811c9dc5;
    for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    return (h >>> 0).toString(16) + ':' + s.length;
  }
  function storeText() {
    return quineSerialize([system].concat(quineTiddlers(snapshot())));
  }
  function scheduleCheck() {
    if (checkTimer) return;
    checkTimer = setTimeout(function () {
      checkTimer = 0;
      if (!host.module) return;
      dirty = hash(storeText()) !== savedHash;
      $('quine-dirty').textContent = dirty ? '\u25cf unsaved changes' : '';
      listFiles();
    }, 400);
  }
  function wrapFS(fs) {
    ['write', 'writeFile', 'truncate', 'ftruncate', 'unlink', 'rename', 'mkdir', 'rmdir', 'symlink', 'close']
      .forEach(function (name) {
        var orig = fs[name];
        fs[name] = function () {
          try { return orig.apply(this, arguments); } finally { scheduleCheck(); }
        };
      });
  }
  window.addEventListener('beforeunload', function (e) {
    if (dirty) { e.preventDefault(); e.returnValue = ''; }
  });

  // ---- Save ----
  function htmlEscape(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function buildCopy(store) {
    var template = JSON.parse($('quine-template').textContent);
    return quineAssemble(template, {
      'quine-title': htmlEscape(config.title),
      'quine-template': $('quine-template').textContent,
      'quine-config': $('quine-config').textContent,
      'quine-filter': htmlEscape(storeEl.getAttribute('data-filter')),
      'quine-store': store,
      'quine-runtime': $('quine-runtime').textContent,
      'quine-xterm-css': $('quine-xterm-css').textContent,
      'quine-xterm': $('quine-xterm').textContent,
      'quine-engine': $('quine-engine').textContent,
      'quine-shell': $('quine-shell').textContent,
    });
  }
  function baseName() {
    var name = decodeURIComponent(location.pathname.split('/').pop() || 'quine.html');
    return name.replace(/\.html?$/i, '').replace(/\.[0-9a-f]{8}\.r\d+\.\d{8}-\d{6}$/, '') || 'quine';
  }
  function stamp() {
    var d = new Date();
    var p = function (n) { return String(n).padStart(2, '0'); };
    return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
  }
  var lastCopy = null;
  function download(name, blob) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
  }
  function save(source) {
    if (storeRefused) { status('Save is off: this file has a store from a newer version. The file is kept as it was.', true); return; }
    if (!host.module) { status('Nothing to save yet.', true); return; }
    if (source === 'api' && Date.now() - lastGesture > 5000) {
      pendingSave = true;
      status('Save is ready. Press a key or click to download it.');
      return;
    }
    Promise.resolve(config.persist === 'idbfs' ? syncIdb(false) : null).then(function () {
      // The flush hook runs, then MEMFS is read in this one task.
      if (host.module._quine_flush) host.module._quine_flush();
      var next = Object.assign({}, system, { revision: system.revision + 1 });
      var text = quineSerialize([next].concat(config.persist === 'idbfs' ? [] : quineTiddlers(snapshot())));
      var html = buildCopy(text);
      if (html.length > config.maxSaveBytes) {
        status('Save refused: the copy is ' + mb(html.length) + ', above the limit of ' + mb(config.maxSaveBytes) + '.', true);
        return;
      }
      system = next;
      savedHash = hash(storeText());
      dirty = false;
      $('quine-dirty').textContent = '';
      var name = baseName() + '.' + system.lineage + '.r' + system.revision + '.' + stamp() + '.html';
      lastCopy = { name: name, html: html };
      download(name, new Blob([html], { type: 'text/html' }));
      status('Saved ' + name + ' (' + mb(html.length) + ').');
      $('quine-fallback').style.display = 'inline-flex';
    });
  }
  function mb(n) { return (n / 1048576).toFixed(1) + ' MB'; }
  $('quine-save').onclick = function () { save('button'); };
  $('quine-open').onclick = function () {
    if (!lastCopy) return;
    window.open(URL.createObjectURL(new Blob([lastCopy.html], { type: 'text/html' })), '_blank');
  };
  $('quine-copy').onclick = function () {
    if (!lastCopy) return;
    navigator.clipboard.writeText(lastCopy.html).then(function () {
      status('HTML copied. Paste it into a new file named ' + lastCopy.name + '.');
    }, function () { status('The browser did not allow a copy to the clipboard.', true); });
  };

  // ---- Export files as .tar (paths relative to the prefix, so you can unpack it in $HOME) ----
  $('quine-tar').onclick = function () {
    if (!host.module) return;
    var entries = snapshot().map(function (e) {
      return { name: e.path.slice(prefix.length + 1), dir: e.dir, bytes: e.bytes };
    });
    var tar = quineTarWrite(entries);
    download(baseName() + '.' + stamp() + '.tar', new Blob([tar.bytes], { type: 'application/x-tar' }));
    status('Exported ' + entries.length + ' entries.' + (tar.skipped.length ? ' Skipped (path too long): ' + tar.skipped.join(', ') : ''),
      tar.skipped.length > 0);
  };

  // ---- File panel ----
  function listFiles() {
    if (!host.module) return;
    var ul = $('quine-files');
    ul.textContent = '';
    snapshot().forEach(function (e) {
      var li = document.createElement('li');
      var name = document.createElement('span');
      name.textContent = e.path.slice(prefix.length + 1) + (e.dir ? '/' : '');
      var size = document.createElement('span');
      size.textContent = e.dir ? '' : e.bytes.length + ' B';
      li.append(name, size);
      li.onclick = function () { openFile(e.path); };
      ul.append(li);
    });
  }
  function openFile(path) {
    $('quine-path').value = path;
    var ed = $('quine-editor');
    var bytes;
    try { bytes = FS().readFile(path); } catch (e) { ed.value = ''; ed.disabled = false; return; }
    var text = quineDecodeText(bytes);
    ed.disabled = text === null;
    ed.value = text === null ? '(binary file, ' + bytes.length + ' bytes)' : text;
  }
  $('quine-write').onclick = function () {
    var path = $('quine-path').value.trim();
    if (!path) return;
    if (path[0] !== '/') path = system.cwd + '/' + path;
    if (!saveable(path)) { status(path + ' is outside the save filter. It is not written.', true); return; }
    var fs = FS();
    fs.mkdirTree(path.slice(0, path.lastIndexOf('/')));
    fs.writeFile(path, $('quine-editor').value);
    status('Wrote ' + path + '.');
  };
  function upload(files) {
    var dir = system.cwd;
    Array.from(files).forEach(function (f) {
      f.arrayBuffer().then(function (buf) {
        var p = dir + '/' + f.name;
        if (!saveable(p)) { status(p + ' is outside the save filter. It is not written.', true); return; }
        if (buf.byteLength > config.maxFileBytes) { status(f.name + ' is larger than the file size limit.', true); return; }
        FS().writeFile(p, new Uint8Array(buf));
        status('Uploaded ' + p + '.');
      });
    });
  }
  $('quine-upload').onclick = function () { $('quine-upload-input').click(); };
  $('quine-upload-input').onchange = function (e) { upload(e.target.files); e.target.value = ''; };
  var panel = $('quine-panel');
  panel.addEventListener('dragover', function (e) { e.preventDefault(); panel.classList.add('drop'); });
  panel.addEventListener('dragleave', function () { panel.classList.remove('drop'); });
  panel.addEventListener('drop', function (e) {
    e.preventDefault();
    panel.classList.remove('drop');
    if (host.module) upload(e.dataTransfer.files);
  });

  // ---- System tiddler fields: the command and the working folder ----
  function quoteArg(a) { return /^[\w@%+=:,./-]+$/.test(a) ? a : '"' + a.replace(/(["\\])/g, '\\$1') + '"'; }
  function parseArgs(s) {
    var out = [];
    var re = /"((?:[^"\\]|\\.)*)"|(\S+)/g;
    var m;
    while ((m = re.exec(s))) out.push(m[1] !== undefined ? m[1].replace(/\\(.)/g, '$1') : m[2]);
    return out;
  }
  $('quine-args').value = [system.entry].concat(system.args).map(quoteArg).join(' ');
  $('quine-cwd').value = system.cwd;
  $('quine-args').onchange = function () {
    var a = parseArgs($('quine-args').value);
    if (!a.length) return;
    system = Object.assign({}, system, { entry: a[0], args: a.slice(1) });
    scheduleCheck();
    status('The command takes effect at the next run.');
  };
  $('quine-cwd').onchange = function () {
    system = Object.assign({}, system, { cwd: $('quine-cwd').value.trim() || prefix });
    scheduleCheck();
    status('The working folder takes effect at the next run.');
  };

  // ---- Read-only runtime block, unpacked with DecompressionStream ----
  var runtimeEl = $('quine-runtime');
  var runtimeFiles = Promise.resolve([]);
  if (runtimeEl.textContent.trim()) {
    var gz = new Blob([quineBase64ToBytes(runtimeEl.textContent.trim())]);
    runtimeFiles = new Response(gz.stream().pipeThrough(new DecompressionStream('gzip')))
      .arrayBuffer().then(function (buf) { return quineTarRead(new Uint8Array(buf)); });
  }
  function mountRuntime(fs, files) {
    var root = config.runtimeMount;
    files.forEach(function (f) {
      var p = root + '/' + f.name;
      if (f.dir) { fs.mkdirTree(p); return; }
      fs.mkdirTree(p.slice(0, p.lastIndexOf('/')));
      fs.writeFile(p, f.bytes);
      fs.chmod(p, 292);
    });
  }

  // ---- IDBFS control build ----
  function syncIdb(populate) {
    return new Promise(function (resolve) {
      FS().syncfs(populate, function (err) { if (err) warn('IDBFS sync: ' + err); resolve(); });
    });
  }

  // ---- Run, and Run again ----
  var running = false;
  var runCount = 0;
  function run(entries, files) {
    running = true;
    runCount++;
    $('quine-again').hidden = true;
    host.input = [];
    host.line = '';
    host.sleeping = false;
    var mod = {
      quineHost: host,
      thisProgram: system.entry,
      arguments: system.args.slice(),
      print: function (s) { term.write(s + '\r\n'); },
      printErr: function (s) { console.warn(s); },
      preRun: [function (m) {
        var fs = m.FS;
        fs.mkdirTree(prefix);
        if (config.persist === 'idbfs') {
          fs.mount(m.IDBFS, {}, prefix);
          m.addRunDependency('quine-idbfs');
          fs.syncfs(true, function (err) {
            if (err) warn('IDBFS load: ' + err);
            m.removeRunDependency('quine-idbfs');
          });
        } else {
          restore(fs, entries);
        }
        mountRuntime(fs, files);
        m.ENV.HOME = prefix;
        m.ENV.TERM = 'xterm-256color';
        m.ENV.COLORTERM = 'truecolor';
        fs.mkdirTree(system.cwd);
        fs.chdir(system.cwd);
        wrapFS(fs);
      }],
      onExit: function (code) { ended('exited with status ' + code); },
      onAbort: function (what) { ended('stopped: ' + what); },
    };
    return QuineEngine(mod).then(function (m) {
      host.module = m;
      if (savedHash === null) savedHash = hash(storeText());
      listFiles();
    }, function (e) { ended('failed to start: ' + e); });
  }
  function ended(why) {
    if (!running) return;
    running = false;
    flushOut();
    term.write('\r\n\x1b[2m[program ' + why + ']\x1b[0m\r\n');
    $('quine-again').hidden = false;
    scheduleCheck();
  }
  $('quine-again').onclick = function () {
    var entries = host.module ? snapshot() : tiddlers;
    term.reset();
    runtimeFiles.then(function (files) { run(entries, files); });
  };

  window.quine = {
    save: function () { save('api'); },
    term: term,
    screenText: function () {
      var b = term.buffer.active;
      var lines = [];
      for (var i = 0; i < b.length; i++) lines.push(b.getLine(i).translateToString(true));
      return lines.join('\n');
    },
    isDirty: function () { return dirty; },
    get module() { return host.module; },
    get running() { return running; },
  };

  if (storeRefused) {
    status('This file has a store from a newer version of quine-wasm. It is not loaded, and Save is off so it stays intact.', true);
  }
  runtimeFiles.then(function (files) {
    return run(tiddlers, files);
  }).then(function () {
    if (warnings.length) status(warnings.length + ' store entries skipped: ' + warnings.join('; '), true);
  }, function (e) { status('Could not start: ' + e, true); });
})();
