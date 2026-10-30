# Protected checkouts

Agents are told to work in a worktree of their own and to leave the project's main checkout alone, but nothing stops them: **a relative path in `edit`, `write`, `ast_edit` and `read` resolves against omp's own folder, not against the `cwd` an agent gives its bash calls, and a bash call without a `cwd` runs in that same folder.** An agent whose brief says "work in `/repo/.claude/worktrees/fix`" and who types `crates/a.rs` into `edit` changes `/repo/crates/a.rs`, the main checkout, while its `git status` in the worktree shows nothing; one that runs `git checkout -- .` without a `cwd` resets it. A `protect` section makes omp-coord refuse both before they happen.

```json
"protect": { "roots": ["."], "allow": ["notes"], "agents": "sub" }
```

| Field | Default | Meaning |
|---|---|---|
| `protect.roots` | required | Folders of the checkouts to protect, relative to the config file's folder (`"."` is the folder holding `.omp-coord.json`) or absolute. |
| `protect.allow` | `[]` | Files and folders below a root, relative to it, that stay writable. |
| `protect.agents` | `"sub"` | Whose writes are judged: `"sub"` for subagents only (the main agent edits the checkout as before), or `"all"`. |

## What is refused

A call of `edit`, `write`, `ast_edit` or `apply_patch` whose target, after `~` and `..` are resolved against omp's folder and symbolic links are followed, lies inside a root and is not inside a linked worktree below it (a folder with a `.git` of its own, such as `<root>/.claude/worktrees/<name>`, including the worktree's top folder), nor under an `allow` entry. A target that holds a root (`ast_edit` on `..` or `/`) is refused too. One protected target refuses the whole call. The refusal names the resolved path, says that a relative path resolves against omp's folder, and gives the path relative to the root to put after the worktree's own path, so the agent corrects the call instead of finding the change later. Failing to write the event below never lets a refused call through.

- A symbolic link is judged by where it points: `AGENTS.local.md` in the checkout, a link to a file of another repository, is writable; a link from elsewhere into the checkout is not.
- `write` to `xd://edit`, `xd://write`, `xd://ast_edit` and `xd://apply_patch` (any case) is judged as the tool whose arguments it carries.
- Every way `edit` names a file counts: a `[path#TAG]` header (the path runs to the last `]`, so `[slug]` folders work), an `MV` destination (resolved like a header), `path`, `rename` and `move_to` (also in `edits`), and the `*** Update File:`, `*** Add File:`, `*** Delete File:`, `*** Move to:` and `*** Edit File:` lines of the patch modes.
- omp reads a path differently per tool (it unquotes a header but not a `write` path, drops a `[…#TAG]` wrapper or a copied `Update File:` and a leading `@`), so each path is judged as written and with those decorations removed, and the call is refused when either lies in the checkout. A decorated path to a worktree can therefore be refused (`write` with `"/repo/.claude/worktrees/x/a.rs"` in quotes): write it plainly.
- For `ast_edit`, a glob is judged by what comes before its first wildcard.
- Each refusal is a `write_refused` event (`agentId`, `tool`, `paths`), so the log names the agent that tried ([event log](event-log.md)).

## State-changing git

A bash command whose `git` runs in a protected checkout is refused when its subcommand changes files, the index, HEAD or a branch: `checkout`, `switch`, `reset`, `restore`, `clean`, `rebase`, `merge`, `commit`, `pull`, `cherry-pick`, `revert`, `am`, `add`, `rm`, `mv` and `apply`. Reading (`status`, `diff`, `log`, `show`, `branch`), `fetch`, `push` and `worktree` stay allowed. Where a command runs follows the call's `cwd` (omp's folder when none is given), then each `cd` and `pushd`, `git -C <dir>` and `--work-tree`, through `&&`, `||`, `;`, `|` and subshells; a folder it cannot work out (`cd "$W"`, `cd -`) is not judged. Heredoc bodies are skipped. So `cd /repo && git checkout -q -- .` is refused from any folder, and `cd /repo/.claude/worktrees/x && git checkout -- a.rs` or `git -C /repo/.claude/worktrees/x reset` is not. An agent that really must run git there passes a worktree as `cwd`.

`read` is not refused: reading the main checkout is harmless, but it is the first step of the mistake, because the agent sees a file and edits what it just read. The refusal of the edit is what corrects it.

## What it cannot see

- **Bash writes.** A shell command's file writes are not parsed: `cat > crates/a.rs`, `cp`, `mv`, `awk` with redirects and a script all get through (the `commands` rules below refuse the in-place rewriters); the rest is for [claims](coordination.md) and the agent's own `git status`. Git commands whose folder the shell computes (`cd "$W"`, `git -C $(pwd)`, a `cd` to a substitution's output, an `xargs -I{}` placeholder) and `eval` are not judged; a substitution's own commands are, quotes inside a double-quoted `$(…)` included. `xargs git …`, `sh -c '…'` (`-c`, `-lc`, `-ec`…), `sudo`/`env`/`nice`/`timeout` wrappers (also by path), `env -C`/`--chdir` and `sudo -D` are followed. Not handled: `$'…'` strings with escaped quotes, a stray `)` in a `case` pattern, and the cost of resolving folders on a real disk is not cached.
- **Eval and `lsp`.** Python and JavaScript run by the `eval` tool, and the `lsp` tool's renames and code actions, write files without a file-tool call to judge.
- A worktree that does not exist yet is the checkout's own folder to this guard (a folder below the root without a `.git` of its own), and a worktree outside every root is never judged.
- The guard fails open: a check that throws lets the call run, with a notice.

## In-place rewrites by shell

A related slip: an agent that holds the text to change makes the edit with `sed -i`, `perl -pi` or an inline Python script (`python3 - <<'E' … open(p,'w') …`) instead of the edit tool. Nothing shows what the command matched, whether the file is the one meant, or that it changed at all. `examples/omp-coord.json` has three `refuse` rules for them (`sed -i` and `gsed -i`, `perl -i`, and Python run inline with `-c`, `-` or a heredoc whose code opens a file for writing, appending or creating, or calls `write_text` or `write_bytes`), each with `"agents": "sub"` so the main agent is not judged. A `commands` rule with `agents: "sub"` applies to subagents' commands only; the default is `"all"`.

The way out is deliberate and visible: a script saved to a file with the write tool and run from a short command (`python3 /path/script.py`, `bash script.sh`) is not judged, and neither is anything a `just` recipe or other program writes. The rules read command text like every rule here ([agents' commands](queues.md#agents-commands)), so `echo "sed -i is refused"` and a commit message that mentions it are refused too, and `awk` with redirects, `tee`, `ed`, `cat <<'PY' | python3` and `perl -pe '…' -i file` get through.
