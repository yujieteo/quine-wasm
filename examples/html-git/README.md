# html-git

Git in 1 HTML file. Open `index.html` and select a project folder.
The page reads and writes the real `.git` directory.
You can inspect the results with command-line Git.
The page works offline from `file://` with no libraries or CDN requests.

## Operations

| Tab | Function |
| --- | --- |
| init | Create a repository with an initial branch name. |
| add | Stage selected files, including deleted files. The header checkbox selects or clears all files. |
| commit | Record staged changes with a message, author name and email. Complete a merge after you resolve conflicts. |
| diff | Compare the index, files, HEAD or 2 commits. |
| stash | Save changes to tracked files. Show, apply, pop or drop a stash. |
| log | Show commit messages and refs. Restore a commit or 1 file from it. |
| tree | Show a commit graph for local branches, remote branches and tags. |
| branch | Create or switch branches. |
| merge | Merge a branch. Abort a merge if necessary. |
| rebase | Replay commits on another branch. Continue, skip or abort after a conflict. |
| reset | Move the branch with soft, mixed or hard reset. Unstage selected files. |

The page does not clone, fetch, pull, push, create tags or do interactive rebase.
The **Refresh** button reads changes from other programs.
The log, tree and diff controls read their own view without a full folder scan.

## Restore old code

1. Open the **log** tab.
2. Click **Restore** for the required commit.
3. To restore 1 file, click **Choose file…**, select a path, then click **Restore file**.
4. Use **commit** to record the restored code.

Restore makes the index and files match the selected commit for the selected paths.
A full restore includes all tracked paths.
It removes tracked files that the selected commit does not contain.
Untracked files stay.
HEAD and the branch stay at the current commit.
The full history stays.

If an affected path has uncommitted changes, restore refuses before it writes files.
Restore also refuses an untracked file that blocks a restored path, including an ignored file.
Commit or stash your changes first.
Rebase changes commit history. Use restore to get an old copy of code.

## Browser

Use desktop Chrome, Edge or another Chromium browser with the File System Access API.
Firefox, Safari and mobile browsers do not supply the required directory picker.
Allow read and write access when the browser asks.
Chrome can refuse access to system folders. Select a project folder.

## Engine and build

The original engine uses JavaScript for Git data and storage operations.
An original Rust wasm module supplies SHA-1, zlib inflate and deflate, and delta apply.
It uses no external crates, packages or copied library code.
The module and the Latin subset of Inter are embedded as base64 in `index.html`.
IDs, paths and diffs use a system monospace font.

The engine reads loose objects, pack index version 2, ofs-delta and ref-delta objects,
loose refs, packed refs, reflogs, and index versions 2 and 3.
It writes index version 2.
Stashes and interrupted merges and rebases use Git-compatible state.

To build the wasm module, use Rust 1.97.0 with the `wasm32-unknown-unknown` target.
The toolchain version is fixed in `rust-toolchain.toml`.

```sh
wasm/build.sh
wasm/build.sh --check
npm test
```

The first command updates the embedded module.
The second command verifies that the source build equals the embedded bytes.
CI repeats that check and the tests.
No Rust tools are necessary to open the page.

## Tests and speed

The tests use Node 18 or later and real Git.
They compare object bytes, diffs, index trees, status, history and refs with Git.
They check merge, rebase, reset and stash results and conflict states.
Restore tests compare `git status --porcelain` and `git write-tree` with Git restore on a copy.
Safety tests check that dirty paths and untracked files remain intact after a refused restore.
Both packed delta formats and malformed wasm inputs have tests.

For a read-only speed test on an existing packed repository:

```sh
git -C /path/to/repository gc
node test/benchmark.js /path/to/repository
```

The script reports the median of 5 trials with the Node engine loader.
Open and refresh times include status, branches, configuration and stash reads.
They exclude the browser directory picker and DOM work.
Log reads 100 commits. Tree reads all reachable commits and returns 100 graph rows.
The object cache retains decoded delta bases.
Packed objects no longer cause a failed loose-object file read first.

On a packed Preact clone with 9,146 commits, these are the measured times in milliseconds.
The clone HEAD was `e736c2df9cd586a5429c7d4364f961a79c75df00`.
The test used Node 24.21.0 on macOS.

| Operation | Before | After |
| --- | ---: | ---: |
| Open | 12.27 | 11.63 |
| Refresh after an action | 6.29 | 6.80 |
| Status | 5.83 | 5.94 |
| Log | 4.08 | 1.79 |
| Tree | 223.74 | 89.33 |

The profile showed inflate, Huffman table creation and file I/O as major costs.
The tree improved most. Status and full refresh did not improve in this test.
These local engine times do not predict native browser filesystem times.

## Limits

- Browsers cannot read or set executable bits or symlinks. New files use mode `100644`. Existing entries retain their index mode.
- Restore supports regular files and executable file content. It refuses other source modes that require a change.
- Line contents stay unchanged. The engine does not apply `core.autocrlf` or `.gitattributes`.
- Merge uses 1 merge base. It refuses file and directory conflicts. Binary and modify/delete conflicts require manual resolution.
- Rebase is not interactive. It flattens merge commits and drops replayed commits when their changes are empty.
- Branch switches, merges and rebases require a clean tree. Untracked files can remain if they do not block a write.
- Diff can choose different hunks from Git when lines repeat. It does not quote paths like `core.quotePath` or show combined conflict diffs.
- Stash does not include untracked files. It has no `--keep-index` or `--index` option. Resolve conflicts, add the files, then drop the stash.
- Index version 4, split index, linked worktrees, submodules, SHA-256 repositories and external `.git` directories are not supported.
- The engine keeps objects in memory. It is intended for small and medium repositories. A wasm input or expanded object must not exceed 256 MiB.
- Chrome uses temporary `*.crswap` files for writes. The engine ignores these files.

## Font license

The UI uses an embedded Latin subset of Inter. It works offline.
IDs, paths and diffs use a system monospace font.

```text
Copyright (c) 2016 The Inter Project Authors (https://github.com/rsms/inter)

This Font Software is licensed under the SIL Open Font License, Version 1.1.
This license is copied below, and is also available with a FAQ at:
http://scripts.sil.org/OFL

-----------------------------------------------------------
SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007
-----------------------------------------------------------

PREAMBLE
The goals of the Open Font License (OFL) are to stimulate worldwide
development of collaborative font projects, to support the font creation
efforts of academic and linguistic communities, and to provide a free and
open framework in which fonts may be shared and improved in partnership
with others.

The OFL allows the licensed fonts to be used, studied, modified and
redistributed freely as long as they are not sold by themselves. The
fonts, including any derivative works, can be bundled, embedded,
redistributed and/or sold with any software provided that any reserved
names are not used by derivative works. The fonts and derivatives,
however, cannot be released under any other type of license. The
requirement for fonts to remain under this license does not apply
to any document created using the fonts or their derivatives.

DEFINITIONS
"Font Software" refers to the set of files released by the Copyright
Holder(s) under this license and clearly marked as such. This may
include source files, build scripts and documentation.

"Reserved Font Name" refers to any names specified as such after the
copyright statement(s).

"Original Version" refers to the collection of Font Software components as
distributed by the Copyright Holder(s).

"Modified Version" refers to any derivative made by adding to, deleting,
or substituting -- in part or in whole -- any of the components of the
Original Version, by changing formats or by porting the Font Software to a
new environment.

"Author" refers to any designer, engineer, programmer, technical
writer or other person who contributed to the Font Software.

PERMISSION AND CONDITIONS
Permission is hereby granted, free of charge, to any person obtaining
a copy of the Font Software, to use, study, copy, merge, embed, modify,
redistribute, and sell modified and unmodified copies of the Font
Software, subject to the following conditions:

1) Neither the Font Software nor any of its individual components,
in Original or Modified Versions, may be sold by itself.

2) Original or Modified Versions of the Font Software may be bundled,
redistributed and/or sold with any software, provided that each copy
contains the above copyright notice and this license. These can be
included either as stand-alone text files, human-readable headers or
in the appropriate machine-readable metadata fields within text or
binary files as long as those fields can be easily viewed by the user.

3) No Modified Version of the Font Software may use the Reserved Font
Name(s) unless explicit written permission is granted by the corresponding
Copyright Holder. This restriction only applies to the primary font name as
presented to the users.

4) The name(s) of the Copyright Holder(s) or the Author(s) of the Font
Software shall not be used to promote, endorse or advertise any
Modified Version, except to acknowledge the contribution(s) of the
Copyright Holder(s) and the Author(s) or with their explicit written
permission.

5) The Font Software, modified or unmodified, in part or in whole,
must be distributed entirely under this license, and must not be
distributed under any other license. The requirement for fonts to
remain under this license does not apply to any document created
using the Font Software.

TERMINATION
This license becomes null and void if any of the above conditions are
not met.

DISCLAIMER
THE FONT SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO ANY WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT
OF COPYRIGHT, PATENT, TRADEMARK, OR OTHER RIGHT. IN NO EVENT SHALL THE
COPYRIGHT HOLDER BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
INCLUDING ANY GENERAL, SPECIAL, INDIRECT, INCIDENTAL, OR CONSEQUENTIAL
DAMAGES, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF THE USE OR INABILITY TO USE THE FONT SOFTWARE OR FROM
OTHER DEALINGS IN THE FONT SOFTWARE.
```
