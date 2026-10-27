#!/usr/bin/env node
// quine-wasm: link a C/C++ program with emcc and make one portable HTML file.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { spawnSync } = require('child_process');
const store = require('../src/store.js');

const ROOT = path.join(__dirname, '..');
const USAGE = `Usage: quine-wasm [options] -- <emcc inputs and flags>

Options:
  -o, --out FILE.html     output file (required)
  --title TEXT            page title (default: output name)
  --args "PROG ARG..."    program name and arguments (default: output name)
  --prefix DIR            user folder; only files under it are saved (default: /home/web)
  --cwd DIR               working folder (default: the prefix)
  --include GLOB          save only paths that match, relative to the prefix (repeatable, default: **)
  --exclude GLOB          do not save paths that match (repeatable)
  --seed DIR              copy the files in DIR into the prefix of the first store
  --runtime DIR:MOUNT     add DIR as a read-only gzipped block, unpacked at MOUNT at boot
  --ctrl-s page|program   where Ctrl+S goes (default: page, which saves)
  --max-file-mb N         largest file that boot restores (default: 256)
  --max-files N           most store entries that boot restores (default: 100000)
  --max-save-mb N         largest copy that Save writes (default: 1024)
  --persist store|idbfs   idbfs makes a control build with Emscripten IDBFS (default: store)
  --emcc PATH             emcc to run (default: emcc)
`;

function fail(msg) {
  process.stderr.write('quine-wasm: ' + msg + '\n');
  process.exit(1);
}

function parse(argv) {
  const o = { include: [], exclude: [], ctrlS: 'page', persist: 'store', prefix: '/home/web', emcc: 'emcc',
    maxFileMb: 256, maxFiles: 100000, maxSaveMb: 1024 };
  const sep = argv.indexOf('--');
  if (sep < 0) fail('no "--" before the emcc arguments\n\n' + USAGE);
  o.emccArgs = argv.slice(sep + 1);
  const opts = argv.slice(0, sep);
  const take = (i) => { if (i + 1 >= opts.length) fail(opts[i] + ' needs a value'); return opts[i + 1]; };
  for (let i = 0; i < opts.length; i++) {
    const a = opts[i];
    switch (a) {
      case '-o': case '--out': o.out = take(i++); break;
      case '--title': o.title = take(i++); break;
      case '--args': o.args = take(i++); break;
      case '--prefix': o.prefix = take(i++).replace(/\/+$/, ''); break;
      case '--cwd': o.cwd = take(i++); break;
      case '--include': o.include.push(take(i++)); break;
      case '--exclude': o.exclude.push(take(i++)); break;
      case '--seed': o.seed = take(i++); break;
      case '--runtime': o.runtime = take(i++); break;
      case '--ctrl-s': o.ctrlS = take(i++); break;
      case '--max-file-mb': o.maxFileMb = Number(take(i++)); break;
      case '--max-files': o.maxFiles = Number(take(i++)); break;
      case '--max-save-mb': o.maxSaveMb = Number(take(i++)); break;
      case '--persist': o.persist = take(i++); break;
      case '--emcc': o.emcc = take(i++); break;
      case '-h': case '--help': process.stdout.write(USAGE); process.exit(0); break;
      default: fail('unknown option ' + a + '\n\n' + USAGE);
    }
  }
  if (!o.out) fail('-o is required');
  if (!['page', 'program'].includes(o.ctrlS)) fail('--ctrl-s must be page or program');
  if (!['store', 'idbfs'].includes(o.persist)) fail('--persist must be store or idbfs');
  if (!/^\/[^\s]+$/.test(o.prefix) || o.prefix === '/') fail('--prefix must be an absolute folder other than /');
  for (const k of ['maxFileMb', 'maxFiles', 'maxSaveMb']) if (!(o[k] > 0)) fail('size and count limits must be positive');
  if (!o.include.length) o.include.push('**');
  return o;
}

// Threads need SharedArrayBuffer and cross-origin isolation, which a file:// page does not have.
const THREAD_FLAGS = /^(-pthread|-sUSE_PTHREADS(=1)?|-sSHARED_MEMORY(=1)?|-sWASM_WORKERS(=1)?|-sPROXY_TO_PTHREAD(=1)?)$/;

function walk(dir, rel = '') {
  const out = [];
  for (const name of fs.readdirSync(path.join(dir, rel)).sort()) {
    const r = rel ? rel + '/' + name : name;
    const st = fs.lstatSync(path.join(dir, r));
    if (st.isDirectory()) {
      const sub = walk(dir, r);
      out.push(...(sub.length ? sub : [{ name: r, dir: true }]));
    } else if (st.isFile()) {
      out.push({ name: r, bytes: new Uint8Array(fs.readFileSync(path.join(dir, r))) });
    }
  }
  return out;
}

function readAsset(rel) {
  const text = fs.readFileSync(require.resolve(rel), 'utf8');
  return text.replace(/\n\/\/# sourceMappingURL=.*\s*$/, '\n');
}

// The MIT licence asks for its notice in each copy, so it goes in front of the inlined code.
function licence(pkg) {
  const text = fs.readFileSync(path.join(path.dirname(require.resolve(pkg + '/package.json')), 'LICENSE'), 'utf8');
  return '/* ' + pkg + '\n' + text.replace(/\*\//g, '* /') + '*/\n';
}

// Text that goes inside a <script> or <style> element must not close it or open a comment.
function checkRaw(name, text) {
  if (/<\/(script|style)|<!--/i.test(text)) fail(name + ' contains "</script", "</style" or "<!--"; it cannot be inlined');
  return text;
}

function main() {
  const o = parse(process.argv.slice(2));
  const bad = o.emccArgs.find((a) => THREAD_FLAGS.test(a));
  if (bad) fail(bad + ': threads and SharedArrayBuffer do not work in a file:// page');

  const base = path.basename(o.out).replace(/\.html?$/i, '');
  const argv = o.args ? o.args.split(/\s+/).filter(Boolean) : [base];
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'quine-wasm-'));
  const engineJs = path.join(tmp, 'engine.js');
  const runtimeMethods = ['FS', 'ENV', 'addRunDependency', 'removeRunDependency'];
  if (o.persist === 'idbfs') runtimeMethods.push('IDBFS');
  const emccArgs = [
    ...o.emccArgs,
    '-o', engineJs,
    '-sASYNCIFY', '-sASYNCIFY_STACK_SIZE=1048576',
    '-sSINGLE_FILE', '-sMODULARIZE', '-sEXPORT_NAME=QuineEngine',
    '-sENVIRONMENT=web', '-sEXIT_RUNTIME', '-sFORCE_FILESYSTEM', '-sALLOW_MEMORY_GROWTH',
    '-sEXPORTED_RUNTIME_METHODS=' + runtimeMethods.join(','),
    '-sEXPORTED_FUNCTIONS=_main,_raise',
    '-sDEFAULT_LIBRARY_FUNCS_TO_INCLUDE=$quineTty',
    '--js-library', path.join(ROOT, 'src/lib_quine.js'),
    '-I' + path.join(ROOT, 'include'),
    ...(o.persist === 'idbfs' ? ['-lidbfs.js'] : []),
  ];
  process.stderr.write('quine-wasm: ' + o.emcc + ' ' + emccArgs.join(' ') + '\n');
  const r = spawnSync(o.emcc, emccArgs, { stdio: 'inherit' });
  if (r.error) fail('could not run ' + o.emcc + ': ' + r.error.message);
  if (r.status !== 0) fail('emcc failed with status ' + r.status);
  const engine = fs.readFileSync(engineJs, 'utf8');
  fs.rmSync(tmp, { recursive: true, force: true });
  if (/shared\s*:\s*(true|!0)/.test(engine)) fail('the engine makes shared memory; threads do not work in a file:// page');

  const filter = { prefix: o.prefix, include: o.include, exclude: o.exclude };
  const saveable = store.quineFilter(filter);
  const seed = o.seed ? walk(o.seed).map((e) => ({ path: o.prefix + '/' + e.name, dir: e.dir, bytes: e.bytes })) : [];
  const outside = seed.find((e) => !saveable(e.path));
  if (outside) fail('seed file ' + outside.path + ' is outside the save filter');

  let runtime = '';
  let runtimeMount = '';
  if (o.runtime) {
    const [dir, mount] = o.runtime.split(':');
    if (!mount || !mount.startsWith('/')) fail('--runtime needs DIR:/absolute/mount');
    if (mount === o.prefix || mount.startsWith(o.prefix + '/')) fail('the runtime mount must be outside the prefix');
    runtimeMount = mount.replace(/\/+$/, '');
    runtime = zlib.gzipSync(store.quineTarWrite(walk(dir)).bytes, { level: 9 }).toString('base64');
  }

  const config = {
    title: o.title || base,
    system: { entry: argv[0], args: argv.slice(1), cwd: o.cwd || o.prefix },
    ctrlS: o.ctrlS,
    persist: o.persist,
    runtimeMount,
    maxFileBytes: o.maxFileMb * 1048576,
    maxFiles: o.maxFiles,
    maxSaveBytes: o.maxSaveMb * 1048576,
  };
  const json = (v) => JSON.stringify(v).replace(/</g, '\\u003c');
  const html = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const template = fs.readFileSync(path.join(ROOT, 'src/shell.html'), 'utf8');
  const system = Object.assign({ title: store.QUINE_SYSTEM_TITLE, revision: 0 }, config.system);
  const out = store.quineAssemble(template, {
    'quine-title': html(config.title),
    'quine-template': json(template),
    'quine-config': json(config),
    'quine-filter': html(JSON.stringify(filter)),
    'quine-store': store.quineSerialize([system].concat(store.quineTiddlers(seed))),
    'quine-runtime': runtime,
    'quine-xterm-css': checkRaw('xterm.css', readAsset('@xterm/xterm/css/xterm.css')),
    'quine-xterm': checkRaw('xterm.js', licence('@xterm/xterm') + readAsset('@xterm/xterm/lib/xterm.js') +
      licence('@xterm/addon-fit') + readAsset('@xterm/addon-fit/lib/addon-fit.js')),
    'quine-engine': checkRaw('the engine', engine),
    'quine-shell': checkRaw('the shell', fs.readFileSync(path.join(ROOT, 'src/store.js'), 'utf8') +
      fs.readFileSync(path.join(ROOT, 'src/shell.js'), 'utf8')),
  });
  fs.mkdirSync(path.dirname(path.resolve(o.out)), { recursive: true });
  fs.writeFileSync(o.out, out);
  process.stderr.write('quine-wasm: wrote ' + o.out + ' (' + (out.length / 1048576).toFixed(1) + ' MB)\n');
}

main();
