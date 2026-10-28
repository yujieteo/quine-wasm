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
