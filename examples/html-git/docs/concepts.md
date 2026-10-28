# html-git concepts

This document defines the current objects and records 7 faults in their actions.
Phase 1 is complete. Phase 2 has a baseline. Phase 3 has not started.
The interface and the engine stay unchanged in this iteration.

## Scope and evidence

The baseline source is commit `fbe384e2ea7c8b62063cc31c3e0ba84c4771a4e0`.
The manual Chrome run `concept-baseline` used `index.html` through `file://` on 2026-10-28.
The fixture had 1 commit, branches `main` and `topic`, 1 stash, and a changed `sample.txt`.
The fixture used memory directory handles through `htmlGit.openHandle` and the page's `HandleFS` adapter.
It did not use a real folder picker or prove access to disk.

The page showed 11 command tabs.
The Stage action changed the summary from `0 staged, 1 other` to `1 staged, 0 other`.
The log showed the root commit with `Restore` and `Choose file…` controls.
The source confirms the other action locations in the matrix below.
The compatibility run `npm test` passed all 19 tests against command-line Git.

### Requirements after review

- Preserve the current operations and their Git-compatible results.
  Reason: The 19 compatibility tests exercise repositories that command-line Git reads and changes.
- Keep the selected repository outside the HTML file, with its real `.git` directory.
  Reason: A private repository copy in the HTML file causes different results between the page and command-line Git.
- Put the current actions on their objects, with consistent names.
  Reason: The Chrome run and the source audit identified the 7 matrix faults below.

### Delete before addition

The model excludes a separate concept for each Git command.
Commands act on shared objects and do not each keep independent state.
Log and tree present the same Commit objects.
Diff is a comparison of File, Index or Commit values, not an independent stored object.
Author identity is an attribute of Commit and repository configuration, not a separate object with its own actions.
Remote branches and tags are read-only refs in the current page.
They label commits but do not add actions that the page does not support.

The interface still has the command tabs. This document does not remove them.
No new engine, library, build process or test harness is necessary for this model.
The existing manual run and compatibility tests supply the evidence for this iteration.

## Phase 1: Concepts

Technical names such as Index, HEAD and working tree retain their Git meanings.
The tables map each model name to the current code.
Actions below describe current behavior, not new features.

| Name | Purpose | State | Actions | Operational principle |
| --- | --- | --- | --- | --- |
| Repository | Connect Git state to a selected project folder. | Folder handle, configuration, HEAD, objects and refs. | Open, Initialize, Refresh. | After you open a folder, the page reads its Git state. Initialize creates `.git` if necessary. |
| File | Hold project content at a path. | Path, bytes, mode and status relative to Index and HEAD. | Stage, Unstage, Restore. | After you stage a file, Index holds its current content. A later file edit does not change that staged content. |
| Index | Select the content for the next commit. | Paths, modes, object IDs and conflict stages. | Compare, Commit. | After you commit Index, a new Commit records its tree. File content stays unchanged. |
| Commit | Preserve a project snapshot and its history. | ID, tree, parent IDs, message, author and committer. | Inspect, Compare, Restore. | After you restore a commit, selected files and Index match its tree. HEAD stays at the current commit. |
| Branch | Name a line of commit history. | Ref name, tip Commit and current status. | Create, Switch, Merge, Rebase, Reset. | After you switch to a branch, HEAD selects it and the files match its tip. |
| Stash | Preserve unfinished tracked changes for later use. | Stash ref, reflog, message, base Commit, Index snapshot and file snapshot. | Save, Compare, Apply, Pop, Drop. | After you save a stash, tracked files match HEAD. Apply restores the saved changes. |
| Merge | Combine another branch with the current branch. | Original HEAD, source Commit, message and conflicts. | Start, Complete, Abort. | After a merge conflict, you resolve and stage the files. Commit completes the merge. |
| Rebase | Replay the current branch commits on another base. | Original HEAD, branch, new base, completed commits, pending commits and stopped Commit. | Start, Continue, Skip, Abort. | After a rebase conflict, you resolve and stage the files. Continue replays the next commit. |

Merge and Rebase are concepts because they keep state across separate actions.
Reset and Restore finish in one operation and do not require separate concepts.

## Phase 1: Objects and relationships

| Object | Relationships and cardinality | Calls to action | Attributes | Current code |
| --- | --- | --- | --- | --- |
| Repository | The page selects 0 or 1 folder. A repository has 1 Index and 0 or more Files, Commits, Branches and Stashes. | Open, Initialize, Refresh. | Folder name, repository state, HEAD, current branch, counts and origin URL. | `Repo`, `HandleFS`, `openHandle`, `repoInfo`. |
| File | A path has 0 or 1 current file and 0 or more Index conflict entries. Each Commit tree contains 0 or 1 entry per path. | Stage, Unstage, Restore from Commit. | Path, XY status and content. Existing Index entries also retain mode. | `status().entries`, `fileRows`, `unstageList`, `restoreFilePicker`. |
| Index | Each repository has 1 Index. Index contains 0 or more path entries. Commit consumes its resolved tree. | Compare with HEAD or files, Commit. | Staged paths, modes, object IDs and conflict stages. | `readIndex`, `stagedList`, `diffMode`, `commitBtn`. |
| Commit | Each Commit has 1 tree and 0 or more parents. Each Branch names 1 tip, except an unborn branch. | Inspect history, Compare, Restore all paths or selected paths. | ID, subject, message, author, date, parents and ref labels. | `readCommit`, `logList`, `graph`, `showDiff`, `restoreCommit`. |
| Branch | A repository has 0 or more local Branch refs. HEAD selects 1 Branch or names a detached Commit. | Create, Switch, Merge into current Branch, Rebase current Branch, Reset current Branch. | Name, tip ID and current marker. | `branches`, `branchList`, `mergeFrom`, `rebaseOnto`, `resetTarget`. |
| Stash | A repository has 0 or more ordered Stashes. Each Stash refers to a base Commit and an Index Commit. | Save tracked changes, Compare, Apply, Pop, Drop. | Position, message, date and snapshot IDs. | `stashList`, `stashPush`, `stashApply`, `stashDrop`. |
| Merge | A repository has 0 or 1 active Merge. Merge refers to original and source Commits and 0 or more conflicted Files. | Complete through Commit, Abort. | Source ID, message and unresolved paths. | `MERGE_HEAD`, `mergeNotice`, `mergeState`, `abortBtn`. |
| Rebase | A repository has 0 or 1 active Rebase. Rebase refers to 1 original tip, 1 base and an ordered commit list. | Continue, Skip, Abort. | Branch name, base ID, stopped Commit and progress. | `rebaseState`, `rebaseCtl`, `.git/rebase-merge`. |

Save creates a Stash from the repository's tracked files and Index.
Start creates Merge or Rebase state through the Branch action.
Compare on a non-root Commit uses its first parent in the current log.
The root Commit has no Compare control. The matrix records this gap as E1.
File Restore selects its source Commit before its path.
An absent File can still have an Index entry, such as a staged deletion.

## Phase 1: Synchronisations

| Trigger | Result in other concepts |
| --- | --- |
| Repository Open or Refresh | The page reads File status, Index, Branch refs, HEAD, Stashes, Merge and Rebase state. |
| File Stage | Index records file content or a deletion. A resolved file replaces its conflict entries. |
| File Unstage | Index returns the selected path to HEAD content. The file on disk stays unchanged. |
| Index Commit | A new Commit records the Index tree. The current Branch advances, or detached HEAD advances. |
| Commit during Merge | The new Commit has both parents. The engine clears Merge state. |
| Branch Switch | HEAD selects the Branch. Index and files match its tip. Local changes or untracked collisions can prevent the switch. |
| Branch Merge | A fast-forward advances the Branch. A clean merge creates a Commit. A conflict creates Merge state and Index conflict entries. |
| Merge Abort | Index and tracked files return to the original tip. The engine clears Merge state. |
| Branch Rebase | The engine replays Commits and advances the Branch. A conflict preserves Rebase state and Index conflict entries. |
| Rebase Continue or Skip | The engine completes or omits the stopped Commit, then resumes the commit list. |
| Rebase Abort | The engine restores the original Branch, Index and tracked files, then clears Rebase state. |
| Branch Reset | The Branch or detached HEAD moves. Mixed reset also changes Index. Hard reset also changes tracked files. |
| Commit or File Restore | Index and selected files match the source Commit. Branch and HEAD stay unchanged. |
| Stash Save | A new Stash records tracked changes. Index and tracked files return to HEAD. Untracked files stay. |
| Stash Apply or Pop | Index and files receive saved changes. A successful Pop also removes the Stash. A conflict preserves it. |
| Stash Drop | The engine removes the selected reflog entry and updates the stash ref. Project files stay unchanged. |

## Posture

The app has a sovereign posture because users inspect history and resolve changes across several related objects.
This posture is a design decision, not a measured claim about session duration.
Phase 3 will check that content occupies the largest area at 375 px and 1280 px.
No Phase 3 check has a pass result in this iteration.

## Phase 2: Object-action matrix before the change

The tables below form 1 matrix, split by object family for readability.
Action columns outside an object's family are `n/a`.
`n/a` means that the action has no separate meaning for that object in the current app.
`D` identifies a displaced action. `I` identifies an inconsistent name or location. `E` identifies an expected empty cell.
Each marked cell counts as 1 fault. The count does not multiply by the number of files, branches or commits.
Batch controls beside their file list count as controls on that list.
Source Commit selection before File Restore does not count as displacement.
Create and Save controls act on their collections because their new objects do not yet exist.

| Object | Open | Initialize | Refresh | Stage | Unstage | Compare | Commit |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Repository | Header `openBtn` | init `initBtn` | Header `refreshBtn` | n/a | n/a | n/a | n/a |
| File | n/a | n/a | n/a | add `fileRows` + `addBtn` | **I1:** reset `unstageList` + `unstageBtn` | n/a | n/a |
| Index | n/a | n/a | n/a | n/a | n/a | **D1:** diff `diffMode`, separate from `stagedList` | commit `stagedList` + `commitBtn` |

| Object | Inspect | Create | Switch | Compare | Restore | Merge | Rebase | Reset |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Commit | log `logList`, tree `graph` | n/a | n/a | log row `show changes`. **E1:** root row has no control | log row `Restore`, `Choose file…`, `Restore file` | n/a | n/a | n/a |
| Branch | Repository summary, branch `branchList`, log `logFrom` | branch `createBranchBtn` | Branch row `switch` | n/a | n/a | **D2:** merge `mergeFrom` + `mergeBtn` | **D3:** rebase `rebaseOnto` + `rebaseBtn` | **D4:** reset `resetTarget` + `resetBtn` |

| Object | Save | Compare | Apply | Pop | Drop | Complete | Continue | Skip | Abort |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Stash | stash `stashBtn` | **I2:** Stash row `show` | Stash row `apply` | Stash row `pop` | Stash row `drop` | n/a | n/a | n/a | n/a |
| Merge | n/a | n/a | n/a | n/a | n/a | commit `mergeNotice` + `commitBtn` | n/a | n/a | merge `mergeState` + `abortBtn` |
| Rebase | n/a | n/a | n/a | n/a | n/a | n/a | rebase `rebaseContinue` | rebase `rebaseSkip` | rebase `rebaseAbort` |

### Fault evidence

| Fault | Evidence | Effect |
| --- | --- | --- |
| I1 | Stage acts on `fileRows` in add. Unstage acts on another path list in reset. | The same File requires different locations for opposite actions. |
| D1 | `stagedList` shows Index paths without Compare. `diffMode` provides the comparison in diff. | Users leave the Index list to inspect its changes. |
| D2 | `branchList` provides Switch. `mergeFrom` repeats Branch choices in merge. | Users leave the Branch list to merge a Branch. |
| D3 | `branchList` has no Rebase control. `rebaseOnto` repeats Branch choices in rebase. | Users leave the Branch list to select a new base. |
| D4 | The current Branch has no Reset control. `resetTarget` accepts the target in reset. | Users leave the Branch object to move its tip. |
| I2 | Commit rows name Compare `show changes`. Stash rows name Compare `show`. Both call `showDiff`. | The same action has different names for different objects. |
| E1 | The Chrome log showed a root Commit without `show changes`. The source omits this control when `c.parents` is empty. | Users cannot inspect the initial file changes from that Commit. |

The baseline has 4 displaced actions, 2 inconsistent actions and 1 expected empty cell: 7 faults.
E1 applies the current Compare action to root Commits. It does not require a new action kind.
Reason: The Chrome log showed the initial snapshot without the Compare action that other Commits provide.
This matrix does not require new actions such as Branch deletion or file content edits.
Merge completion has its own Merge notice beside Commit, so it does not add a displacement fault.

## Phase 2: State after this iteration

The matrix above still describes every action location. The fault count stays at 7.
No interface change or fault reduction occurred.
The next interface change can address I1 with Stage and Unstage beside the same File list.
Reason: The manual Stage run and the source audit show the separate locations directly.
Phase 2 stays incomplete until the interface resolves the faults or the owner accepts each fault.
Phase 3 then requires separate checks and screenshots at both widths.

## Engine boundary for a later iteration

The current `git-core` script implements every engine operation in JavaScript.
The local quine-wasm README describes an embedded Emscripten engine and a separate JSON store.
Its only file under `docs/` is the SQLite example HTML file.
The repository must not enter that JSON store. MEMFS will hold a temporary copy of the selected folder.
Reason: A saved copy of repository data inside the HTML file breaks the shared repository requirement.
The folder adapter will remain responsible for reads and changed-file writes to disk.
This iteration does not build libgit2, select a Wasm operation or measure engine speed.
The existing `test/git-compat.test.js` and `test/benchmark.js` remain the comparison tools for that work.
