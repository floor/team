# team release

Checks the public npm and GitHub records of one release: the exact version and its checksums on
npm (with a provenance attestation when the file declares trusted publishing for the package), the
tag and where it points, the GitHub release, and the changelog entry. It is the checklist after a
publish: run it by hand, or let CI run it after it creates a tag.

## Synopsis

    team release check <package@version> [--json]

`<package@version>` is the package as the team file's `releases` declares it and its Semantic
Versioning 2.0.0 version, joined by `@` — no leading `v`; the tag carries that. A scoped package
splits at the final `@`: `@scope/name@1.2.3`.

## What it reads and writes

Reads the team file's `releases` section, then public records over HTTPS only: the npm registry's
version and attestation endpoints, and GitHub's repository, tag, compare, release and contents
endpoints. Every read is credential-free — no token, no header, no credential helper, no local git
fetch. It writes nothing: no state, no baseline, no cache, no approval. A failed read is retried
once; a run makes at most eleven endpoint reads.

## Who may run it

Anyone. It needs no herdr session, no terminal, no approval and no login.

## The team file's releases section

```yaml file=.agents/team.yaml
format: 1
project: beacon
coordinator: claude-keeper
operator: claude-keeper

workspace:
  mode: shared

releases:
  - package: material
    github: floor/material
    trusted_publishing: true

seats:
  - role: coordinator
    name: claude-keeper
    label: coordinator
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
```

One entry per published package: `package`, its `github` owner/repo, and `trusted_publishing: true`
when npm provenance is required (omit it otherwise). A package the section does not declare cannot
be checked; an invalid section fails `team doctor`.

## Flags

| Flag | Meaning |
| --- | --- |
| `--json` | print the result as one JSON object on standard output, and nothing else |
| `--help`, `-h` | the usage, and exit 0 |

## What it finds

Four checks, in a fixed order. Each is `pass`, `missing` (a completed read that disproves the
condition) or `unknown` (a read that failed, or answered something unexpected — never a pass):

| Check | Passes when |
| --- | --- |
| `npm` | npm has the exact version with `dist.shasum` and `dist.integrity`, and, with `trusted_publishing`, a provenance attestation for it |
| `tag` | GitHub has `v<version>` and its commit is an ancestor of the default branch |
| `github` | GitHub has a published release for `v<version>` whose `prerelease` flag matches the version |
| `changelog` | `CHANGELOG.md` on the default branch has `## [<version>] - <YYYY-MM-DD>` (or without the brackets) with a real calendar date |

## Exit codes

- `0` — every check passed.
- `1` — no check is unknown, but one or more are missing.
- `2` — at least one check is unknown.
- `64` — a bad invocation, an invalid team file, or a package the file does not declare. With
  `--json`, these print `{"error":{"code":"usage"|"configuration","message":"…"}}` instead:
  `usage` for the arguments and an undeclared package, `configuration` for the file.

## Refusals

| Message | Exit |
| --- | --- |
| `team release: a subcommand is required: check` | 64 |
| `team release: unknown subcommand "<name>"` | 64 |
| `team release: a <package@version> is required` | 64 |
| `team release: unexpected "<argument>"` | 64 |
| `team release: unknown option --<name>` | 64 |
| `team release: "<argument>" is not <package>@<version>` | 64 |
| `team release: the package "<name>" is not a package name` | 64 |
| `team release: the version "<version>" is not a Semantic Versioning 2.0.0 version` | 64 |
| `team release: <package> is not declared in the team file's releases` | 64 |
| `team release: <path>, line <n>: <message>` | 64 |

## Examples

The registry says material 3.0.2 is out with its provenance, the release and the changelog are
right, but the tag's commit has not reached the default branch — one check missing, so exit 1:

```console
$ team release check material@3.0.2 ; echo "exit $?"
check      status   detail
npm        pass     exact version, checksums, and provenance found
tag        missing  tag commit is not an ancestor of the default branch
github     pass     published release matches SemVer channel
changelog  pass     changelog entry has a valid release date
exit 1
```

The same run as one JSON object, for the checklist that records it:

```console
$ team release check material@3.0.2 --json ; echo "exit $?"
{
  "package": "material",
  "version": "3.0.2",
  "checks": {
    "npm": { "status": "pass", "detail": "exact version, checksums, and provenance found" },
    "tag": { "status": "missing", "detail": "tag commit is not an ancestor of the default branch" },
    "github": { "status": "pass", "detail": "published release matches SemVer channel" },
    "changelog": { "status": "pass", "detail": "changelog entry has a valid release date" }
  }
}
exit 1
```

An undeclared package is a usage error, in the same JSON shape when `--json` is given:

```console
$ team release check other@3.0.2 --json ; echo "exit $?"
{"error":{"code":"usage","message":"other is not declared in the team file's releases"}}
exit 64
```
