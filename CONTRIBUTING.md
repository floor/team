# Contributing to team

## Review and CI

Hosted CI runs the Linux test job (`test (ubuntu-latest)`) and the commit and pull request checks on every pull request.

To avoid runner queue delays on pull requests, the hosted macOS job does not run on pull requests. Instead, before a merge, the author quotes their own full `bun run ci` run on the exact head in the pull request, and at least one reviewer who is not the author runs the full `bun run ci` on a macOS machine on the exact head under review, quoting its exit status and final line in their review. A review without that quote is not an approval.

At least one reviewer—rather than every reviewer—runs the suite because one test in the suite reads the machine's process table, which a sandboxed reviewer cannot do; a reviewer working in a sandbox quotes what failed there and why, while the unsandboxed run carries the evidence.

The hosted macOS job is read after each merge, running on every push to `main`, on a nightly schedule, and on demand (`workflow_dispatch`); a red macOS run on `main` is fixed before anything else.
