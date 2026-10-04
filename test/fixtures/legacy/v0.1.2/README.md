# Legacy approval snapshots

Copies of the team files exactly as they were at tag `v0.1.2`, taken with `git show v0.1.2:<path>`:

- `team.yaml` — `.github/team.yaml`
- `example.yaml` — `test/fixtures/example.yaml`
- `examples-team.yaml` — `examples/team.yaml`

The legacy-approval test pins the seat digests `v0.1.2` and `v0.1.1` wrote for these files, so it
reads them here, never the live files: an edit to the repository's own team file — adding a seat is
a normal edit — must not redden that test. The copies are never edited; a change to them would
re-pin the digests they exist to hold still.
