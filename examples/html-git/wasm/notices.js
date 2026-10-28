'use strict';
const fs = require('node:fs');
const path = require('node:path');
const [source, output] = process.argv.slice(2);
const notice = fs.readFileSync(path.join(source, 'COPYING'), 'utf8');
const html = fs.readFileSync(output, 'utf8');
// Keep the notices in the engine block so quine saves preserve them.
const comment = '\n/* libgit2 and bundled components\nSource: https://github.com/libgit2/libgit2\nLocal change: wasm/libgit2-size-t.patch uses generic overflow functions for Emscripten.\n' + notice.replace(/\*\//g, '* /').replace(/</g, '\\u003c') + '\n*/\n';
const bridge = fs.readFileSync(path.join(__dirname, 'folder-bridge.js'), 'utf8');
fs.writeFileSync(output, html.replace('<script id="quine-engine">', '<script id="quine-engine">' + comment + bridge));
