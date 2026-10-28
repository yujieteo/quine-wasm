# libgit2 Wasm probe

The first libgit2 build works through quine-wasm, but `index.html` still uses the JavaScript engine.
The build produces `data/wasm-build/probe.html` as 1 offline HTML file.
This probe establishes the build path before an engine replacement.
It does not supply the folder bridge or change the interface.

## Scope after review

- Build libgit2 with emcc through quine-wasm.
  Reason: The baseline page contains no Wasm engine. This run tests the required engine and build tool together.
- Compare HEAD, the commit tree ID, the index count and the commit message with Git and JavaScript.
  Reason: The compatibility run must reject a build that cannot read the current repository format.
- Keep repository bytes outside the quine store.
  Reason: An embedded repository copy causes different results between the page and command-line Git.
- Preserve upstream licence notices in the HTML file.
  Reason: A combined executable must preserve the applicable notices and the libgit2 linking exception.

The probe excludes network transports, threads, the libgit2 CLI and upstream test executables.
The build uses libgit2's bundled dependencies. It adds no package to html-git.
Quine-wasm requires its own 2 existing terminal packages to assemble the HTML file.
The test host copies a fixture into MEMFS at `/repo` and reads the result from `/probe-result`.
The quine store uses `/quine-data` and excludes all file paths.
Thus the initial store contains only its system entry.
The read probe reads repository bytes. It writes only `/probe-result`.
The Init probe creates a repository at `/repo` in MEMFS.
Its test exports that fixture to disk for command-line Git checks.
The page does not yet call this operation or write through browser folder handles.

Manual steps first tested the compiler, then the build, then Chrome.
The automated test now repeats the repository checks.
The application retains every JavaScript operation until an operation replacement passes the full compatibility suite.

## Build

Use emcc, CMake and Node. This run used Emscripten 6.0.9 and CMake 4.4.3 from Nix.
`wasm/build.sh` checks the libgit2 and quine-wasm source revisions.
Reason: This run proves those revisions with the required compiler patch.
Use a local quine-wasm copy so its package install stays inside this repository.

```sh
mkdir -p data/wasm-build
cp -R /Users/yj/src/firstmate/projects/quine-wasm data/wasm-build/quine-wasm
(cd data/wasm-build && gh-axi repo clone libgit2/libgit2)
git -C data/wasm-build/libgit2 checkout v1.9.1
npm ci --omit=dev --prefix data/wasm-build/quine-wasm
QUINE_WASM_DIR="$PWD/data/wasm-build/quine-wasm" \
  nix shell nixpkgs#emscripten nixpkgs#cmake --command sh wasm/build.sh
HTML_GIT_WASM=data/wasm-build/probe.html npm test
```

If the source copies already exist, omit the copy and clone commands.
The build script applies `wasm/libgit2-size-t.patch` once and accepts repeat builds with that patch.
Emscripten defines `size_t` as `unsigned long`, although its size equals `unsigned int` on wasm32.
Libgit2 selects an overflow intrinsic with an incompatible pointer type and fails to compile.
The patch uses type-generic overflow intrinsics for Emscripten. It preserves overflow checks.
The generated engine contains libgit2's full `COPYING` text and the local patch notice.
Quine saves preserve that engine block.

Open `data/wasm-build/probe.html` to see the libgit2 version in the quine terminal.
The automated test loads the embedded engine without the terminal and calls the exported probe.
Without a built probe, `npm test` skips this test and runs the original suite.
An explicit `HTML_GIT_WASM` path must exist. Thus the command above cannot silently skip the Wasm test.
No generated build file enters Git.

## Results on 2026-10-28

| Check | Result | Evidence |
| --- | --- | --- |
| Baseline suite | Pass | All 19 original tests passed before the change. |
| Wasm build | Pass | emcc linked libgit2. Quine-wasm emitted one HTML file with embedded Wasm. |
| Loose repository | Pass | HEAD, tree ID, index count and message matched Git and JavaScript. |
| Packed repository | Pass | The same checks passed after `git gc` and `git pack-refs`. |
| Detached HEAD | Pass | The same checks passed at the first commit with detached HEAD. |
| Index differs from HEAD | Pass | Each fixture contained a staged File and a further unstaged edit. The index count matched Git. |
| Repository bytes | Pass | Every imported file retained its bytes after the probe and after a second probe call. |
| Final suite | Pass | All 20 tests passed with an explicit Wasm artifact path. |
| Missing repository | Pass | The probe returned an error and created no result file. |
| Store boundary | Pass | The HTML store contained only its system entry. It contained no repository data. |
| Offline Chrome | Pass | Chrome completed the packed fixture probe from `file://` under Offline network emulation. No resource requests appeared. |

The Chrome fixture used a temporary MEMFS copy of a real Git repository.
It did not use a real folder picker or write files through the File System Access API.
Chrome kept `navigator.onLine` true under network emulation. The test used the Offline emulation result and the empty resource list.
The browser session stopped after the check.

The first Chrome copy omitted empty directories and failed with `could not find repository`.
The copy lacked `.git/refs` after Git packed all refs.
The second copy preserved empty directories and passed.
The automated test helper preserves all directories, including empty directories.
This result establishes a requirement for the future folder bridge.
Reason: The packed Chrome fixture failed without `.git/refs` and passed with it.

## Large repository cost

The fixture contains 10,000 Files, 20 Commits and 10,178 packed objects in 1 pack.
Its HEAD is `76034bd84903dac2957550a7c1e50d9db14f9f08`.
The fixture contains no loose objects or pack garbage.
`test/benchmark.js` reports the median of 5 trials in milliseconds.
Set `HTML_GIT_WASM` to add the probe measurements to the existing benchmark.

```sh
HTML_GIT_WASM=data/wasm-build/probe.html node test/benchmark.js /path/to/packed-repository
```

| Existing JavaScript operation | Baseline | With probe measurements |
| --- | ---: | ---: |
| Open | 56.85 | 60.19 |
| Refresh | 53.52 | 51.14 |
| Status | 50.55 | 50.93 |
| Log | 0.49 | 0.44 |
| Tree | 0.52 | 0.49 |

The application engine stays identical. These differences do not establish a speed change.

| Probe step | Median, ms |
| --- | ---: |
| JavaScript HEAD, commit and index reads after refresh | 2.04 |
| Wasm engine load and instance creation | 5.17 |
| Complete folder copy from disk to MEMFS | 168.22 |
| First libgit2 HEAD, commit and index reads | 15.15 |

The JavaScript reads use caches from the preceding refresh. The Wasm reads use a new instance.
These figures do not compare equivalent cache states.
The copy includes the full project folder and `.git`. It uses Node file reads and synchronous MEMFS writes.
It excludes the folder picker, browser handles and DOM work.
The probe checks HEAD and the tree ID against JavaScript on every benchmark trial.
The copy cost exceeds the probe cost. A future bridge should measure its copy and write costs separately.

The next engine unit is a folder bridge with changed-file writes and one compatible write operation.
The concept model and its 4 interface faults stay unchanged in this iteration.

## Init stack fault on 2026-10-28

The Init probe now completes shutdown and produces a repository that command-line Git accepts.
The previous attempt failed at shutdown with `table index is out of bounds`.
The failure came from an earlier stack overflow, rather than a shutdown callback fault.

The diagnostic build used `-g2 -sASSERTIONS=2 -sSTACK_OVERFLOW_CHECK=2` with the default 64 KiB stack.
It stopped in `git_filebuf_open`, through `config_file_write` and `repo_init_config`.
It reported a stack pointer of `0x0000e070`, below the lower limit of `0x0000ed10`.
The earlier build continued after this overflow and corrupted memory before shutdown.

- Use a 128 KiB C stack for the libgit2 probe.
  Reason: The Init run overflowed the default 64 KiB stack. The same run passed with 128 KiB.
- Keep stack checks in the normal build.
  Reason: The unchecked overflow caused a later trap that concealed its cause and could corrupt repository results.
- Test Init, repeated shutdown, and the exported repository with command-line Git.
  Reason: The previous read-only probe passed but did not exercise the config write that caused the overflow.

The change adds 64 KiB of stack space. It does not change the separate quine-wasm Asyncify stack.
The test calls Init and shutdown 5 times in one Wasm instance.
The last 4 calls preserve every repository file byte.
The fixture retains its original file and all empty repository directories after export.
Git reads `refs/heads/main`, adds the file, creates a commit, and passes `git fsck --full --strict`.
A fresh Wasm instance reads that commit and returns the same HEAD as Git.
The JavaScript engine also reads the initial branch from the exported repository.
All 21 tests pass with an explicit Wasm artifact path.

The large repository benchmark used the same 10,000 Files and 20 Commits as the earlier run.
The median of 5 trials gave these times, in milliseconds.

| Step | Median, ms |
| --- | ---: |
| JavaScript Open | 280.82 |
| JavaScript Refresh | 279.67 |
| JavaScript Status | 278.51 |
| JavaScript Log | 2.05 |
| JavaScript Tree | 3.13 |
| JavaScript HEAD, commit and index reads after refresh | 8.92 |
| Wasm engine load and instance creation | 24.12 |
| Complete folder copy from disk to MEMFS | 982.33 |
| First libgit2 HEAD, commit and index reads | 46.58 |

The run checked HEAD and tree IDs on each trial.
These times exceed the earlier run, including the unchanged JavaScript operations.
They do not establish a speed change from the stack change.

The application retains its JavaScript Init operation until the browser folder bridge passes compatibility checks.
This run changes no interface controls. The concept model retains its 4 interface faults.
