# Exit codes

Each row is one way a command ends. `0` means the work finished, `1` means the command refused or a step failed, and `2` means the invocation or a file could not be read. One `return` can be several rows when several different failures leave through it. A thrown error ends as `1`.

The check keeps this list complete against ordinary changes to the commands (a new return, a new exit, a changed code); it reads the forms this codebase uses and refuses anything else; it is not a proof against code written to deceive it (`eval`, a patched `process`, a dynamic property name). The gate catches mistakes in ordinary command code; it isn't proof against code written to evade it.

| Id | Command | Code | Meaning | Example |
| --- | --- | --- | --- | --- |
| `add.dry-budget` | `add` | 0 | a dry run would refuse the budget | `team add worker --dry-run` |
| `add.dry-run` | `add` | 0 | a dry run printed the plan | `team add worker --dry-run` |
| `add.ready` | `add` | 0 | the seat is ready | `team add worker` |
| `add.agents` | `add` | 1 | the agents can't be read | `team add worker` |
| `add.already-running` | `add` | 1 | the seat is already running | `team add worker` |
| `add.approved-copy` | `add` | 1 | the approved copy can't be read | `team add worker` |
| `add.branch-missing` | `add` | 1 | the merged branch doesn't exist | `team add --temporary --like lead --until merged:missing` |
| `add.budget` | `add` | 1 | the budget refuses the seat | `team add worker` |
| `add.caller` | `add` | 1 | the caller may not change the team | `team add worker` |
| `add.ceiling` | `add` | 1 | the approval ceiling would be passed | `team add worker` |
| `add.ceilings` | `add` | 1 | the approved ceilings can't be read | `team add worker` |
| `add.changed` | `add` | 1 | the file changed while add was checking | `team add worker` |
| `add.default-session` | `add` | 1 | the session can't be "default" | `team add worker --session default` |
| `add.differs` | `add` | 1 | the file differs from its approval | `team add worker` |
| `add.doctor` | `add` | 1 | doctor refuses the launch | `team add worker` |
| `add.file-owner` | `add` | 1 | --file is the owner's | `team add worker --file .agents/team.yaml` |
| `add.herdr` | `add` | 1 | herdr doesn't answer | `team add worker` |
| `add.lobby` | `add` | 1 | the lobby could not be created for the launch | `team add worker` |
| `add.machine` | `add` | 1 | the machine is over a launch limit | `team add worker` |
| `add.machine-again` | `add` | 1 | the machine goes over a launch limit before the seat starts | `team add worker` |
| `add.merged-base` | `add` | 1 | workspace.base is required to read a merged end | `team add --temporary --like lead --until merged:topic` |
| `add.never-approved` | `add` | 1 | the file was never approved | `team add worker` |
| `add.no-like` | `add` | 1 | the approved file has no seat to copy | `team add --temporary --like missing --until result:out.md` |
| `add.no-profile` | `add` | 1 | the seat has no launch profile | `team add worker` |
| `add.no-seat` | `add` | 1 | the approved file has no such seat | `team add missing` |
| `add.not-ready` | `add` | 1 | the launch finished without a ready seat | `team add worker` |
| `add.not-restored` | `add` | 1 | the seat can't be put back from the approved copy | `team add worker` |
| `add.placed` | `add` | 1 | the seat would be placed outside the project | `team add worker` |
| `add.result-absolute` | `add` | 1 | a result path is absolute | `team add --temporary --like lead --until result:/tmp/out.md` |
| `add.result-exists` | `add` | 1 | the result path already exists | `team add --temporary --like lead --until result:README.md` |
| `add.server` | `add` | 1 | the session's server did not start | `team add worker` |
| `add.start` | `add` | 1 | the seat has nowhere to start | `team add worker` |
| `add.stopped` | `add` | 1 | the session is stopped | `team add worker` |
| `add.until` | `add` | 1 | --until is not a result path or a merged branch | `team add --temporary --like lead --until nope` |
| `add.worktree-failed` | `add` | 1 | the worktree setup failed | `team add --temporary --like lead --until result:out.md --worktree task` |
| `add.worktree-missing` | `add` | 1 | no worktree with that name is recorded | `team add --temporary --like lead --until result:out.md --worktree missing` |
| `add.file` | `add` | 2 | the team file can't be read | `team add worker --file missing.yaml` |
| `add.file-invalid` | `add` | 2 | the team file can't be parsed | `team add worker --file team.yaml` |
| `add.invocation` | `add` | 2 | the invocation can't be read | `team add --nope` |
| `add.locked` | `add` | 2 | the locked edit does not validate | `team add worker` |
| `add.not-a-repo` | `add` | 2 | not inside a git repository | `team add worker` |
| `add.prepared` | `add` | 2 | the prepared edit does not validate | `team add worker` |
| `add.seat-name` | `add` | 2 | a seat name is required | `team add` |
| `add.temporary-flags` | `add` | 2 | --like, --until and --worktree need --temporary | `team add worker --like lead` |
| `add.temporary-unexpected` | `add` | 2 | an unexpected argument was passed to --temporary | `team add extra --temporary` |
| `answer.ready` | `answer` | 0 | the trust dialog was answered and the seat is ready | `team answer lead trust` |
| `answer.action` | `answer` | 1 | the recorded key was not sent | `team answer lead trust` |
| `answer.caller` | `answer` | 1 | the caller may not answer a trust dialog | `team answer lead trust` |
| `answer.folder` | `answer` | 1 | the dialog's folder is not the lobby's exact trust entry | `team answer lead trust` |
| `answer.label` | `answer` | 1 | the trust choice is not the recorded one | `team answer lead trust` |
| `answer.policy` | `answer` | 1 | the file leaves trust dialogs to the owner | `team answer lead trust` |
| `answer.process` | `answer` | 1 | the process in the pane is not the one team launched | `team answer lead trust` |
| `answer.recovery` | `answer` | 1 | the trust answer did not complete: the seat stays in recovery | `team answer lead trust` |
| `answer.screen` | `answer` | 1 | the pane is not the trust dialog | `team answer lead trust` |
| `answer.state` | `answer` | 1 | the seat is not waiting at a trust dialog | `team answer lead trust` |
| `answer.version` | `answer` | 1 | this version has no trust answer | `team answer lead trust` |
| `answer.configuration` | `answer` | 2 | the team file cannot be read | `team answer lead trust --file missing.yaml` |
| `answer.usage` | `answer` | 2 | the invocation is not a seat and trust | `team answer` |
| `approve.approved` | `approve` | 0 | the owner approved the file | `team approve` |
| `approve.show` | `approve` | 0 | the comparison was printed | `team approve --show` |
| `approve.answer` | `approve` | 1 | the answer was not the number of seats | `team approve` |
| `approve.check` | `approve` | 1 | an approved check cannot be resolved | `team approve` |
| `approve.key` | `approve` | 1 | the signing key can't be read | `team approve` |
| `approve.not-owner` | `approve` | 1 | a seat ran it | `team approve` |
| `approve.store` | `approve` | 1 | the approval store sits where seats work | `team approve` |
| `approve.file` | `approve` | 2 | the team file can't be read | `team approve --file missing.yaml` |
| `approve.file-invalid` | `approve` | 2 | the team file can't be parsed | `team approve --file team.yaml` |
| `approve.invocation` | `approve` | 2 | the invocation can't be read | `team approve extra` |
| `approve.not-a-repo` | `approve` | 2 | not inside a git repository | `team approve` |
| `approve.overrides` | `approve` | 2 | the overrides file can't be parsed | `team approve` |
| `approve.placed` | `approve` | 2 | a path would trust the project's parent | `team approve` |
| `approve.revalidate` | `approve` | 2 | the file does not validate | `team approve` |
| `check.passed` | `check` | 0 | every commit passed | `team check HEAD` |
| `check.refused` | `check` | 1 | a commit was refused | `team check HEAD` |
| `check.threw` | `check` | 1 | a forbidden pattern is not a regular expression | `team check HEAD` |
| `check.empty-range` | `check` | 2 | the range holds no commit | `team check HEAD..HEAD` |
| `check.file` | `check` | 2 | the team file can't be read | `team check HEAD` |
| `check.file-invalid` | `check` | 2 | the team file can't be parsed | `team check HEAD --file team.yaml` |
| `check.invocation` | `check` | 2 | the invocation can't be read | `team check` |
| `check.ledger` | `check` | 2 | the approval ledger can't be read | `team check HEAD` |
| `check.no-commit` | `check` | 2 | the ref names nothing | `team check not-a-ref` |
| `check.not-a-ref` | `check` | 2 | since is not a ref | `team check HEAD --since --bad` |
| `check.not-a-repo` | `check` | 2 | not inside a git repository | `team check HEAD` |
| `check.outside` | `check` | 2 | the check is not in a git repository | `team check HEAD --file team.yaml` |
| `check.pr-body` | `check` | 2 | the pull request body can't be read | `team check HEAD --pr missing.md` |
| `check.range` | `check` | 2 | the range can't be resolved | `team check missing..also` |
| `check.since-missing` | `check` | 2 | since doesn't name a commit | `team check HEAD --since missing` |
| `check.since-unreachable` | `check` | 2 | since is not reachable from the ref | `team check HEAD --since topic` |
| `conformance-adapter.finished` | `conformance-adapter` | 0 | the protocol finished | `team conformance-adapter` |
| `doctor.clear` | `doctor` | 0 | nothing is missing | `team doctor` |
| `doctor.missing` | `doctor` | 1 | something is missing | `team doctor` |
| `doctor.file` | `doctor` | 2 | the team file can't be read | `team doctor --file missing.yaml` |
| `doctor.file-invalid` | `doctor` | 2 | the team file can't be parsed | `team doctor --file team.yaml` |
| `doctor.invocation` | `doctor` | 2 | the invocation can't be read | `team doctor extra` |
| `doctor.not-a-repo` | `doctor` | 2 | not inside a git repository | `team doctor` |
| `down.dry-run` | `down` | 0 | a dry run printed the plan | `team down --dry-run` |
| `down.idle` | `down` | 0 | there was nothing to stop | `team down` |
| `down.stopped` | `down` | 0 | the seats that could be stopped were stopped | `team down` |
| `down.abandon` | `down` | 1 | only the owner abandons a team | `team down --abandon` |
| `down.caller` | `down` | 1 | the caller may not change the team | `team down` |
| `down.held` | `down` | 1 | a step was held | `team down` |
| `down.no-launch` | `down` | 1 | this call has no way to reach herdr | `team down` |
| `down.agents` | `down` | 2 | the agents can't be read | `team down` |
| `down.file` | `down` | 2 | the team file can't be read | `team down --file missing.yaml` |
| `down.file-invalid` | `down` | 2 | the team file can't be parsed | `team down --file team.yaml` |
| `down.herdr` | `down` | 2 | herdr doesn't answer | `team down` |
| `down.invocation` | `down` | 2 | the invocation can't be read | `team down extra` |
| `down.not-a-repo` | `down` | 2 | not inside a git repository | `team down` |
| `init.restored` | `init` | 0 | the approved copy was restored | `team init --restore` |
| `init.wrote` | `init` | 0 | a skeleton was written | `team init` |
| `init.exists` | `init` | 1 | the team file already exists | `team init` |
| `init.git-silent` | `init` | 1 | git doesn't answer for this folder | `team init` |
| `init.legacy` | `init` | 1 | the record predates signed records | `team init --restore` |
| `init.not-owner` | `init` | 1 | not the owner | `team init` |
| `init.nothing` | `init` | 1 | there is nothing to restore | `team init --restore` |
| `init.refused` | `init` | 1 | the stored record does not verify | `team init --restore` |
| `init.skeleton` | `init` | 1 | the skeleton doesn't validate | `team init` |
| `init.tracked` | `init` | 1 | the team file is tracked | `team init` |
| `init.invocation` | `init` | 2 | the invocation can't be read | `team init extra` |
| `init.not-a-repo` | `init` | 2 | not inside a git repository | `team init` |
| `release.passed` | `release` | 0 | every check passed | `team release check material@3.0.2` |
| `release.missing` | `release` | 1 | a check is missing | `team release check material@3.0.2` |
| `release.unknown` | `release` | 2 | a check is unknown | `team release check material@3.0.2` |
| `release.configuration` | `release` | 64 | the team file can't be read | `team release check material@3.0.2` |
| `release.usage` | `release` | 64 | the invocation can't be read | `team release` |
| `remove.kept` | `remove` | 0 | a stopped seat was kept | `team remove worker --keep` |
| `remove.removed` | `remove` | 0 | the seat was removed | `team remove worker` |
| `remove.temporary` | `remove` | 0 | a temporary seat was removed | `team remove worker` |
| `remove.abandon` | `remove` | 1 | only the owner abandons a seat | `team remove worker --abandon` |
| `remove.agents` | `remove` | 1 | the agents can't be read | `team remove worker` |
| `remove.busy` | `remove` | 1 | the seat is not free | `team remove worker` |
| `remove.caller` | `remove` | 1 | the caller may not change the team | `team remove worker` |
| `remove.coordinator` | `remove` | 1 | only the owner removes the coordinator's or the operator's seat | `team remove lead` |
| `remove.default-session` | `remove` | 1 | the session can't be "default" | `team remove worker --session default` |
| `remove.file-owner` | `remove` | 1 | --file is the owner's | `team remove worker --file .agents/team.yaml` |
| `remove.herdr` | `remove` | 1 | herdr doesn't answer | `team remove worker` |
| `remove.keep-temporary` | `remove` | 1 | a temporary seat is not kept in the file | `team remove worker --keep` |
| `remove.no-launch` | `remove` | 1 | this call has no way to reach herdr | `team remove worker` |
| `remove.no-profile` | `remove` | 1 | the running seat has no launch profile | `team remove worker` |
| `remove.no-seat` | `remove` | 1 | the team has no such seat | `team remove missing` |
| `remove.stop-failed` | `remove` | 1 | the seat could not be stopped | `team remove worker` |
| `remove.edit` | `remove` | 2 | the edit would not validate | `team remove lead` |
| `remove.file` | `remove` | 2 | the team file can't be read | `team remove worker --file missing.yaml` |
| `remove.file-invalid` | `remove` | 2 | the team file can't be parsed | `team remove worker --file team.yaml` |
| `remove.invocation` | `remove` | 2 | the invocation can't be read | `team remove` |
| `remove.locked` | `remove` | 2 | the locked edit does not validate | `team remove worker` |
| `remove.not-a-repo` | `remove` | 2 | not inside a git repository | `team remove worker` |
| `status.agrees` | `status` | 0 | the file, the state and the session agree | `team status` |
| `status.difference` | `status` | 1 | there is a difference | `team status` |
| `status.file` | `status` | 2 | the team file can't be read | `team status --file missing.yaml` |
| `status.file-invalid` | `status` | 2 | the team file can't be parsed | `team status --file team.yaml` |
| `status.herdr` | `status` | 2 | herdr doesn't answer | `team status` |
| `status.invocation` | `status` | 2 | the invocation can't be read | `team status extra` |
| `status.not-a-repo` | `status` | 2 | not inside a git repository | `team status` |
| `team.command-help` | `team` | 0 | a command's help was printed | `team status --help` |
| `team.help` | `team` | 0 | help was printed | `team --help` |
| `team.version` | `team` | 0 | the version was printed | `team --version` |
| `team.command-threw` | `team` | 1 | a command threw | `team init` |
| `team.no-command` | `team` | 2 | no command was given | `team` |
| `team.unknown` | `team` | 2 | the command is unknown | `team nosuch` |
| `up.dry-run` | `up` | 0 | a dry run printed the plan | `team up --dry-run` |
| `up.ready` | `up` | 0 | the launch finished | `team up` |
| `up.agents` | `up` | 1 | the agents can't be read | `team up` |
| `up.differs` | `up` | 1 | the file differs from its approval | `team up` |
| `up.doctor` | `up` | 1 | doctor refuses the launch | `team up` |
| `up.herdr` | `up` | 1 | herdr doesn't answer | `team up` |
| `up.machine` | `up` | 1 | the machine is over a launch limit | `team up` |
| `up.never-approved` | `up` | 1 | the file was never approved | `team up` |
| `up.no-launch` | `up` | 1 | this call has no way to reach herdr | `team up` |
| `up.not-owner` | `up` | 1 | only the owner runs up | `team up` |
| `up.pending` | `up` | 1 | a seat was left short of ready | `team up` |
| `up.placement` | `up` | 1 | a seat has nowhere to start | `team up` |
| `up.server` | `up` | 1 | the session's server did not start | `team up` |
| `up.stopped` | `up` | 1 | the session is stopped | `team up` |
| `up.unknown` | `up` | 1 | a running agent is not in this file's state | `team up` |
| `up.watch` | `up` | 1 | the watch did not start | `team up` |
| `up.file` | `up` | 2 | the team file can't be read | `team up --file missing.yaml` |
| `up.file-invalid` | `up` | 2 | the team file can't be parsed | `team up --file team.yaml` |
| `up.invocation` | `up` | 2 | the invocation can't be read | `team up extra` |
| `up.not-a-repo` | `up` | 2 | not inside a git repository | `team up` |
| `watch.stopped` | `watch` | 0 | the watch ran and stopped | `team watch` |
| `watch.already` | `watch` | 1 | a watch already runs | `team watch` |
| `watch.no-notify` | `watch` | 1 | a seat passed --no-notify | `team watch --no-notify` |
| `watch.no-nudge` | `watch` | 1 | a seat passed --no-nudge | `team watch --no-nudge` |
| `watch.file` | `watch` | 2 | the team file can't be read | `team watch --file missing.yaml` |
| `watch.file-invalid` | `watch` | 2 | the team file can't be parsed | `team watch --file team.yaml` |
| `watch.invocation` | `watch` | 2 | the invocation can't be read | `team watch extra` |
| `watch.not-a-repo` | `watch` | 2 | not inside a git repository | `team watch` |
| `worktree.created` | `worktree` | 0 | the worktree was created | `team worktree new task --kind fix` |
| `worktree.record-gone` | `worktree` | 0 | the record was removed after the folder was already gone | `team worktree remove task` |
| `worktree.removed` | `worktree` | 0 | the worktree was removed | `team worktree remove task` |
| `worktree.approved-copy` | `worktree` | 1 | the approved copy can't be read | `team worktree new task --kind fix` |
| `worktree.base` | `worktree` | 1 | workspace.base is not a branch here | `team worktree new task --kind fix` |
| `worktree.branch` | `worktree` | 1 | the branch already exists | `team worktree new task --kind fix` |
| `worktree.branch-name` | `worktree` | 1 | the branch name is not valid | `team worktree new task --kind fix` |
| `worktree.caller` | `worktree` | 1 | the caller may not change the team | `team worktree new task` |
| `worktree.config` | `worktree` | 1 | workspace.path and workspace.base are required | `team worktree new task` |
| `worktree.create-failed` | `worktree` | 1 | the worktree was not created | `team worktree new task --kind fix` |
| `worktree.default-session` | `worktree` | 1 | the session can't be "default" | `team worktree new task --session default` |
| `worktree.dirty` | `worktree` | 1 | the worktree has uncommitted files | `team worktree remove task` |
| `worktree.elsewhere` | `worktree` | 1 | the worktree is recorded in another session | `team worktree remove task` |
| `worktree.exists` | `worktree` | 1 | the worktree folder already exists | `team worktree new task --kind fix` |
| `worktree.fetch` | `worktree` | 1 | the base couldn't be fetched | `team worktree new task --kind fix` |
| `worktree.file-owner` | `worktree` | 1 | --file is the owner's | `team worktree new task --file .agents/team.yaml` |
| `worktree.forbidden` | `worktree` | 1 | a public project refuses that name | `team worktree new WEB-1 --kind fix` |
| `worktree.kind` | `worktree` | 1 | --kind is not a single segment | `team worktree new task --kind ../fix` |
| `worktree.kind-nowhere` | `worktree` | 1 | --kind has nowhere to go | `team worktree new task --kind fix` |
| `worktree.kind-required` | `worktree` | 1 | --kind is required | `team worktree new task` |
| `worktree.limit` | `worktree` | 1 | the worktree limit is reached | `team worktree new task --kind fix` |
| `worktree.missing` | `worktree` | 1 | no worktree with that name is recorded | `team worktree remove task` |
| `worktree.never-approved` | `worktree` | 1 | the file was never approved | `team worktree new task` |
| `worktree.occupied` | `worktree` | 1 | a seat is recorded in the worktree | `team worktree remove task` |
| `worktree.path-kind` | `worktree` | 1 | workspace.path must not contain {kind} | `team worktree new task` |
| `worktree.placeholder` | `worktree` | 1 | the branch or path pattern has an unknown placeholder | `team worktree new task` |
| `worktree.published` | `worktree` | 1 | the branch already exists on a remote | `team worktree new task --kind fix` |
| `worktree.recorded` | `worktree` | 1 | the task is already recorded | `team worktree new task --kind fix` |
| `worktree.recorded-elsewhere` | `worktree` | 1 | the task is recorded in another session | `team worktree new task --kind fix` |
| `worktree.remove-failed` | `worktree` | 1 | the worktree was not removed | `team worktree remove task` |
| `worktree.remove-task` | `worktree` | 1 | the task name is not a single segment | `team worktree remove ../task` |
| `worktree.seat` | `worktree` | 1 | --seat names no declared seat | `team worktree new task --kind fix --seat missing` |
| `worktree.seat-unapproved` | `worktree` | 1 | --seat names a seat only the file declares | `team worktree new task --kind fix --seat added-later` |
| `worktree.setup` | `worktree` | 1 | setup failed | `team worktree new task --kind fix` |
| `worktree.shared` | `worktree` | 1 | the workspace is shared | `team worktree new task` |
| `worktree.symlink` | `worktree` | 1 | the worktree follows a symlink outside the trust paths | `team worktree new task --kind fix` |
| `worktree.task` | `worktree` | 1 | the task name is not a single segment | `team worktree new ../task` |
| `worktree.tracking` | `worktree` | 1 | the base tracks something that is not a remote branch | `team worktree new task --kind fix` |
| `worktree.trust` | `worktree` | 1 | the worktree is outside the approved trust paths | `team worktree new select-width --kind fix` |
| `worktree.unpublished` | `worktree` | 1 | the worktree has commits on no remote branch | `team worktree remove task` |
| `worktree.unreadable` | `worktree` | 1 | the worktree couldn't be read | `team worktree remove task` |
| `worktree.extra` | `worktree` | 2 | an unexpected argument was given | `team worktree new task extra` |
| `worktree.file` | `worktree` | 2 | the team file can't be read | `team worktree new task --file missing.yaml` |
| `worktree.file-invalid` | `worktree` | 2 | the team file can't be parsed | `team worktree new task --file team.yaml` |
| `worktree.invocation` | `worktree` | 2 | the invocation can't be read | `team worktree --nope` |
| `worktree.not-a-repo` | `worktree` | 2 | not inside a git repository | `team worktree new task` |
| `worktree.remove-flags` | `worktree` | 2 | remove takes no --kind or --seat | `team worktree remove task --kind fix` |
| `worktree.subcommand` | `worktree` | 2 | a subcommand is required | `team worktree` |
| `worktree.task-required` | `worktree` | 2 | a task name is required | `team worktree new` |
