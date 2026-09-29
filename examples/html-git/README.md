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
| **branch** | Lists branches, creates a branch at `HEAD` (optionally switching to it), and switches between branches. Switching updates the working tree and index, and it refuses to run with uncommitted changes to tracked files. |
| **merge**  | Fast-forwards when possible. Otherwise it does a three-way merge: file by file, then line by line (diff3). If there are conflicts it stops and leaves standard git state: conflict markers in the files, index stages 1, 2 and 3, and `MERGE_HEAD` and `MERGE_MSG`. Resolve the files, stage them with **add**, then **commit**, or click **merge --abort**. |
| **push**   | Pushes a branch to an HTTPS remote over the git smart HTTP protocol (`git-receive-pack`) with a token. html-git builds the packfile itself. Only fast-forward pushes are allowed. After a successful push it saves the URL as `origin` and updates `refs/remotes/origin/<branch>`. |

Nothing else is implemented on purpose: no clone, fetch, pull, rebase, tags,
stash or diff viewer.

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
directories. After init, add, commit, branch, merge (fast-forward, clean
three-way, conflict then resolve, and abort) and push, it checks the result with
real git: `git fsck --full --strict`, `git status --porcelain`,
`git log --all --graph`, `git cat-file`, `git write-tree`, `git ls-files`,
`git merge-base` and `git rev-parse`. For push, it serves a bare repository
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
  conflicts. Merging and switching need a clean working tree (untracked files are
  fine).
- **Push** only fast-forwards. html-git can't fetch, so if the remote has commits
  you don't have locally, the push is rejected.
- **Unsupported repository layouts:** index version 4, split index, linked
  worktrees and submodules (where `.git` is a file), SHA-256 repositories, and
  `.git` directories outside the chosen folder.
- **Performance.** Everything is loaded into memory, so the tool is meant for
  small and medium repositories.
- **Temporary files.** Chrome writes each file through a temporary `*.crswap`
  file, which you might briefly see in the folder. html-git ignores these files.
