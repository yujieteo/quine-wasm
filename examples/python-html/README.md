# python-html

CPython in one portable HTML file. Your scripts, data and notebooks travel inside the file.

Try it with no build: download [docs/python.html](docs/python.html), open it from disk (`file://`), and type Python at the `>>>` prompt.
For numpy, scipy, pandas and matplotlib, download `python-sci.html` from the [latest release](https://github.com/yujieteo/python-html/releases/latest).

## Why

Usually, a Python environment in the browser keeps your files in one browser profile (IndexedDB), or it needs a server.
python-html keeps your files inside the HTML file.
Save writes a new copy of the whole file with your files in it.
Thus one file holds Python, the standard library, the packages and your data.
It needs no server, no network and no install.
You can send it by email, put it on a USB drive, or open it from `file://` on a different machine.

The page format and the Save function come from [quine-wasm](../../README.md).
python-html links CPython with the quine-wasm CLI, as [nvim-html](../nvim-html/README.md) does for Neovim.

## The 2 pages

| Page | What it has | Size | Where |
| --- | --- | --- | --- |
| `python.html` | CPython 3.14.10, the standard library, numpy 2.4.6 | 29.7 MB | [docs/python.html](docs/python.html) |
| `python-sci.html` | the same, and scipy 1.18.0, pandas 3.0.2, matplotlib 3.10.8 | 71.1 MB | [releases](https://github.com/yujieteo/python-html/releases/latest) |

`python-sci.html` is a release asset, because GitHub warns about files larger than 50 MB in a repository.

## What works

- **Terminal.** The Python REPL in an xterm.js terminal. `input()` and `print()` use the terminal.
- **Scripts.** Write a script in the files panel, or with Python file I/O.
  To run it at start, set the Command field to `python script.py`, then click "Run again" after you exit the REPL.
  The Command field is in the file too, so the saved copy runs the script when it opens.
- **Files.** Your files are in `/home/web`, the start folder. Save keeps all the files in this folder. "Export files as .tar" downloads them.
- **Notebook.** The Notebook button shows a notebook view: code cells, text cells, Run (Shift+Enter), Run all and outputs.
  "Write .ipynb" writes the notebook as an nbformat 4 file in `/home/web`. Then Save keeps it in the HTML file.
  Jupyter can open the `.ipynb` file from the .tar export.
  The cells run on the same Python as the terminal, so the cells and the terminal share variables.
  A cell shows its stdout, its stderr, the value of its last line, a traceback, and each open matplotlib figure as a PNG.
- **Plots** (`python-sci.html`). matplotlib uses the Agg backend. `plt.savefig("plot.png")` or `plt.savefig("plot.svg")` writes a file in `/home/web`, and Save keeps it.

## Limits

- **No network.** A page cannot open raw sockets. Thus `pip install`, `urllib.request.urlopen` and `socket` connections do not work.
  (Emscripten tries a WebSocket to the host, which a usual server does not accept.) Packages go in at build time only.
- **No processes.** `subprocess` and `os.system` do not work.
- **No threads.** A `file://` page cannot get `SharedArrayBuffer`. `threading` imports, but a thread does not start.
- **input() in a notebook cell.** It raises `RuntimeError`. Use `input()` in the terminal.
- **One task at a time.** The page and Python use one thread. When Python calculates, the page waits until Python stops or reads input.
  A notebook cell runs only when the terminal waits at a prompt.
- **No source for the libraries.** The standard library and the packages are bytecode (`.pyc`) only, as in CPython's own wasm build.
  A traceback shows the file and the line number of library code, but not the line of code. Your own files keep their source.
- **No encryption.** The store in the HTML file is plain JSON. Do not put passwords, keys or other secrets in the file.
- **Size.** Each Save downloads the whole file again: 29.7 MB or 71.1 MB, and your files.
- **Not in the standard library:** `tkinter`, `turtle`, `idlelib`, `curses`, `ensurepip`, `venv`, the `test` package and `ssl`.

## Measured start and import times

The Playwright test measures these times (Apple M-series Mac, macOS 27, `file://`).
The start time is from the page load to the first `>>>` prompt.
An import time is the first import in a new page.

| | Chromium (Playwright 1.63) | WebKit 26.6 (Playwright 1.63) |
| --- | --- | --- |
| Start `python.html` | 1.9 s | 1.6 s |
| Start `python-sci.html` | 3.0 s | 2.7 s |
| `import numpy` | 0.21 s | 0.22 s |
| `import scipy.optimize, scipy.stats` | 2.7 s | 2.0 s |
| `import pandas` | 0.8 s | 0.6 s |
| `import matplotlib.pyplot` | 0.5 s | 0.6 s |

The times change from run to run. In 3 runs, the start of `python-sci.html` took 1.2 s to 3.0 s in Chromium.

Without bytecode, the same imports took 3 to 6 times longer, because Python compiled the `.py` files at each start.
For example, `import pandas` took 2.8 s and `import numpy` took 0.5 s in Chromium.

## The packages: Pyodide's builds, not a new build

python-html uses the numpy, scipy, pandas and matplotlib wheels of [Pyodide](https://pyodide.org) 314.0.7.
The build checks the SHA-256 of each wheel ([config/packages.txt](config/packages.txt)).

The measurement:

- Pyodide's wheels are Emscripten side modules for Python 3.14 and Emscripten 5.0.3.
  python-html links CPython 3.14.10 with the same Emscripten 5.0.3, with wasm exceptions and wasm `setjmp`, as Pyodide does.
  Then the wheels load into this CPython with no change. The test above passes in Chromium and WebKit.
- A new build of scipy needs a Fortran and BLAS toolchain for Emscripten. matplotlib needs FreeType and C++ builds of 4 more packages.
  Pyodide already has these builds and tests them. Thus python-html does not build the packages again.

To add a pure-Python package, add its wheel to `config/packages.txt` with its SHA-256.
To add a package with C code, use the Pyodide 314.0.7 wheel.

## How it works

- CPython is built with CPython's own Emscripten build (`Platforms/emscripten`), then linked by the quine-wasm CLI.
  quine-wasm adds Asyncify, so a read from the terminal waits for a key, and the page continues to run.
- [patches/cpython-trampoline.patch](patches/cpython-trampoline.patch): CPython calls C functions through a trampoline in JavaScript or in a second wasm module.
  Asyncify cannot wait through such a frame, so `input()` failed. The patch makes the call in C, with the argument count that the JS API gives (`Function.length`).
- [patches/cpython-asyncify-read.patch](patches/cpython-asyncify-read.patch): CPython 3.14 reads the terminal with JSPI (`externref` promises). Asyncify cannot compile this code, so the patch removes it.
- [src/lib_pyhtml.js](src/lib_pyhtml.js): Asyncify cannot wait through the frames of a side module (numpy, pandas).
  Thus `dlopen`, `poll` and `fsync` return at once. Only a terminal read waits.
- [src/pyhtml.c](src/pyhtml.c) is the `main` function. It also has `pyhtml_kernel()`, which the notebook calls while Python waits at a prompt.
- [src/python/pyhtml_kernel.py](src/python/pyhtml_kernel.py) runs a cell and writes its outputs. [src/notebook.js](src/notebook.js) is the notebook view.
- The standard library, the packages and the licences are the quine-wasm runtime block: a read-only gzip block that the page unpacks at `/usr/local` at each start.

### Changes that quine-wasm needs

python-html does not change quine-wasm. It works around these 2 gaps:

1. **A page script hook.** quine-wasm has no option to add page JavaScript.
   Thus [scripts/add-notebook.mjs](scripts/add-notebook.mjs) appends the notebook to the `quine-shell` block after the link. Save copies that block, so each copy keeps the notebook.
   A `--page-js FILE` option in quine-wasm can replace this step.
2. **One link for many pages.** Each quine-wasm build runs `emcc`. The 2 pages use the same engine, but the build links it 2 times (about 70 s each, for Asyncify).
   An option to make a page from an engine that is already linked, with a different `--runtime`, can remove the second link.

The `dlopen`, `poll` and `fsync` changes in `src/lib_pyhtml.js` apply to each quine-wasm program that loads side modules. They can go into quine-wasm.

## Build

You need Nix and a C compiler for the host (`cc`). The build gets the pinned emsdk 5.0.3 itself.

```sh
nix develop -c npm ci
nix develop -c bash scripts/build.sh     # build/python.html and build/python-sci.html
cp build/python.html docs/python.html    # to update the demo
```

`PAGES=python` builds only `python.html`. `BUILD_DIR` sets the folder for the build (default: `build`).

## Test

```sh
npx playwright install chromium firefox webkit
npx playwright test
```

[tests/python.spec.js](tests/python.spec.js) does these tests:

1. It opens `build/python.html` from `file://`.
   It writes `count.py` in the files panel and `data.txt` with Python, and it sets the command to `python count.py`.
2. It runs the notebook, adds a cell, and writes `notebook.ipynb`.
3. It clicks Save, moves the copy to a different folder, and opens it from `file://` in a new browser profile.
   The saved file must hold only the user's files, with no profiler or cache files.
4. The copy runs `count.py`, which reads `input()` and `data.txt`. The test passes only if the copy prints `Ada: sum=10`.
5. The copy opens the notebook with its saved outputs.
6. In `build/python-sci.html`, it uses numpy, scipy, pandas and matplotlib, saves a PNG and an SVG plot, and finds them in the .tar export.
   A notebook cell shows a figure.

Results:

| Browser | Result | Where |
| --- | --- | --- |
| Chromium (Playwright 1.63) | all pass | macOS 27, local |
| WebKit 26.6 (Playwright 1.63) | all pass | macOS 27, local |
| Firefox (Playwright 1.63) | see CI | Linux, GitHub Actions |

The CI workflow builds both pages and runs the test in the 3 browsers.
Playwright Firefox does not start on macOS 27, so the Firefox result comes only from CI.

## Licences

The code of this repository is MIT ([LICENSE](LICENSE)).
The pages contain code with other licences. Their licence files are in the page:

- `/usr/local/share/licenses`: CPython (PSF licence, and the notices of the code that CPython bundles), xz, xterm.js and quine-wasm (MIT).
- `/usr/local/lib/python3.14/site-packages/*.dist-info`: each package (numpy, scipy, pandas and matplotlib are BSD-style, and the others have their own licences).
