# libgit2 Wasm probe

The first libgit2 build works through quine-wasm, but `index.html` still uses the JavaScript engine.
The build produces `data/wasm-build/probe.html` as 1 offline HTML file.
This probe establishes the build path before an engine replacement.
It includes a folder bridge for adapter tests. It does not change the interface.

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
The page does not yet call this operation. The adapter test exports Init through the folder bridge.

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


## Folder bridge on 2026-10-28

The probe now includes `HtmlGitFolderBridge.importFolder(module, disk)` in its engine block.
The bridge uses the same filesystem methods as the page's `HandleFS` adapter.
The quine store still excludes the real repository.
The application still uses its JavaScript engine.

- Preserve every folder, including empty folders, in MEMFS.
  Reason: The packed probe failed without the empty `.git/refs` folder in iteration 4.
- Export only new or changed file bytes and explicit removals.
  Reason: The Init test must preserve the project file and avoid a second disk write after an unchanged operation.
- Check affected disk paths before the first export write.
  Reason: An external edit must not lose its bytes to an older MEMFS copy.

The caller supplies a fresh Wasm instance and an adapter, then awaits `importFolder`.
After a successful libgit2 operation, the caller awaits `bridge.flush()`.
The result reports file writes and path removals.
A second flush with no MEMFS change returns zero for both counts.
The bridge rejects a file-to-folder replacement or a folder-to-file replacement.
The Init operation does not require these replacements.

The bridge keeps imported bytes for exact comparisons.
It checks external edits only on affected paths. It preserves unrelated disk edits.
The check and export do not form an atomic disk transaction.
Another program can change files after the check, and a disk error can leave a partial export.
The caller must not overlap an export with another repository operation.

The Init compatibility test now exports through the bridge instead of a test-only recursive copy.
Command-line Git reads its branch and config, makes a commit, and passes strict fsck.
The test checks 5 Init calls, an unchanged second export, and the empty `.git/refs/heads` folder.
A second test checks binary bytes, file removal, folder removal, and external edits before any disk write.
It also checks that an external new file prevents removal of its parent folder.

These tests use `NodeFS`, which supplies the same methods as `HandleFS`.
They do not establish browser permission behavior or real folder handle behavior.
The next engine unit is a browser check with real folder handles before the page replaces JavaScript Init.
The interface and its 4 recorded faults stay unchanged.

### Validation and cost

The emcc and quine-wasm build passed. All 22 tests passed with `HTML_GIT_WASM=data/wasm-build/probe.html npm test`.
JavaScript syntax checks and `git diff --check` passed. This repository defines no lint or format command.
No browser or server started in this iteration.

The benchmark used the same packed fixture with 10,000 Files, 20 Commits and 10,178 objects.
The before and after runs ran separately from the tests. Each value is the median of 5 trials, in milliseconds.

| Step | Before | After |
| --- | ---: | ---: |
| JavaScript Open | 309.66 | 280.21 |
| JavaScript Refresh | 253.10 | 288.31 |
| JavaScript Status | 341.55 | 251.03 |
| JavaScript Log | 5.55 | 2.16 |
| JavaScript Tree | 3.06 | 4.60 |
| JavaScript HEAD, commit and index reads | 9.42 | 8.30 |
| Wasm instance creation | 33.14 | 24.80 |
| Folder import | 1465.02 | 4689.91 |
| First libgit2 HEAD, commit and index reads | 42.95 | 99.62 |
| Unchanged bridge export | No bridge | 320.33 |

The old test copy uses synchronous Node reads. The bridge uses asynchronous adapter reads and retains bytes for exact comparisons.
Thus the new import costs more time. These runs do not establish browser times.
The unchanged export scans MEMFS but performs zero disk writes.
Each trial checked HEAD and tree IDs against JavaScript.
The next browser check must measure import and export separately.

## Concurrent folder reads on 2026-10-28

The bridge now imports files in batches of 8 concurrent reads.
It preserves the same bytes, empty folders and export checks.
The application still uses its JavaScript engine.

- Remove the separate wait for each file read.
  Reason: The baseline benchmark required 681.69 ms to import the packed fixture through the adapter.
- Limit each batch to 8 reads and finish the batch before an error returns.
  Reason: This prevents excess open files and MEMFS writes after the caller receives an import error.

The change adds no package, option or disk write.
Folder traversal stays sequential, so nested folders cannot increase the read limit.
The test confirms concurrent reads, exact file bytes, empty folders and an unchanged export with zero writes.
It also forces a read error and confirms that all active reads finish before import rejects.
The bridge starts no further batch after that error.

The benchmark used a new packed fixture with 10,001 tracked files and 20 commits.
Both runs used the same fixture and the median of 5 trials.
The after run ran separately from the tests.
Each trial checked HEAD and tree IDs against JavaScript.

| Step | Before, ms | After, ms |
| --- | ---: | ---: |
| JavaScript Open | 63.00 | 70.81 |
| JavaScript Refresh | 55.38 | 61.09 |
| JavaScript Status | 58.26 | 61.68 |
| JavaScript Log | 0.46 | 0.60 |
| JavaScript Tree | 0.57 | 0.76 |
| JavaScript HEAD, commit and index reads | 1.98 | 2.31 |
| Wasm instance creation | 5.13 | 5.64 |
| Folder import | 681.69 | 358.28 |
| First libgit2 HEAD, commit and index reads | 17.34 | 17.72 |
| Unchanged bridge export | 63.73 | 72.96 |

Import time fell by 47% in this Node adapter test.
This result does not establish browser times.
The earlier fixture and host load differed, so these values do not replace the iteration 7 results.
The emcc and quine-wasm build passed, and all 23 tests passed with an explicit Wasm artifact path.
Syntax checks and `git diff --check` passed.
No browser or server started in this iteration.
Real browser folder handles still require verification before the page replaces JavaScript Init.

## Selected-path Stage probe on 2026-10-28

The probe now stages 1 selected file through libgit2 and exports its index and objects through the folder bridge.
Before this change, the Wasm probe supported Init and repository reads, but no Stage operation.
The new compatibility test passes 6 selected-path cases against Git and JavaScript.
The page still uses JavaScript. This change adds no interface control or package.

- Stage a literal file path, without wildcard expansion.
  Reason: The `[ab].txt` fixture must leave the separate `a.txt` file untracked.
- Preserve unrelated files and reject an untracked ignored file or an absent file.
  Reason: A Stage operation must not silently alter another path or report success for a refused path.
- Export the index and new objects through the folder bridge.
  Reason: Command-line Git must read each staged result from the same repository on disk.

The host writes UTF-8 path bytes to `/stage-path`, outside `/repo` and the quine store.
It calls `_html_git_stage_probe()` and exports only after a zero return value.
The probe uses `git_index_add_bypath` for new or modified files.
It removes a tracked index entry if its file no longer exists.
It checks ignore rules for untracked files before it creates an object.
It writes the index only after the selected operation succeeds.
The probe handles 1 file per call. Directory selection and multiple-path transactions remain outside this test.

| Compatibility case | Result |
| --- | --- |
| Modified tracked file | Git, JavaScript and Wasm produce the same tree. |
| Deleted tracked file | All 3 engines remove the same index entry. |
| Tracked file with an ignore rule | All 3 engines stage its new content. |
| Unicode path with a space | All 3 engines preserve the literal path. |
| Literal wildcard path | All 3 engines stage `[ab].txt` and leave `a.txt` untracked. |
| Binary file | All 3 engines produce the same blob and tree. |
| Unselected tracked file | Its index content stays old. Its disk content stays new. |
| Untracked ignored file or absent file | The probe refuses and the bridge exports zero files. |

The test compares tree IDs and status with command-line Git after each export.
It also runs `git fsck --full --strict` after each export.
Only `.git/index` and `.git/objects/` receive bridge file writes.
A second export without a change writes zero files.
The test uses a fresh import for each selected file.
Git verification commands can refresh `.git/index`, so reuse of the previous snapshot correctly triggers the external-edit check.

The build passed, and all 24 tests passed with an explicit Wasm artifact path.
The baseline passed all 23 tests.
Syntax checks and `git diff --check` passed. This repository defines no lint or format command.
No browser or server started in this iteration.
The real browser folder check remains necessary before the page replaces a JavaScript operation.
Attributes and conflict resolution need separate Stage checks before that replacement.
The interface retains its 4 recorded faults.

### Read benchmark

The before and after runs used the same packed fixture with 10,001 tracked files and 20 commits.
Each value is the median of 5 trials, in milliseconds.
Each trial checked HEAD and tree IDs against JavaScript.

| Step | Before, ms | After, ms |
| --- | ---: | ---: |
| JavaScript Open | 99.08 | 94.51 |
| JavaScript Refresh | 81.33 | 78.53 |
| JavaScript Status | 82.36 | 82.17 |
| JavaScript Log | 0.97 | 0.70 |
| JavaScript Tree | 0.99 | 0.85 |
| JavaScript HEAD, commit and index reads | 3.24 | 2.79 |
| Wasm instance creation | 9.10 | 7.93 |
| Folder import | 631.14 | 485.12 |
| First libgit2 HEAD, commit and index reads | 23.30 | 20.84 |
| Unchanged bridge export | 109.45 | 98.03 |

These measurements cover reads and an unchanged export. They do not measure Stage speed or establish a speed gain.

## Stage executable mode fault on 2026-10-28

Stage now preserves the executable mode from the index.
The new executable fixture failed before the change because Wasm produced a different tree from Git.
The folder bridge copies file bytes but cannot obtain executable modes from browser folder handles.
MEMFS supplies a regular file mode, which libgit2 previously trusted instead of the index mode.

- Preserve index modes when Stage reads bytes from MEMFS.
  Reason: The executable fixture exposed a wrong tree after Stage, despite correct file bytes.

The probe now sets `GIT_INDEX_CAPABILITY_NO_FILEMODE` on its index object.
It retains the other index capabilities and leaves repository config intact.
The same fixture now passes against Git and JavaScript.
The test checks executable mode `100755`, regular mode `100644`, and new file mode `100644`.
It also checks that `core.filemode` stays true.
The existing tree, status, changed-file export and strict fsck checks cover all 7 selected paths.

The quine-wasm build passed. All 24 tests passed with an explicit Wasm artifact path.
The syntax check and `git diff --check` passed.
No browser or server started. The application engine stays unchanged.

The separate benchmark used the same 10,001-file, 20-commit packed fixture after the tests completed.
Each value is the median of 5 trials, in milliseconds.

| Step | Time, ms |
| --- | ---: |
| JavaScript Open | 63.68 |
| JavaScript Refresh | 57.78 |
| JavaScript Status | 54.84 |
| JavaScript Log | 0.48 |
| JavaScript Tree | 0.59 |
| JavaScript HEAD and index reads | 2.16 |
| Wasm instance creation | 6.09 |
| Folder import | 359.99 |
| First libgit2 HEAD and index reads | 17.74 |
| Unchanged bridge export | 68.78 |

These read costs do not measure Stage speed. The measured gain is correct executable modes, rather than faster reads.

## Stage conflict fault on 2026-10-28

Stage now accepts conflicted paths, including ignored paths and deleted paths.
The new merge fixture failed before the change because Stage returned `GIT_EINVALIDSPEC` for `ignored.log`.
The probe checked only index stage 0 and treated that conflicted path as untracked.
Git stores unresolved conflicts at index stages 1, 2 and 3.

- Check all index stages before Stage treats a path as untracked.
  Reason: The merge fixture exposed a refused path that Git and JavaScript both accepted.

The change replaces the stage-0 test with a search through stages 0 to 3.
Libgit2 then resolves the conflict through its existing add or remove operation.
No new operation, package or interface control enters the application.

The test creates 5 content conflicts with command-line Git.
It resolves edited and deleted paths, with an ignored path in each case.
It preserves the unselected conflict until the final Stage call.
After each export, index entries and status match Git and JavaScript.
Each result retains `MERGE_HEAD` and passes `git fsck --full --strict`.
The final tree matches both engines.
The bridge writes only index and object files, and an unchanged export writes zero files.

The baseline passed all 24 tests. The new fixture failed before the change and passed after the change.
The quine-wasm build passed. All 25 tests passed with an explicit Wasm artifact path.
The syntax check and `git diff --check` passed.
No browser or server started. The application engine and its 4 interface faults stay unchanged.
Real browser folder handles and attribute behavior still need checks before an engine replacement.

The separate benchmark used the same packed fixture with 10,001 tracked files and 20 commits.
Each value is the median of 5 trials, in milliseconds.
Each trial checked HEAD and tree IDs against JavaScript.

| Step | Time, ms |
| --- | ---: |
| JavaScript Open | 117.96 |
| JavaScript Refresh | 104.61 |
| JavaScript Status | 103.99 |
| JavaScript Log | 0.80 |
| JavaScript Tree | 0.85 |
| JavaScript HEAD and index reads | 3.72 |
| Wasm instance creation | 9.00 |
| Folder import | 533.44 |
| First libgit2 HEAD and index reads | 30.96 |
| Unchanged bridge export | 115.65 |

These read costs do not measure Stage speed.
The measured gain is correct conflict resolution for paths that the probe previously refused.

## Stage external filter fault on 2026-10-28

Stage now refuses external filters before it changes repository bytes.
The new fixture exposed a success result from Wasm despite a different blob from Git.
The fixture assigns `filter=uppercase` and configures `filter.uppercase.clean` as `tr a-z A-Z`.
Git stores `NEW`, but JavaScript and the previous Wasm probe store `new`.
Libgit2 does not supply this external filter, and quine-wasm cannot execute an external command.

- Refuse a selected file with a nonempty `clean` or `process` command, or an unavailable required filter.
  Reason: The uppercase fixture exposed a silent wrong-result fault before this change.

The check reads the effective `filter` attribute and the repository config before the index add.
It does not execute a command or add a package.
An optional filter without a command remains a no-op, as in Git.
A file deletion needs no filter, so Stage still removes its index entry.
The test checks these 2 successful cases against Git and runs strict fsck.
It also checks 4 refusal cases and confirms identical repository bytes and zero bridge writes after each refusal.

The page still uses JavaScript, which retains this external filter limitation.
A future Wasm replacement must report the unsupported filter rather than use JavaScript for this case.
Reason: The same fixture proves that JavaScript also produces the wrong blob.
Built-in attribute conversions and real browser folder handles still need separate checks before an engine replacement.
The interface retains its 4 recorded faults.

The baseline passed all 25 tests. The new fixture failed before the change and passed after the change.
The emcc and quine-wasm build passed. All 26 tests passed with an explicit Wasm artifact path.
The syntax check and `git diff --check` passed. No browser or server started.

The separate benchmark used the same packed fixture with 10,001 tracked files and 20 commits.
Each value is the median of 5 trials, in milliseconds.
Each trial checked HEAD and tree IDs against JavaScript.

| Step | Time, ms |
| --- | ---: |
| JavaScript Open | 149.81 |
| JavaScript Refresh | 121.50 |
| JavaScript Status | 116.37 |
| JavaScript Log | 0.93 |
| JavaScript Tree | 1.52 |
| JavaScript HEAD and index reads | 4.65 |
| Wasm instance creation | 10.88 |
| Folder import | 692.07 |
| First libgit2 HEAD and index reads | 37.47 |
| Unchanged bridge export | 141.23 |

These read costs do not measure Stage speed.
The measured gain is a safe refusal where Stage previously reported success with the wrong result.

## Stage encoding fault on 2026-10-28

Stage now refuses an explicit `working-tree-encoding` value before it changes repository bytes.
The new UTF-16LE fixture failed before this change because the probe reported success.
Git converts its file bytes to UTF-8 for the blob.
The pinned libgit2 source contains no `working-tree-encoding` conversion.
JavaScript preserves the UTF-16LE bytes and produces a different tree from Git.
Thus JavaScript cannot supply a correct fallback for this file.

- Refuse a selected file with an explicit `working-tree-encoding` value.
  Reason: The UTF-16LE fixture exposed success from Stage without the required conversion.

The check uses the existing attribute check before the index add.
It adds no package, conversion code or interface control.
The refusal preserves every repository byte in MEMFS, exports zero files and preserves the file bytes on disk.
Explicitly unset and unspecified attributes still permit Stage.
Deletion still permits Stage because it needs no conversion.
These 3 accepted cases match Git trees and pass strict fsck.
The fixture changes file bytes for each accepted case so Git cannot skip the read through its index stat cache.

The baseline passed all 26 tests. The new fixture failed before the change and passed after the change.
The emcc and quine-wasm build passed. All 27 tests passed with an explicit Wasm artifact path.
The syntax check and `git diff --check` passed.
No browser or server started. The application engine and its 4 interface faults stay unchanged.
Built-in line conversions and real browser folder handles still need checks before an engine replacement.

The separate benchmark used the same packed fixture with 10,001 tracked files and 20 commits.
Each value is the median of 5 trials, in milliseconds.
Each trial checked HEAD and tree IDs against JavaScript.

| Step | Time, ms |
| --- | ---: |
| JavaScript Open | 113.71 |
| JavaScript Refresh | 105.54 |
| JavaScript Status | 105.33 |
| JavaScript Log | 0.87 |
| JavaScript Tree | 1.02 |
| JavaScript HEAD and index reads | 3.86 |
| Wasm instance creation | 9.91 |
| Folder import | 598.82 |
| First libgit2 HEAD and index reads | 29.38 |
| Unchanged bridge export | 114.33 |

These read costs do not measure Stage speed.
The measured gain is a safe refusal for an unsupported conversion that Stage previously accepted.

## Unstage probe on 2026-10-28

The Wasm probe now supports Unstage for 1 literal file path per call.
Previously the probe had no Unstage operation.
The new compatibility test passes 16 path checks against Git and JavaScript across 3 repository states.
The states cover a normal commit, unborn HEAD and an unresolved merge.

- Restore the selected index entry from HEAD, or remove it if HEAD lacks the path.
  Reason: The Files interface needs Unstage, and the compatibility fixture verifies its result against Git and JavaScript.
- Preserve file bytes, refs, merge state and all other index entries.
  Reason: A change outside the selected index entry causes an incorrect Unstage result.
- Treat each selected path as a literal path.
  Reason: The wildcard fixture must preserve the separate `x1.txt` entry.

The probe uses libgit2 tree and index APIs without a pathspec.
Thus it needs no wildcard escape code or separate reset engine.
It restores executable modes from HEAD and removes all conflict stages for the selected path.
The test also covers Unicode paths, staged additions, staged deletions and partial file edits.
Each export writes only `.git/index`. A second export writes no files.
Unknown paths fail before any repository byte changes.
Git accepts each final tree and passes strict fsck.

The existing filter fixture exposed a stale Git index cache after its filter configuration changed.
The fixture now changes the file size so Git must read the file without the former filter.
Reason: The failed run retained the former uppercase blob and produced a false tree mismatch.

The baseline passed all 27 tests. The build and all 28 tests passed after this change.
The JavaScript compatibility suite, syntax check and `git diff --check` passed.
No browser or server started. The page still uses JavaScript and retains its 4 recorded interface faults.
Real browser folder handles still need verification before an engine replacement.

The benchmark used the same packed fixture with 10,001 tracked files and 20 commits.
Each value is the median of 5 trials, in milliseconds.
Each trial checked HEAD and tree IDs against JavaScript.

| Step | Time, ms |
| --- | ---: |
| JavaScript Open | 144.90 |
| JavaScript Refresh | 129.17 |
| JavaScript Status | 124.72 |
| JavaScript Log | 1.00 |
| JavaScript Tree | 1.82 |
| JavaScript HEAD and index reads | 4.55 |
| Wasm instance creation | 10.99 |
| Folder import | 787.57 |
| First libgit2 HEAD and index reads | 37.49 |
| Unchanged bridge export | 147.83 |

These read costs do not measure Unstage speed.
The measured gain is a new Wasm operation with 16 compatible path results.

## Stage built-in conversion checks on 2026-10-28

The Wasm Stage probe now has 12 verified conversion cases against command-line Git.
JavaScript produces different blobs from Git in 8 of these cases.
Libgit2 passes all 12 cases without new conversion code.
This iteration adds compatibility evidence and retains the existing engine code.

- Verify stored blob bytes and tree IDs for built-in conversions.
  Reason: The fixture exposes 8 incorrect JavaScript results that the previous Wasm tests did not cover.
- Verify paths that require no conversion beside paths that require conversion.
  Reason: Automatic text detection must preserve binary bytes and existing CRLF blobs.
- Verify file bytes, Git status and the scope of each export.
  Reason: Correct blob bytes alone cannot exclude an incorrect file write or an unrelated index change.

| Case | Git and Wasm result | JavaScript result |
| --- | --- | --- |
| `text` | CRLF becomes LF. | CRLF stays. |
| `eol=lf` | CRLF becomes LF. | CRLF stays. |
| `text eol=crlf` | Stored content uses LF. | CRLF stays. |
| `core.autocrlf=true` | CRLF becomes LF. | CRLF stays. |
| `core.autocrlf=input` | CRLF becomes LF. | CRLF stays. |
| `-text` with `core.autocrlf=true` | CRLF stays. | Same result. |
| `text=auto` with a NUL byte | Binary bytes stay. | Same result. |
| `text=auto` with text | CRLF becomes LF. | CRLF stays. |
| `text=auto` with an existing CRLF blob | CRLF stays. | Same result. |
| `ident` | Expanded `$Id: ... $` becomes `$Id$`. | Expanded text stays. |
| `ident text` | Ident contraction and CRLF conversion both apply. | Original bytes stay. |
| `.git/info/attributes` overrides `text` with `-text` | CRLF stays. | Same result. |

Each case uses a fresh repository and changes the file size after its base commit.
The fixture sets `core.safecrlf=false` to test accepted conversions.
It does not establish behavior for `core.safecrlf=true` refusals.
Each Wasm export matches Git blob bytes, tree IDs and status.
Each export preserves file bytes and writes only the index and object files.
A second export writes zero files. Each repository passes strict fsck.

The baseline passed all 28 tests. The fresh emcc and quine-wasm build passed all 29 tests.
The syntax check and `git diff --check` passed. This repository defines no lint or format command.
No browser or server started. The page still uses JavaScript and retains its 4 recorded interface faults.
Real browser folder handles still need verification before an engine replacement.

The separate benchmark used the same packed fixture with 10,001 tracked files and 20 commits.
Each value is the median of 5 trials, in milliseconds.
Each trial checked HEAD and tree IDs against JavaScript.

| Step | Time, ms |
| --- | ---: |
| JavaScript Open | 123.53 |
| JavaScript Refresh | 106.41 |
| JavaScript Status | 103.71 |
| JavaScript Log | 1.01 |
| JavaScript Tree | 1.06 |
| JavaScript HEAD and index reads | 3.87 |
| Wasm instance creation | 12.04 |
| Folder import | 653.59 |
| First libgit2 HEAD and index reads | 31.59 |
| Unchanged bridge export | 120.79 |

These read costs do not measure Stage speed.
The measured gain is compatibility evidence for 12 cases, with 8 correct conversions that JavaScript lacks.

## Stage safecrlf checks on 2026-10-28

Libgit2 matches Git in 8 new `core.safecrlf` cases without new engine code.
The previous conversion test set `core.safecrlf=false` and did not test refusals.
JavaScript accepts all 3 changes that Git and libgit2 refuse.

- Compare accepted and refused Stage results with Git.
  Reason: An engine replacement must preserve Git refusals that protect file bytes from irreversible line conversion.
- Check repository bytes before and after each refusal.
  Reason: A refusal must preserve the index and objects, with zero bridge writes.

| Configuration and file bytes | Git and Wasm result |
| --- | --- |
| `safecrlf=true`, `autocrlf=input`, CRLF text | Refuse. |
| `safecrlf=true`, `autocrlf=true`, LF text | Refuse. |
| `safecrlf=true`, `autocrlf=true`, mixed LF and CRLF text | Refuse. |
| `safecrlf=true`, `autocrlf=input`, LF text | Accept. |
| `safecrlf=true`, `autocrlf=true`, CRLF text | Accept and store LF. |
| `safecrlf=true`, `autocrlf=true`, `-text` | Accept and preserve bytes. |
| `safecrlf=true`, `autocrlf=true`, binary bytes | Accept and preserve bytes. |
| `safecrlf=warn`, `autocrlf=input`, CRLF text | Accept and store LF. |

The test compares tree IDs and status for all cases and stored blob bytes for accepted cases.
Every case preserves file bytes and passes strict fsck.
Every refusal preserves all repository bytes and exports zero files.
The warning case checks acceptance and bytes, but does not check warning text.
Libgit2 omits the warning text in its CRLF filter.

The baseline passed all 29 tests. The fresh emcc and quine-wasm build passed all 30 tests.
The syntax check and `git diff --check` passed.
No browser or server started. The page still uses JavaScript and retains its 4 interface faults.
Real browser folder handles still need verification before an engine replacement.

The benchmark used the same packed fixture with 10,001 tracked files and 20 commits.
Each value is the median of 5 trials, in milliseconds.
Each trial checked HEAD and tree IDs against JavaScript.

| Step | Time, ms |
| --- | ---: |
| JavaScript Open | 66.40 |
| JavaScript Refresh | 56.61 |
| JavaScript Status | 59.36 |
| JavaScript Log | 0.71 |
| JavaScript Tree | 0.63 |
| JavaScript HEAD and index reads | 2.28 |
| Wasm instance creation | 6.39 |
| Folder import | 301.22 |
| First libgit2 HEAD and index reads | 18.18 |
| Unchanged bridge export | 65.35 |

These read costs do not measure Stage speed.
The measured gain is evidence for 8 compatible cases, with 3 safe refusals that JavaScript lacks.

## Commit probe on 2026-10-28

The new Commit probe records staged files with libgit2 and exports its results through the folder bridge.
The baseline had no Commit export. The new tests failed because that export did not exist.
The fresh emcc and quine-wasm build passes all 32 tests, compared with 30 baseline tests.

- Compare commit IDs, reflogs and file bytes with Git and JavaScript.
  Reason: The Commit compatibility run must detect incorrect objects, refs or file changes before an engine replacement.
- Refuse merge and rebase states in this probe.
  Reason: Those operations require state changes that this probe does not implement.
- Preserve repository bytes after a refused Commit.
  Reason: An invalid Commit must not change the index, objects or refs on disk.

The host supplies a complete message at `/commit-message` and a Git signature at `/commit-signature`.
The signature contains the name, email, timestamp and time zone.
The host supplies the same signature for the author and committer.
The host must normalize the message before this call, as the JavaScript Commit action does.

| Case | Result and evidence |
| --- | --- |
| Root commit | Commit ID, object bytes, status and reflog match Git. JavaScript produces the same ID. |
| Commit with one parent | The same checks pass. |
| Detached HEAD | The same checks pass. The branch retains its previous commit. |
| Commit with an empty tree | The same checks pass after removal of the last staged file. |
| Empty initial index | Refuse with no repository byte change and zero bridge writes. |
| Blank message | Refuse with no repository byte change and zero bridge writes. |
| Invalid signature | Refuse with no repository byte change and zero bridge writes. |
| Unchanged tree | Refuse with no repository byte change and zero bridge writes. |
| Merge state | Refuse with no repository byte change and zero bridge writes. |
| Rebase state | Refuse with no repository byte change and zero bridge writes. |
| Unmerged index | Refuse with no repository byte change and zero bridge writes. |

Each accepted Commit preserves index bytes and unstaged file bytes.
Each fixture passes strict fsck. A second bridge export writes no files.
This probe does not execute hooks or sign commits. It does not replace the JavaScript Commit action.
Merge, rebase, message cleanup and browser folder handles still need separate proof before that replacement.
The interface retains its 4 recorded faults.

The benchmark used the same packed fixture with 10,001 tracked files and 20 commits.
Each value is the median of 5 trials, in milliseconds.
Each trial checked HEAD and tree IDs against JavaScript.

| Step | Time, ms |
| --- | ---: |
| JavaScript Open | 82.37 |
| JavaScript Refresh | 66.54 |
| JavaScript Status | 58.57 |
| JavaScript Log | 0.47 |
| JavaScript Tree | 0.79 |
| JavaScript HEAD and index reads | 2.09 |
| Wasm instance creation | 6.27 |
| Folder import | 406.31 |
| First libgit2 HEAD and index reads | 18.03 |
| Unchanged bridge export | 70.87 |

These read costs do not measure Commit speed.
The measured gain is 4 compatible Commit cases and 7 refusals with no disk writes.
The syntax check and `git diff --check` passed. No browser or server started.

## Merge Commit probe on 2026-10-28

The Commit probe now completes resolved merges with results that match command-line Git.
The new fixture failed before this change because the probe refused every merge state.
The change removes that refusal and uses libgit2 to read merge parents and clear merge state.

- Preserve parent order, commit bytes, reflogs, index bytes and unstaged file bytes.
  Reason: The merge fixture must detect an incorrect commit or an unrelated file change before an engine replacement.
- Permit a merge commit whose tree matches HEAD.
  Reason: The unchanged-tree fixture records a second parent even when the resolution retains the current tree.
- Refuse unresolved conflicts and invalid merge parents before any repository byte change.
  Reason: A refused merge must preserve its index, objects, refs and merge state, with zero disk writes.
- Remove `AUTO_MERGE` after a successful merge commit.
  Reason: The first merge run exposed this stale ref after libgit2 state cleanup, although Git removes it.

| Case | Result and evidence |
| --- | --- |
| Resolved content conflict | Commit ID, parent order, object bytes, status and reflog match Git and JavaScript. |
| Resolution retains the HEAD tree | The same checks pass despite no tree change. |
| Multiple merge heads | The commit retains all 3 parents in order and matches Git. JavaScript refuses this fixture. |
| Unresolved merge | Refuse with identical repository bytes and zero bridge writes. |
| Malformed, empty or unavailable merge parent | Refuse with identical repository bytes and zero bridge writes. |

Every accepted case preserves index bytes and unstaged file bytes.
Every accepted case clears `MERGE_HEAD`, `MERGE_MSG`, `MERGE_MODE` and `AUTO_MERGE`, then passes strict fsck.
The bridge exports only changed files within `.git`. A second export writes zero files.
The tests use real Git merge conflicts and export results to real disk folders through the adapter.
Rebase state still requires separate state changes and remains outside this probe.
The page still uses JavaScript. Real browser folder handles and message cleanup still need proof before an engine replacement.
The interface retains its 4 recorded faults.

The baseline passed all 32 tests. The fresh emcc and quine-wasm build passes all 33 tests.
The syntax check and `git diff --check` passed. No browser or server started.

The benchmark used the packed fixture with 10,001 tracked files and 20 commits.
Each value is the median of 5 trials, in milliseconds.
Each trial checked HEAD and tree IDs against JavaScript.

| Step | Time, ms |
| --- | ---: |
| JavaScript Open | 120.61 |
| JavaScript Refresh | 115.02 |
| JavaScript Status | 119.61 |
| JavaScript Log | 1.20 |
| JavaScript Tree | 1.79 |
| JavaScript HEAD and index reads | 4.04 |
| Wasm instance creation | 13.25 |
| Folder import | 831.90 |
| First libgit2 HEAD and index reads | 33.28 |
| Unchanged bridge export | 133.46 |

These read costs do not measure Commit speed.
The measured gain is 3 compatible merge commits that the previous probe refused.

## Commit signature refusal on 2026-10-28

The Commit probe now refuses a required signature before any repository write.
The new test failed against the previous build because it created an unsigned commit with `commit.gpgsign=true`.
Git refused the same fixture because its configured signature program did not exist.
JavaScript also created an unsigned commit and cannot supply a correct fallback.

- Read `commit.gpgsign` before any tree or commit object write.
  Reason: The baseline fixture silently omitted the required signature and changed repository bytes.
- Refuse required signatures and invalid Boolean values without any repository byte change.
  Reason: The probe has no signature support and must preserve the repository after a refusal.

The probe uses libgit2's Boolean parser. It adds no signature program, package or interface control.
It still permits unsigned commits when the config does not require a signature.

| Config value | Result and evidence |
| --- | --- |
| `true`, `yes`, `1`, or a key without a value | Refuse with unchanged repository bytes and zero bridge writes. |
| `invalid` | Refuse with unchanged repository bytes and zero bridge writes. Git also refuses this value. |
| `false`, `no`, `0`, an empty value, or an absent key | Commit ID and object bytes match Git. Index bytes and unstaged file bytes stay unchanged. |

All 10 cases match Git status and pass strict fsck.
The 5 accepted cases also pass a second export with zero writes.
The baseline passed all 33 tests. The fresh emcc and quine-wasm build passes all 34 tests.
JavaScript syntax checks and `git diff --check` passed.
No browser or server started. The page still uses JavaScript and retains its 3 recorded interface faults.
Real browser folder handles, hooks and message cleanup still need proof before a Commit replacement.

The separate benchmark used the packed fixture with 10,001 tracked files and 20 commits.
Each value is the median of 5 trials, in milliseconds.
Each trial checked HEAD and tree IDs against JavaScript.

| Step | Time, ms |
| --- | ---: |
| JavaScript Open | 64.54 |
| JavaScript Refresh | 61.29 |
| JavaScript Status | 55.59 |
| JavaScript Log | 0.55 |
| JavaScript Tree | 0.63 |
| JavaScript HEAD and index reads | 1.98 |
| Wasm instance creation | 6.37 |
| Folder import | 295.23 |
| First libgit2 HEAD and index reads | 17.13 |
| Unchanged bridge export | 64.63 |

These read costs do not measure Commit speed.
The measured gain is 5 safe refusals that the previous probe lacked, with 5 compatible unsigned Commit cases.

## Branch Create probe on 2026-10-28

The Wasm probe now creates a branch at HEAD without a checkout.
The baseline lacked this export, so the new test failed before the change.
The probe uses libgit2 branch APIs and the folder bridge. It adds no package or separate ref parser.

- Create a branch at HEAD with no change to HEAD, the index or file bytes.
  Reason: The compatibility fixture verifies this existing page action against Git and JavaScript before an engine replacement.
- Preserve all repository bytes after a refused Branch Create.
  Reason: Invalid names, duplicate refs and external locks must not cause an unrelated write.

| Case | Result and evidence |
| --- | --- |
| Simple, nested and Unicode names | Refs and reflogs match Git and JavaScript. |
| Detached HEAD | The new branch points to HEAD. HEAD stays detached. |
| Packed refs | The new loose ref coexists with the packed refs and matches Git. |
| `core.logAllRefUpdates=false` | The export writes only the new ref and creates no reflog. |
| Existing branch, `HEAD`, dash prefix, double dot, space or `.lock` suffix | Refuse with identical repository bytes and zero bridge writes. |
| Name below an existing branch, unborn HEAD or external ref lock | Refuse with identical repository bytes and zero bridge writes. |

All 6 accepted cases preserve staged, unstaged and untracked file bytes.
The export writes only the branch ref and its optional reflog. A second export writes zero files.
All 9 refusals match Git and preserve the index and HEAD.
Each fixture passes strict fsck after the test removes its external lock, if present.

The Git reference command supplies `HEAD` explicitly, as the JavaScript reflog does.
Git records the current branch name when its command omits the start point.
Libgit2's annotated-commit API preserves the explicit `HEAD` text in the reflog.
The test compares reflog identities, object IDs and messages, but excludes timestamps and time zones.

The baseline passed all 34 tests. The fresh emcc and quine-wasm build passes all 35 tests.
The syntax check and `git diff --check` passed. No browser or server started.
The page still uses JavaScript and retains its 3 recorded interface faults.
Branch checkout and real browser folder handles still need separate proof before a Branch replacement.

The read benchmark used the packed fixture with 10,001 tracked files and 20 commits.
Each value is the median of 5 trials, in milliseconds.
Each trial checked HEAD and tree IDs against JavaScript.

| Step | Time, ms |
| --- | ---: |
| JavaScript Open | 97.34 |
| JavaScript Refresh | 79.66 |
| JavaScript Status | 83.55 |
| JavaScript Log | 1.03 |
| JavaScript Tree | 1.31 |
| JavaScript HEAD and index reads | 3.78 |
| Wasm instance creation | 10.00 |
| Folder import | 621.02 |
| First libgit2 HEAD and index reads | 18.75 |
| Unchanged bridge export | 97.50 |

These read costs do not measure Branch Create speed. The benchmark ran beside the test suite, so resource contention can affect these times.
The measured gain is 6 compatible branch results and 9 safe refusals for a new Wasm operation.

## Index Compare probe on 2026-10-28

The Wasm probe now compares HEAD with the index and produces a patch that matches Git in 8 cases.
The baseline lacked this export, so the new test failed before the change.
The probe uses libgit2 diff APIs and writes its patch to `/compare-result`, outside the repository.
It adds no package or patch formatter.

- Compare the index with HEAD, with no repository writes.
  Reason: The page exposes this action, but the previous Wasm probe could not produce its patch.
- Remove a stale patch before each call, including a refused call.
  Reason: An error must not present a previous result as the current comparison.

| Case | Result and evidence |
| --- | --- |
| Empty index with unborn HEAD | Empty patch matches Git and JavaScript. |
| Staged root files | Text and binary patches match Git and JavaScript. |
| Staged additions, deletions and edits | Patch matches Git and JavaScript, including executable mode and absent final newline. |
| Exact rename | Patch matches Git. JavaScript emits separate deletion and addition patches. |
| Rename with `diff.renames=false` | Separate deletion and addition patches match Git and JavaScript. |
| Packed objects and refs | Patch matches Git and JavaScript. |
| Detached HEAD | Patch matches Git and JavaScript. |
| Unchanged index | Empty patch matches Git and JavaScript despite unstaged edits. |

Each case excludes unstaged and untracked bytes from the patch.
Each case passes 2 calls with identical repository bytes and zero bridge writes.
Each fixture passes strict fsck. An absent repository causes refusal and removes the stale patch.
The reference command uses `git diff --cached --no-ext-diff --no-textconv --no-color`.
These tests establish the default patch format, not every diff configuration or conflict format.

The baseline passed all 35 tests. The fresh emcc and quine-wasm build passes all 36 tests.
JavaScript syntax checks and `git diff --check` passed. No browser or server started.
The page still uses JavaScript and retains its 3 recorded interface faults.
Real browser folder handles still need proof before an engine replacement.

The operation benchmark used a copy of the packed fixture with 10,001 tracked files and 20 commits.
It staged edits to 100 files. Both engines produced the same 16,450-byte patch as Git in all 5 trials.
The median Compare time was 30.79 ms for JavaScript and 11.37 ms for Wasm.
These times include patch reads but exclude instance creation, folder import and export.
Thus they do not establish an improvement in total operation time.

The separate read benchmark used the original packed fixture with no concurrent test process.
Each value is the median of 5 trials, in milliseconds.
Each trial checked HEAD and tree IDs against JavaScript.

| Step | Time, ms |
| --- | ---: |
| JavaScript Open | 61.90 |
| JavaScript Refresh | 57.96 |
| JavaScript Status | 55.39 |
| JavaScript Log | 0.42 |
| JavaScript Tree | 0.55 |
| JavaScript HEAD and index reads | 1.96 |
| Wasm instance creation | 6.00 |
| Folder import | 279.45 |
| First libgit2 HEAD and index reads | 4.46 |
| Unchanged bridge export | 61.33 |

## File Compare probe on 2026-10-28

The Wasm probe now compares the Index with files through libgit2.
The new test failed against the previous build because the File Compare export did not exist.
Both Compare exports share patch output and stale patch removal.
The page still uses JavaScript. This change adds no package or interface control.

- Compare file content against the Index without repository writes.
  Reason: The page exposes this action, but the previous Wasm probe could not produce its patch.
- Ignore file mode differences from MEMFS.
  Reason: Folder handles omit executable modes. The executable fixture must not report a false mode change.
- Refuse unsupported external filters and file encodings through the existing Stage checks.
  Reason: Those conversions can change patch bytes, but libgit2 cannot perform them in this build.

| Case | Result and evidence |
| --- | --- |
| Empty Index with unborn HEAD | Empty patch matches Git and JavaScript. |
| Staged root files | File edits, deletions and binary changes match Git and JavaScript. |
| Mixed staged and unstaged edits | Patch uses staged bytes as its base and matches Git and JavaScript. |
| Packed objects and refs | Patch matches Git and JavaScript. |
| Detached HEAD | Patch matches Git and JavaScript. |
| Unchanged files | Empty patch matches Git and JavaScript despite an executable Index entry. |
| CRLF conversion | Patch matches Git. JavaScript omits the conversion and produces a different patch. |
| Ident contraction | Patch matches Git. JavaScript omits the contraction and produces a different patch. |
| External clean filter or file encoding | Refuse with unchanged repository bytes, zero bridge writes and no stale patch. |

Every accepted case excludes untracked files.
Each of the 10 cases passes 2 calls with unchanged repository bytes and zero bridge writes.
Every fixture passes strict fsck. An absent repository also causes refusal and removes the stale patch.
The reference command uses `git diff --no-ext-diff --no-textconv --no-color` with `core.filemode=false`.
Conflict patches and other diff configuration still need separate proof.

The baseline passed all 36 tests. The fresh emcc and quine-wasm build passes all 37 tests.
JavaScript syntax checks and `git diff --check` passed. This repository defines no lint or format command.
This run started no browser or server and created no commit. The interface retains its 3 recorded faults.
Real browser folder handles still need proof before an engine replacement.

The operation benchmark used a copy of the packed fixture with 10,001 tracked files and 20 commits.
It changed 100 files without Stage. Both engines matched Git's 16,350-byte patch in all 5 trials.
The median File Compare time was 121.31 ms for JavaScript and 850.79 ms for Wasm.
These times include patch reads but exclude instance creation, folder import and export.
Thus this probe adds compatibility, but does not establish a speed gain.
The Wasm call checks attributes for every Index entry before the libgit2 diff.
A later run can measure that cost separately before any optimization.

The separate read benchmark used the unchanged packed fixture without a concurrent test process.
Each value is the median of 5 trials, in milliseconds.
Each trial checked HEAD and tree IDs against JavaScript.

| Step | Time, ms |
| --- | ---: |
| JavaScript Open | 63.96 |
| JavaScript Refresh | 59.71 |
| JavaScript Status | 55.70 |
| JavaScript Log | 0.42 |
| JavaScript Tree | 0.57 |
| JavaScript HEAD and Index reads | 2.12 |
| Wasm instance creation | 5.91 |
| Folder import | 298.00 |
| First libgit2 HEAD and Index reads | 17.18 |
| Unchanged bridge export | 63.97 |

## File Compare attribute cost on 2026-10-28

File Compare now reads both conversion attributes in one libgit2 call per path.
The shared Stage check uses `git_attr_get_many` instead of 2 separate `git_attr_get` calls.
This change removes the duplicate search through attribute files.
It adds no package, cache, interface control or engine operation.

- Read both conversion attributes in one call.
  Reason: The baseline benchmark measured 809.30 ms for Wasm File Compare on 10,001 tracked files.
- Retain the conversion refusals.
  Reason: Unsupported filters and encodings can cause incorrect blob and patch bytes.

The operation benchmark used the same packed fixture before and after the change.
The fixture contains 10,001 tracked files and 20 commits, with unstaged edits to 100 files.
Each value is the median of 5 trials.
Both engines matched Git's 16,350-byte patch in every trial, with zero bridge writes.

| Engine | Before, ms | After, ms |
| --- | ---: | ---: |
| JavaScript File Compare | 125.97 | 121.95 |
| Wasm File Compare | 809.30 | 616.92 |

Wasm File Compare took 24% less time but remained slower than JavaScript.
These times include patch reads but exclude instance creation, folder import and export.
This result does not establish a gain in total operation time.

The fresh emcc and quine-wasm build passed all 37 tests with no skipped tests.
The tests include Stage conversion precedence and File Compare refusals for unsupported filters and encodings.
JavaScript syntax checks and `git diff --check` passed. This repository defines no lint or format command.
The page still uses JavaScript. This run created no commit and started no browser or server.

The separate read benchmark used the unchanged packed fixture after the tests completed.
Each value is the median of 5 trials, in milliseconds.
Each trial checked HEAD and tree IDs against JavaScript.

| Step | Time, ms |
| --- | ---: |
| JavaScript Open | 62.43 |
| JavaScript Refresh | 54.82 |
| JavaScript Status | 54.52 |
| JavaScript Log | 0.43 |
| JavaScript Tree | 0.52 |
| JavaScript HEAD and Index reads | 2.02 |
| Wasm instance creation | 5.48 |
| Folder import | 278.25 |
| First libgit2 HEAD and Index reads | 16.25 |
| Unchanged bridge export | 59.18 |

## File Compare path checks on 2026-10-28

File Compare now uses the libgit2 diff iterator to check attributes for existing tracked paths.
This change removes the separate Index traversal and its duplicate path allocation and `stat` call.
Stage retains its existence check because Stage must accept deletions.

- Use the diff iterator's path results for File Compare.
  Reason: The baseline run took 620.93 ms and repeated the existence check for every tracked path.
- Check attributes before libgit2 compares file bytes, including unchanged files.
  Reason: An unsupported clean filter can change the correct patch even when file bytes match the Index.
- Preserve attribute precedence and accept deletions without conversion.
  Reason: The compatibility fixtures check nested overrides and deleted paths with unsupported conversion attributes.

The existing compatibility test now covers 12 accepted cases and 3 safe refusals.
The additional cases cover an unchanged file with an unsupported filter, 2 deletions, an untracked filter, and a nested override.
Every accepted case matched Git's patch. Every call preserved repository bytes and caused zero bridge writes.
The fresh emcc and quine-wasm build passed all 37 tests with no skipped tests.
The JavaScript syntax check and `git diff --check` passed.

The operation benchmark used 10,001 tracked files, 20 commits and 100 unstaged edits.
Both engines matched Git's 16,350-byte patch in every trial.
Each value is the median of 5 trials, in milliseconds.
The final measurements ran without a concurrent test process.

| Engine | Before, ms | After, ms |
| --- | ---: | ---: |
| JavaScript File Compare | 120.76 | 119.53 |
| Wasm File Compare | 620.93 | 600.57 |

The measured Wasm time fell by 3.3%. This small difference does not establish a broad speed gain.
The times exclude instance creation, folder import and export. Wasm File Compare remains slower than JavaScript.

The separate `test/benchmark.js` run used the unchanged packed fixture.
Each value is the median of 5 trials, in milliseconds.
Each trial checked HEAD and tree IDs against JavaScript.

| Step | Time, ms |
| --- | ---: |
| JavaScript Open | 63.52 |
| JavaScript Refresh | 56.69 |
| JavaScript Status | 52.53 |
| JavaScript Log | 0.43 |
| JavaScript Tree | 0.52 |
| JavaScript HEAD and Index reads | 2.16 |
| Wasm instance creation | 5.44 |
| Folder import | 273.48 |
| First libgit2 HEAD and Index reads | 16.24 |
| Unchanged bridge export | 60.59 |

The page still uses JavaScript. This run created no commit and started no browser or server.

## Commit message cleanup on 2026-10-28

The Commit probe now cleans supplied messages with libgit2 before any repository write.
The new test failed against the previous build because the probe retained excess whitespace and produced a different commit ID from Git.

- Apply the configured cleanup mode to a supplied message.
  Reason: The baseline fixture produced different commit bytes from `git commit -F`.
- Refuse an empty cleaned message, invalid config or unsupported comment forms before any repository write.
  Reason: Incorrect cleanup changes commit bytes, while a refused Commit must preserve the repository.

The change removes the earlier whitespace check and uses `git_message_prettify` for cleanup.
It adds no package, message parser or interface control.
The test supplies a message without an editor, as the page does.

| Case | Result and evidence |
| --- | --- |
| Absent mode, `default` or `whitespace` | Commit bytes and IDs match Git after whitespace cleanup. |
| `strip` with `#` or a custom `;` comment character | Commit bytes and IDs match Git after comment removal. |
| `verbatim`, including a whitespace-only message | Commit bytes and IDs match Git with the original message. |
| `scissors`, including a cut marker | Git preserves the body without an editor. The probe matches Git. |
| Message without a final newline | The probe adds the newline and matches Git. |
| Whitespace-only message or comments only with `strip` | Refuse with identical repository bytes and zero disk writes. |
| Unknown mode or a mode key without a value | Refuse with identical repository bytes and zero disk writes. |
| `strip` with `core.commentChar=auto` or a multiple-character `core.commentString` | Refuse with identical repository bytes and zero disk writes. |

Libgit2's cleanup API accepts 1 comment byte. It cannot supply Git's automatic or multiple-character comment forms through this call.
The probe also refuses non-ASCII comment characters with `strip`.
JavaScript matches the default cleanup but ignores the tested `strip` and `verbatim` modes.
Thus JavaScript cannot supply a correct fallback for those modes.

All 10 accepted cases preserve Index bytes and unstaged file bytes, match Git status and pass strict fsck.
A second export writes zero files. All 6 refusals preserve every repository byte and cause zero bridge writes.
The fresh emcc and quine-wasm build passed all 38 tests without skips.
The syntax check and `git diff --check` passed. This repository defines no lint or format command.
The first full run exposed an intermittent Stage status mismatch. The final full run passed without a Stage change.

The separate `test/benchmark.js` run used the packed fixture with 10,001 tracked files and 20 commits after the tests completed.
Each value is the median of 5 trials, in milliseconds. Each trial checked HEAD and tree IDs against JavaScript.

| Step | Time, ms |
| --- | ---: |
| JavaScript Open | 62.34 |
| JavaScript Refresh | 54.30 |
| JavaScript Status | 53.37 |
| JavaScript Log | 0.42 |
| JavaScript Tree | 0.53 |
| JavaScript HEAD and Index reads | 2.21 |
| Wasm instance creation | 5.66 |
| Folder import | 297.67 |
| First libgit2 HEAD and Index reads | 16.20 |
| Unchanged bridge export | 58.64 |

These read costs do not measure Commit speed. The gain is correct message cleanup and safe refusals in the Wasm probe.
The page still uses JavaScript. Real browser folder handles and hooks still need proof before a Commit replacement.
This run created no commit and started no browser or server.

## Commit message encoding on 2026-10-28

The Commit probe now preserves Git's configured message encoding header.
The baseline test failed because the probe omitted `encoding ISO-8859-1` and produced a different commit ID.

- Pass `i18n.commitEncoding` to libgit2 without a message converter.
  Reason: The baseline run produced different commit bytes from `git commit -F`.
- Omit the header for both UTF-8 names, regardless of case.
  Reason: The compatibility run checks Git's header omission for `UTF-8`, `utf8` and `uTf-8`.

The change replaces the fixed null encoding argument with the configured encoding.
It adds no package, interface control or message converter.
The test compares raw commit bytes rather than decoded text.

| Case | Result and evidence |
| --- | --- |
| `ISO-8859-1` with Latin-1 bytes | Commit bytes and ID match Git. Message bytes stay unchanged. |
| `ISO-8859-1` with UTF-8 bytes | Git declares the configured encoding without conversion. The probe matches Git. |
| `latin1` with Latin-1 bytes | The probe preserves the exact header name and message bytes, as Git does. |
| Absent encoding, `UTF-8`, `utf8` or `uTf-8` | The probe omits the encoding header, as Git does. |
| Empty encoding value | The probe preserves Git's empty encoding header. |

All 8 cases match Git's commit bytes, IDs, status and reflogs, and pass strict fsck.
Each case preserves Index bytes and unstaged file bytes. A second export writes zero files.
These cases do not test malformed UTF-8 with an absent encoding config.
The page still uses JavaScript. Real browser folder handles and hooks still need proof before a Commit replacement.

The fresh emcc and quine-wasm build passed all 39 tests without skips.
The JavaScript syntax check and `git diff --check` passed. This repository defines no lint or format command.

The separate `test/benchmark.js` run used the packed fixture with 10,001 tracked files and 20 commits after the tests completed.
Each value is the median of 5 trials, in milliseconds. Each trial checked HEAD and tree IDs against JavaScript.

| Step | Time, ms |
| --- | ---: |
| JavaScript Open | 66.49 |
| JavaScript Refresh | 57.12 |
| JavaScript Status | 56.53 |
| JavaScript Log | 0.51 |
| JavaScript Tree | 0.53 |
| JavaScript HEAD and Index reads | 2.21 |
| Wasm instance creation | 5.95 |
| Folder import | 294.25 |
| First libgit2 HEAD and Index reads | 16.64 |
| Unchanged bridge export | 64.10 |

These read costs do not measure Commit speed. The gain is correct Commit bytes for configured encodings.
This run created no commit and started no browser or server.

## Commit hook refusals on 2026-10-28

The Commit probe now refuses possible Commit hooks before any repository write.
The baseline test failed because Git refused a pre-commit hook, but the probe created a commit.
JavaScript also created a commit despite that hook, so it cannot supply a correct fallback.

- Check the 5 hook names that a normal Commit can call.
  Reason: The compatibility run proved that hooks can refuse a commit or require an observable action.
- Refuse a hook file regardless of its imported executable mode.
  Reason: Browser folder handles omit executable modes, so MEMFS cannot establish whether Git will call the hook.
- Refuse custom hook paths except `/dev/null`.
  Reason: A custom path can refer to host files outside the imported folder, which the probe cannot inspect.

The guard adds no shell, package, path resolver or interface control.
It checks `pre-commit`, `prepare-commit-msg`, `commit-msg`, `post-commit` and `reference-transaction`.
It leaves sample hooks and hooks for other operations alone.

| Case | Result and evidence |
| --- | --- |
| Executable pre-commit, prepare-commit-msg or commit-msg | Git refuses the fixture. Wasm refuses before any repository write. |
| Post-commit or reference-transaction | Git writes a marker through the hook. Wasm refuses because it cannot execute the hook. |
| Non-executable pre-commit | Git ignores the file. Wasm refuses because folder handles cannot preserve the executable mode. |
| Custom relative hook path | Git refuses through the custom pre-commit hook. Wasm refuses the unsupported path. |
| Custom external hook path | Wasm refuses because the folder import cannot prove the absence of external hooks. |
| Sample hook, pre-push hook or no Commit hook | Wasm commit bytes and IDs match Git. |
| `core.hooksPath=/dev/null` with a default pre-commit hook | Git disables hooks. Wasm commit bytes and IDs match Git. |

All 8 refusals preserve every repository byte and cause zero bridge writes.
All 4 accepted cases preserve Index bytes and unstaged file bytes. A second export writes zero files.
Each fixture passes strict fsck.
Custom hook paths inside the project also cause refusal in this probe, even if those paths contain no hook.
The probe cannot execute native hooks. A future host operation must supply hook support before this restriction can change.

The fresh emcc and quine-wasm build passed all 40 tests without skips.
The JavaScript syntax check and `git diff --check` passed. This repository defines no lint or format command.
The page still uses JavaScript. Real browser folder handles still need proof before an engine replacement.
This run created no commit and started no browser or server.

The separate `test/benchmark.js` run used the packed fixture with 20 commits after the tests completed.
Each value is the median of 5 trials, in milliseconds. Each trial checked HEAD and tree IDs against JavaScript.

| Step | Time, ms |
| --- | ---: |
| JavaScript Open | 69.92 |
| JavaScript Refresh | 60.76 |
| JavaScript Status | 57.17 |
| JavaScript Log | 0.57 |
| JavaScript Tree | 0.54 |
| JavaScript HEAD and Index reads | 2.20 |
| Wasm instance creation | 6.41 |
| Folder import | 342.32 |
| First libgit2 HEAD and Index reads | 16.96 |
| Unchanged bridge export | 67.22 |

These read costs do not measure Commit speed. The gain is 8 safe refusals that prevent silent hook bypass.
