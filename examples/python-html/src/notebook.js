// python-html notebook view. The build appends this file to quine-wasm's page
// script (the quine-shell block), so Save copies it with the page.
// Notebooks are .ipynb files (nbformat 4) in the user folder, so Save keeps them
// in the HTML file. Cells run on the same Python as the terminal: see
// src/python/pyhtml_kernel.py.
(function () {
  'use strict';

  var REQUEST = '/tmp/pyhtml/request.json';
  var REPLY = '/tmp/pyhtml/reply.json';
  var home = JSON.parse(document.getElementById('quine-store').getAttribute('data-filter')).prefix;

  function el(tag, attrs, children) {
    var e = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      if (k === 'text') e.textContent = attrs[k];
      else if (k.slice(0, 2) === 'on') e.addEventListener(k.slice(2), attrs[k]);
      else e.setAttribute(k, attrs[k]);
    });
    (children || []).forEach(function (c) { e.append(c); });
    return e;
  }

  var style = document.createElement('style');
  style.textContent = [
    '#nb { flex: 1; min-width: 0; overflow: auto; padding: 8px 12px; display: none; }',
    '#nb.on { display: block; }',
    '#nb .bar { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; margin-bottom: 8px; }',
    '#nb .bar input { font: 13px ui-monospace, monospace; min-width: 14em; }',
    '#nb .cell { border: 1px solid var(--line); border-radius: 4px; margin: 0 0 8px; background: var(--panel); }',
    '#nb .cell.md textarea { font-family: system-ui, sans-serif; }',
    '#nb .head { display: flex; gap: 6px; align-items: center; padding: 3px 6px; font: 12px ui-monospace, monospace; color: var(--accent); }',
    '#nb .head span { flex: 1; }',
    '#nb .head button { padding: 0 6px; font-size: 12px; }',
    '#nb textarea { display: block; width: 100%; box-sizing: border-box; border: 0; border-top: 1px solid var(--line);',
    '  padding: 6px; font: 13px/1.4 ui-monospace, Menlo, monospace; background: transparent; color: var(--fg); resize: vertical; }',
    '#nb .out { border-top: 1px solid var(--line); padding: 4px 6px; }',
    '#nb .out:empty { display: none; }',
    '#nb pre { margin: 2px 0; white-space: pre-wrap; font: 12px/1.4 ui-monospace, Menlo, monospace; }',
    '#nb pre.stderr, #nb pre.error { color: var(--warn); }',
    '#nb img { max-width: 100%; background: #fff; }',
  ].join('\n');
  document.head.append(style);

  var cells = [];
  var count = 0;
  var list = el('div');
  var path = el('input', { type: 'text', id: 'nb-path', spellcheck: 'false', value: 'notebook.ipynb', title: 'File name, relative to ' + home });
  var view = el('section', { id: 'nb' }, [
    el('div', { class: 'bar' }, [
      el('strong', { text: 'Notebook' }), path,
      el('button', { id: 'nb-open', text: 'Open', onclick: function () { open(path.value); } }),
      el('button', { id: 'nb-write', text: 'Write .ipynb', title: 'Write the notebook file. Then click Save to keep it in the HTML file.', onclick: write }),
      el('button', { id: 'nb-add', text: '+ Code', onclick: function () { add('code', '').focus(); } }),
      el('button', { text: '+ Text', onclick: function () { add('markdown', '').focus(); } }),
      el('button', { id: 'nb-run-all', text: 'Run all', onclick: runAll }),
      el('span', { id: 'nb-status' }),
    ]),
    list,
  ]);
  var term = document.getElementById('quine-term');
  term.parentNode.insertBefore(view, term);
  var toggle = el('button', { id: 'nb-toggle', text: 'Notebook', title: 'Show the notebook or the terminal', onclick: function () { show(!view.classList.contains('on')); } });
  document.getElementById('quine-again').before(toggle);

  function show(on) {
    view.classList.toggle('on', on);
    term.style.display = on ? 'none' : '';
    toggle.textContent = on ? 'Terminal' : 'Notebook';
    if (on) cells.forEach(function (c) { c.fit(); });
    if (!on) window.quine.term.focus();
  }
  function status(msg) { document.getElementById('nb-status').textContent = msg; }
  function fullPath(p) { return p[0] === '/' ? p : home + '/' + p; }
  function FS() { return window.quine.module && window.quine.module.FS; }

  function add(type, source, outputs) {
    var c = { type: type, area: el('textarea', { spellcheck: 'false', rows: 1 }), out: el('div', { class: 'out' }), count: null, outputs: [] };
    c.label = el('span', { text: type === 'code' ? '[ ]' : 'text' });
    c.area.value = source;
    var runBtn = type === 'code' ? [el('button', { text: 'Run', title: 'Shift+Enter', onclick: function () { run(c); } })] : [];
    c.node = el('div', { class: 'cell ' + (type === 'code' ? 'code' : 'md') }, [
      el('div', { class: 'head' }, [c.label].concat(runBtn, [
        el('button', { text: 'Delete', onclick: function () { cells.splice(cells.indexOf(c), 1); c.node.remove(); } }),
      ])),
      c.area, c.out,
    ]);
    var fit = c.fit = function () { c.area.style.height = 'auto'; c.area.style.height = c.area.scrollHeight + 2 + 'px'; };
    c.area.addEventListener('input', fit);
    c.area.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && e.shiftKey) {
        e.preventDefault();
        if (c.type === 'code') run(c);
        var next = cells[cells.indexOf(c) + 1];
        (next ? next.area : add('code', '')).focus();
      }
    });
    cells.push(c);
    list.append(c.node);
    (outputs || []).forEach(function (o) { render(c, o); });
    requestAnimationFrame(fit);
    return c.area;
  }

  function text(v) { return Array.isArray(v) ? v.join('') : v || ''; }
  function render(c, o) {
    var data = o.data || {};
    if (o.output_type === 'stream') c.out.append(el('pre', { class: o.name, text: text(o.text) }));
    else if (o.output_type === 'error') c.out.append(el('pre', { class: 'error', text: (o.traceback || []).join('\n') }));
    else if (data['image/png']) c.out.append(el('img', { src: 'data:image/png;base64,' + text(data['image/png']).replace(/\s/g, ''), alt: text(data['text/plain']) }));
    else if (data['text/plain'] !== undefined) c.out.append(el('pre', { text: text(data['text/plain']) }));
    c.outputs.push(o);
  }

  // Runs a cell on the engine. The page can run JS only while Python waits for
  // terminal input or after it ends, so the engine is free when this runs.
  function run(c) {
    var fs = FS();
    if (!fs || !window.quine.running) { status('Python is not running. Click "Run again" or reload the page.'); return false; }
    count++;
    c.out.textContent = '';
    c.outputs = [];
    fs.mkdirTree('/tmp/pyhtml');
    fs.writeFile(REQUEST, JSON.stringify({ code: c.area.value, count: count }));
    try { fs.unlink(REPLY); } catch (e) { /* no reply from an earlier cell */ }
    window.quine.module._pyhtml_kernel();
    var reply;
    try { reply = JSON.parse(fs.readFile(REPLY, { encoding: 'utf8' })); } catch (e) { reply = { outputs: [{ output_type: 'error', traceback: ['The kernel did not reply. See the terminal.'] }] }; }
    c.count = count;
    c.label.textContent = '[' + count + ']';
    reply.outputs.forEach(function (o) { render(c, o); });
    status('');
    return !reply.outputs.some(function (o) { return o.output_type === 'error'; });
  }
  function runAll() {
    for (var i = 0; i < cells.length; i++) if (cells[i].type === 'code' && !run(cells[i])) break;
  }

  function lines(s) { return s.split(/(?<=\n)/).filter(function (x) { return x !== ''; }); }
  function toJson() {
    return {
      cells: cells.map(function (c) {
        var cell = { cell_type: c.type, id: Math.random().toString(16).slice(2, 10), metadata: {}, source: lines(c.area.value) };
        if (c.type === 'code') { cell.execution_count = c.count; cell.outputs = c.outputs || []; }
        return cell;
      }),
      metadata: {
        kernelspec: { display_name: 'Python 3 (python-html)', language: 'python', name: 'python3' },
        language_info: { name: 'python' },
      },
      nbformat: 4,
      nbformat_minor: 5,
    };
  }
  function write() {
    var fs = FS();
    if (!fs) return;
    var p = fullPath(path.value.trim());
    fs.mkdirTree(p.slice(0, p.lastIndexOf('/')));
    fs.writeFile(p, JSON.stringify(toJson(), null, 1) + '\n');
    status('Wrote ' + p + '. Click Save to keep it in the HTML file.');
  }
  function open(p) {
    var fs = FS();
    if (!fs) return;
    var nb;
    try { nb = JSON.parse(fs.readFile(fullPath(p), { encoding: 'utf8' })); } catch (e) { status('Cannot open ' + p + ': ' + e.message); return; }
    cells.length = 0;
    list.textContent = '';
    (nb.cells || []).forEach(function (cell) {
      add(cell.cell_type === 'code' ? 'code' : 'markdown', text(cell.source), cell.outputs);
      var c = cells[cells.length - 1];
      if (cell.execution_count) { c.count = cell.execution_count; c.label.textContent = '[' + c.count + ']'; }
    });
    if (!cells.length) add('code', '');
    status('Opened ' + fullPath(p) + '.');
  }

  // Opens notebook.ipynb when the engine has started, or an empty notebook.
  var wait = setInterval(function () {
    if (!FS()) return;
    clearInterval(wait);
    var p = fullPath(path.value);
    try { FS().stat(p); open(path.value); } catch (e) { add('code', ''); }
  }, 100);

  window.pyhtmlNotebook = { show: show, open: open, write: write, run: function (i) { return run(cells[i]); }, add: add, cells: cells };
})();
