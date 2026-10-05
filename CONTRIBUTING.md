# Contributing to team

## Review and CI

Hosted CI runs the Linux test job (`test (ubuntu-latest)`) and the commit and pull request checks on every pull request.

To avoid runner queue delays on pull requests, the hosted macOS job does not run on pull requests. Instead, before a merge, each of the two reviewers runs the full `bun run ci` on a macOS machine, on the exact head under review, and quotes its final line and its exit status in the verdict; a verdict without that quote is not an approval.

The hosted macOS job runs after the merge, on every push to `main`, on a nightly schedule, and on demand (`workflow_dispatch`); a red macOS run on `main` is fixed before anything else.
