# html-git

Git in a single HTML file. `index.html` is the whole program: markup, CSS and a
hand-written JavaScript implementation of the parts of git it needs. It uses no
libraries, vendored code or CDNs. It reads and writes the real `.git` directory of
a folder you pick, so everything it does can be inspected and continued with
ordinary command-line git.

## Supported operations

| Operation | What it does |
|-----------|--------------|
| **init**   | Creates `.git` (`HEAD`, `config`, `objects/`, `refs/`) with a chosen initial branch name. |
| **add**    | Lists changed and untracked files (respecting `.gitignore` and `.git/info/exclude`) with checkboxes; stages the selected ones. Selecting a deleted file stages its removal. |
| **commit** | `commit -m` with author name and email inputs. The name and email are prefilled from the repository's `user.name` and `user.email`, then remembered in the browser. Concludes a merge when `MERGE_HEAD` is present. |
| **diff**   | Shows a colored unified diff: unstaged changes (`git diff`), staged changes (`git diff --cached`), everything since `HEAD` (`git diff HEAD`), or any two commits (`git diff A B`). The output is in git's format: 3 lines of context, function-name hunk headers, new, deleted and binary files, mode changes and `\ No newline at end of file`. The log and stash tabs can open a commit's or a stash's changes here. |
| **stash**  | Saves uncommitted changes to tracked files and resets them to `HEAD`, like `git stash` or `git stash push -m`. Untracked files are left alone. Lists stashes with **show**, **apply**, **pop** and **drop**. Stashes are stored the way git stores them (`refs/stash` and its reflog, with WIP and index commits), so html-git and command-line git see the same list. Like git, applying brings new files back staged and other changes back unstaged. It works next to local changes as long as the stash doesn't touch those files. On a conflict it writes `Updated upstream` / `Stashed changes` markers and keeps the stash. |
| **log**    | Shows the history of `HEAD`, another branch, or all branches, newest first: id, branch and tag labels, author, date, parents and the full message. Each commit has a button that fills it in as the **reset** target. |
| **tree**   | Draws the commit graph of every branch, remote-tracking branch and tag, like `git log --graph --all --oneline`, with one colored lane per line of history. |
| **branch** | Lists branches, creates a branch at `HEAD` (optionally switching to it), and switches between branches. Switching updates the working tree and index, and it refuses to run with uncommitted changes to tracked files. |
| **merge**  | Fast-forwards when possible. Otherwise it does a three-way merge: file by file, then line by line (diff3). If there are conflicts it stops and leaves standard git state: conflict markers in the files, index stages 1, 2 and 3, and `MERGE_HEAD` and `MERGE_MSG`. Resolve the files, stage them with **add**, then **commit**, or click **merge --abort**. |
| **rebase** | Replays the current branch's commits on top of another branch, like `git rebase <branch>`. It keeps each commit's author, flattens merge commits, and drops commits whose changes are already upstream. When the target is ahead it fast-forwards. On a conflict it stops with the same state real git uses (`.git/rebase-merge`, `REBASE_HEAD`, detached `HEAD`, conflict markers, index stages). Resolve the files, stage them with **add**, then click **rebase --continue**, **--skip** or **--abort**. Command-line `git rebase --continue` or `--abort` also works on that state. |
| **reset**  | Moves the current branch to another commit, like `git reset --soft`, `--mixed` or `--hard`. It saves the old position as `ORIG_HEAD`, and `--mixed` and `--hard` also clear an unfinished merge. It also unstages selected files (`git reset -- <file>`). The target can be a branch, tag, full or abbreviated commit id, and can use `~N` and `^N` (for example `HEAD~2` or `main^2`). |
| **push**   | Pushes a branch to an HTTPS remote over the git smart HTTP protocol (`git-receive-pack`) with a token. html-git builds the packfile itself. Only fast-forward pushes are allowed. After a successful push it saves the URL as `origin` and updates `refs/remotes/origin/<branch>`. |

Nothing else is implemented on purpose: no clone, fetch, pull, interactive
rebase or creating tags.

## How to open it

1. Download `index.html` and open it straight from disk (`file://`), or serve it
   from any static web server.
2. Click **Open folder…** and choose a project folder. Allow read/write access
   when the browser asks.
3. If the folder has no repository yet, use the **init** tab. Otherwise pick an
   operation from the tabs. The **Output** panel shows what each command did.

## Supported browsers

html-git needs the File System Access API directory picker
(`window.showDirectoryPicker`), which only desktop Chromium browsers have:

- Google Chrome, Microsoft Edge, Opera, Brave and Vivaldi, version 86 or newer.
- **Not supported:** Firefox, Safari, and all mobile browsers. The page tells you
  when the API is missing.

Chrome won't let you pick some system folders, such as your home directory or
the root of a drive. Pick a project folder instead.

## Pushing and CORS

A web page can only talk to servers that send CORS headers. GitHub, GitLab,
Bitbucket and most other hosts don't send them, so a push to those hosts has to
go through a CORS proxy. Put the proxy's base URL in the **CORS proxy** field.
html-git then sends requests to `<proxy>/<remote URL without https://>`, which is
the convention [cors.isomorphic-git.org](https://cors.isomorphic-git.org) uses.
The proxy can see your token, so only use one you trust or run your own. A
self-hosted git server that sends CORS headers works without a proxy.

For GitHub, use a personal access token with write access to the repository as
the password. You can leave the username empty.

## Compatibility

Everything is implemented from scratch in `index.html`:

- **SHA-1** for object ids.
- **zlib deflate and inflate** (RFC 1950 and 1951) for loose objects and packs.
- **Objects:** loose objects, and reading packfiles (`.idx` versions 1 and 2, including `ofs-delta` and `ref-delta`).
- **Refs:** loose refs and `packed-refs`.
- **Index:** reads index versions 2 and 3, writes version 2.
- **Reflogs.**
- **Push:** pkt-line and receive-pack, plus packfile generation.

So html-git works both on repositories it created and on existing repositories
that real git has packed and garbage-collected.

The automated test (`npm test`, or `node --test test/`, needs Node 18+ and git)
loads the engine directly from `index.html` and runs it against real
directories. It covers init, add, commit, diff, stash, branch, merge
(fast-forward, clean three-way, conflict then resolve, and abort), reset (soft,
mixed, hard and unstaging), rebase (clean, dropped duplicates, conflict then
continue, skip and abort, plus real git continuing or aborting a rebase
html-git stopped), log, the commit graph and push, and checks every result with
real git: `git fsck --full --strict`, `git status --porcelain`,
`git log --all --graph`, `git rev-list`, `git cat-file`, `git write-tree`,
`git ls-files`, `git merge-base`, `git reflog` and `git rev-parse`. Diff output
must match `git diff`, `git diff --cached`, `git diff HEAD` and `git diff A B`
byte for byte, and patches for random edits must apply with `git apply`.
Stashes must work in both directions: git applies html-git's stashes and
html-git applies git's. For push, it serves a bare repository
through `git http-backend` over HTTP with `receive.fsckObjects` turned on.

## Limits

- **File modes.** Browsers can't read or set the executable bit or symlinks. New
  files are staged as `100644`. Files that are already tracked keep their mode.
  Checking out a `100755` file writes it without the executable bit, so
  command-line git may then report a mode change.
- **Line endings.** File contents are stored byte-for-byte. `core.autocrlf` and
  `.gitattributes` are ignored.
- **Merging** uses a single merge base: for criss-cross histories it picks the
  most recent one. If one side has a file where the other side has a directory,
  the merge is refused. Binary files and modify/delete cases are reported as
  conflicts. Merging, rebasing and switching need a clean working tree
  (untracked files are fine).
- **Rebase** is non-interactive only (no `-i`, `--onto` or `--autosquash`). It
  only drops a commit when the replayed change turns out empty; it doesn't
  compare patch ids up front like real git. A rebase that real git started with
  instructions other than `pick` can only be aborted in html-git.
- **Diff** uses a longest-common-subsequence line diff. When a change could be
  shown in more than one equally short way (for example, inserting a line that
  repeats its neighbor), the hunks can differ from git's, but they are still
  correct patches. Paths aren't quoted the way `core.quotePath` does it, and
  merge conflicts show as `* Unmerged path` instead of a combined diff.
- **Stash** has no `--include-untracked`, `--keep-index` or `--index`, and a
  stash with conflicts must be resolved by hand (add the files, then drop the
  stash).
- **Push** only fast-forwards. html-git can't fetch, so if the remote has commits
  you don't have locally, the push is rejected.
- **Unsupported repository layouts:** index version 4, split index, linked
  worktrees and submodules (where `.git` is a file), SHA-256 repositories, and
  `.git` directories outside the chosen folder.
- **Performance.** Everything is loaded into memory, so the tool is meant for
  small and medium repositories.
- **Temporary files.** Chrome writes each file through a temporary `*.crswap`
  file, which you might briefly see in the folder. html-git ignores these files.
