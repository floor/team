# Exit codes

Each command returns a code. `0` means the command did its work, `1` means it refused or a step failed, and `2` means the invocation or a file could not be read. One code can name more than one failure; each row is one failure and one way to trigger it.

| Command | Code | Meaning | Example |
| --- | --- | --- | --- |
| `add` | 0 | a dry run printed the plan | `team add worker --dry-run` |
| `add` | 1 | herdr doesn't answer | `team add worker` |
| `add` | 1 | the caller may not change the team | `team add worker` |
| `add` | 1 | the file was never approved | `team add worker` |
| `add` | 1 | the session can't be "default" | `team add worker --session default` |
| `add` | 2 | the invocation can't be read | `team add` |
| `add` | 2 | the team file can't be read | `team add worker --file missing.yaml` |
| `approve` | 0 | the comparison was printed | `team approve --show` |
| `approve` | 0 | the owner approved the file | `team approve` |
| `approve` | 1 | a seat ran it | `team approve` |
| `approve` | 1 | the answer was not the number of seats | `team approve` |
| `approve` | 1 | the approval store sits where seats work | `team approve` |
| `approve` | 2 | the invocation can't be read | `team approve extra` |
| `approve` | 2 | the overrides file can't be parsed | `team approve` |
| `approve` | 2 | the team file can't be read | `team approve --file missing.yaml` |
| `check` | 0 | every commit passed | `team check HEAD` |
| `check` | 1 | a commit was refused | `team check HEAD` |
| `check` | 2 | the invocation can't be read | `team check` |
| `check` | 2 | the pull request body can't be read | `team check HEAD --pr missing.md` |
| `check` | 2 | the ref names nothing | `team check not-a-ref` |
| `check` | 2 | the team file can't be read | `team check HEAD` |
| `conformance-adapter` | 0 | the protocol finished | `team conformance-adapter` |
| `doctor` | 0 | nothing is missing | `team doctor` |
| `doctor` | 1 | something is missing | `team doctor` |
| `doctor` | 2 | the invocation can't be read | `team doctor extra` |
| `doctor` | 2 | the team file can't be read | `team doctor --file missing.yaml` |
| `down` | 0 | a dry run printed the plan | `team down --dry-run` |
| `down` | 0 | there was nothing to stop | `team down` |
| `down` | 1 | the run was refused | `team down` |
| `down` | 1 | this call has no way to reach herdr | `team down` |
| `down` | 2 | herdr doesn't answer | `team down` |
| `down` | 2 | the agents can't be read | `team down` |
| `down` | 2 | the invocation can't be read | `team down extra` |
| `down` | 2 | the team file can't be read | `team down --file missing.yaml` |
| `init` | 0 | a skeleton was written | `team init` |
| `init` | 0 | the approved copy was restored | `team init --restore` |
| `init` | 1 | not the owner | `team init` |
| `init` | 1 | the team file already exists | `team init` |
| `init` | 1 | the team file is tracked | `team init` |
| `init` | 1 | there is nothing to restore | `team init --restore` |
| `init` | 2 | not inside a git repository | `team init` |
| `init` | 2 | the invocation can't be read | `team init extra` |
| `remove` | 0 | the seat was removed | `team remove worker` |
| `remove` | 1 | herdr doesn't answer | `team remove worker` |
| `remove` | 1 | the caller may not change the team | `team remove worker` |
| `remove` | 1 | the seat is not free | `team remove worker` |
| `remove` | 1 | the team has no such seat | `team remove missing` |
| `remove` | 2 | the edit would not validate | `team remove lead` |
| `remove` | 2 | the invocation can't be read | `team remove` |
| `remove` | 2 | the team file can't be read | `team remove worker --file missing.yaml` |
| `status` | 0 | the file, the state and the session agree | `team status` |
| `status` | 1 | there is a difference | `team status` |
| `status` | 2 | herdr doesn't answer | `team status` |
| `status` | 2 | the invocation can't be read | `team status extra` |
| `status` | 2 | the team file can't be read | `team status --file missing.yaml` |
| `team` | 0 | a command's help was printed | `team status --help` |
| `team` | 0 | help was printed | `team --help` |
| `team` | 0 | the version was printed | `team --version` |
| `team` | 1 | a command threw | `team` |
| `team` | 2 | no command was given | `team` |
| `team` | 2 | the command is unknown | `team nosuch` |
| `up` | 0 | a dry run printed the plan | `team up --dry-run` |
| `up` | 1 | the run was refused | `team up` |
| `up` | 1 | this call has no way to reach herdr | `team up` |
| `up` | 2 | the invocation can't be read | `team up extra` |
| `up` | 2 | the team file can't be read | `team up --file missing.yaml` |
| `watch` | 0 | the watch ran and stopped | `team watch` |
| `watch` | 1 | a seat passed --no-nudge | `team watch --no-nudge` |
| `watch` | 1 | a watch already runs | `team watch` |
| `watch` | 2 | the invocation can't be read | `team watch extra` |
| `watch` | 2 | the team file can't be read | `team watch --file missing.yaml` |
| `worktree` | 0 | the worktree was created | `team worktree new select-width --kind fix` |
| `worktree` | 1 | the caller may not change the team | `team worktree new task` |
| `worktree` | 1 | the file was never approved | `team worktree new task` |
| `worktree` | 1 | the workspace is shared | `team worktree new task` |
| `worktree` | 2 | the invocation can't be read | `team worktree` |
| `worktree` | 2 | the team file can't be read | `team worktree new task --file missing.yaml` |
