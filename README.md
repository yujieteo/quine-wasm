# quine-wasm

Turn an Emscripten program into one portable HTML file whose files travel inside it.

quine-wasm puts your files inside the HTML file. When you copy the file, you copy the files.
It is a general tool. It is not specific to one program.
For example, [nvim-html](https://github.com/yujieteo/nvim-html) uses it to put Neovim, a Lua config and plugins in one HTML file.

Try it with no build: download [docs/sqlite.html](docs/sqlite.html), open it from disk, and type SQL.

## Why

**The problem.** Users of single-file HTML tools want the data to travel with the file (see [this discussion](https://news.ycombinator.com/item?id=44937991)).
A compiled Wasm app usually keeps its files in one of these places:

- IndexedDB or OPFS. The data stays in one browser profile on one machine.
- Read-only files that the build embeds. You cannot save changes to them.

**The conventional solutions:**

- Emscripten IDBFS or OPFS persistence. The data does not leave the browser profile.
- sql.js with a manual `db.export()` download. You get a separate database file. Then you must keep the file and the app together yourself.

**Why quine-wasm is better for portability and offline use.**
The files live inside the HTML file, in a JSON store block.
The page reads the block before the Wasm starts, and writes the files into the Emscripten in-memory filesystem (MEMFS).
Save writes a new copy of the whole HTML file with the current files in the block.
Thus one file holds the program and its data. It needs no server, no network and no browser storage.
You can send it by email, put it on a USB drive, or open it from `file://` on a different machine.

### The falsifiable test

The claim: after you change files in the app and save, you can open the copy on a different machine from `file://`, and the changes are there.
An Emscripten IDBFS build of the same program must show an empty filesystem in the same test.

[tests/sqlite.spec.js](tests/sqlite.spec.js) does this test with the SQLite shell (`sqlite3`, built with emcc):

1. Open `build/sqlite.html` from `file://`.
2. Create a table and insert 2 rows.
3. Click Save. Move the downloaded copy to a different folder.
4. Open the copy from `file://` in a new browser profile. The new profile has no shared storage, as on a different machine.
5. Run `select * from t;`. The test passes only if both rows show.
6. Click "Export files as .tar". The test passes only if the archive holds `demo.db` with the SQLite file header.

The IDBFS control (`build/sqlite-idbfs.html`) does steps 1 to 5. The test passes only if the copy shows `no such table: t`.

Measured results:

| Browser | quine-wasm build | IDBFS control | Where |
| --- | --- | --- | --- |
| Chromium (Playwright 1.63) | rows show, `.tar` holds `demo.db` | empty filesystem | macOS 27, local |
| WebKit 26.6 (Playwright 1.63) | rows show, `.tar` holds `demo.db` | empty filesystem | macOS 27, local |
| Firefox (Playwright 1.63) | see CI | see CI | Linux, GitHub Actions |

The CI workflow runs the same test in all 3 browsers. A green CI check means that all 3 pass.
Playwright Firefox does not start on macOS 27, so the Firefox result comes only from CI.

## Usage

Get emcc and Node from nix. You do not need a global install:

```sh
nix develop            # or: nix shell nixpkgs#emscripten nixpkgs#nodejs
npm ci
```

Build a program. Put the quine-wasm options before `--` and the emcc inputs and flags after it:

```sh
node bin/quine-wasm.js -o app.html --args "app input.txt" -- -O2 app.c
```

| Option | Default | What it does |
| --- | --- | --- |
| `-o FILE.html` | (required) | The output file. |
| `--title TEXT` | output name | The page title. |
| `--args "PROG ARG..."` | output name | The program name and arguments. |
| `--prefix DIR` | `/home/web` | The user folder. Only files under it go in the store. It is also `$HOME`. |
| `--cwd DIR` | the prefix | The working folder. |
| `--include GLOB` | `**` | Save only the paths that match, relative to the prefix. You can give it more than once. |
| `--exclude GLOB` | none | Do not save the paths that match. You can give it more than once. |
| `--seed DIR` | none | Put the files in DIR in the first store, under the prefix. |
| `--runtime DIR:MOUNT` | none | Add DIR as a read-only gzipped block. The page unpacks it at MOUNT at each start. It is not in the store. |
| `--ctrl-s page\|program` | `page` | `page`: Ctrl+S saves the file. `program`: Ctrl+S goes to the program. Cmd+S always saves. |
| `--max-file-mb N` | 256 | Boot skips a store file larger than this. |
| `--max-files N` | 100000 | Boot skips store entries after this count. |
| `--max-save-mb N` | 1024 | Save refuses to write a copy larger than this. |
| `--persist store\|idbfs` | `store` | `idbfs` makes a control build that uses Emscripten IDBFS. |

Build the SQLite demo and the test program, then run the tests:

```sh
sh examples/sqlite/build.sh     # build/sqlite.html and build/sqlite-idbfs.html
sh tests/build.sh               # build/termtest.html
npx playwright install chromium firefox webkit
npx playwright test
```

### The page

- **Terminal.** xterm.js (MIT licence) is inside the file. It shows cursor movement, the alternate screen, 256 colours and true colour. It sends raw keys, which include Esc, Ctrl and the function keys.
  The program gets the terminal size from `TIOCGWINSZ` and gets `SIGWINCH` when the size changes.
  In canonical mode (`ICANON`) the page edits the line and echoes it. A program that clears `ICANON` gets each key.
- **Save** (button, Ctrl+S, or the API). The page writes a new copy and downloads it.
  The name is the original name, the lineage id, the revision and a timestamp, for example `sqlite.1a2b3c4d.r3.20261027-153000.html`.
  If the download does not start, use "Open copy in a tab" or "Copy HTML".
- **Export files as .tar.** The page downloads the saved files as a ustar archive, with paths relative to the prefix.
  Unpack it in `$HOME` to use the files with native programs on your desktop.
- **Files panel.** It lists the saved files. You can edit a text file, write a new file, upload files, or drop files on the panel.
- **Command and working folder.** These fields edit the system entry of the store. A change applies at the next run.
- **Run again.** When the program ends, this button starts a new instance with the current files.
- **Unsaved changes.** The page shows a mark when the files differ from the last save, and warns before you close the tab.

### The program API

Include `quine.h` (the CLI adds `include/` to the include path):

```c
#include "quine.h"

QUINE_FLUSH_HOOK { fflush(my_file); }   /* optional: runs before each save */

void on_save_command(void) { quine_save(); }
```

`quine_save()` asks the page to save. If there was a key press or a click in the last 5 seconds, the page saves at once.
Else the page saves at the next key press or click, because browsers block a download with no user action.
From page JavaScript, use `window.quine.save()`.

## Store format

The store is one block in the HTML file:

```html
<script type="application/json" id="quine-store" data-version="1"
        data-filter="{&quot;prefix&quot;:&quot;/home/web&quot;,&quot;include&quot;:[&quot;**&quot;],&quot;exclude&quot;:[]}">[
{"title":"$:/quine/system","revision":3,"entry":"sqlite3","args":["demo.db"],"cwd":"/home/web","lineage":"1a2b3c4d"},
{"title":"/home/web/notes.txt","text":"hello\n"},
{"title":"/home/web/demo.db","type":"application/octet-stream;base64","text":"U1FMaXRlIGZvcm1hdCAz..."},
{"title":"/home/web/empty","type":"directory"}
]</script>
```

- The block is a JSON array with one entry (a "tiddler") on each line. Each `<` is written as `<`.
- `data-version` is the store version. If it is newer than the page can read, the page does not load the store and turns Save off. Thus the file stays as it was.
- `data-filter` is the save filter from the build: the prefix, and include and exclude globs relative to it.
- A file that is strictly valid UTF-8 is stored as text. Any other file is stored as base64 with a `type` field.
- Empty folders are stored. Mode, mtime and symbolic links are not stored.
- The system entry `$:/quine/system` holds the program name, the arguments, the working folder, the lineage id and the revision.
- The store has no compression and no encryption.
- At boot the page skips a bad entry and shows a warning. Bad entries are: no title, a title outside the filter, a `..` part, bad base64, a file over the size limit, or an entry over the count limit.

The rest of the file:

- `quine-template` holds the original shell page as JSON. It has a placeholder for each large block. Save fills the placeholders from the blocks on the page, so the engine is in the file only once. Save never copies the live page, so no runtime state goes in the copy.
- `quine-engine` is the Emscripten output (Asyncify, single thread, `SINGLE_FILE` with the Wasm as base64).
- `quine-runtime` is the optional read-only block: a ustar archive, gzipped, as base64. The page unpacks it with the browser's `DecompressionStream`.

## Limits

- **No threads.** A `file://` page cannot get `SharedArrayBuffer`. The CLI stops the build if you give `-pthread` or a shared-memory flag.
- **No network, processes or sockets.** The program has only the terminal and the in-memory filesystem.
- **Size.** Each save downloads the whole file again. The SQLite demo is 2.5 MB. Asyncify makes the Wasm larger and slower.
- **Exit status.** After the program waits for input, Emscripten reports 0 when `main` returns. The page shows only a non-zero status from `exit()`.
- **Keys.** The browser keeps some keys, for example Ctrl+W, Ctrl+T and Ctrl+N.
- **Signals.** The page sends only `SIGWINCH`. Ctrl+C in canonical mode clears the line and sends no signal.
- **Downloads.** The browser decides where the copy goes. On iOS and in some locked-down browsers, you may need "Open copy in a tab" or "Copy HTML".

## Licence

MIT. xterm.js and its fit addon are MIT. The SQLite demo uses SQLite, which is in the public domain.
