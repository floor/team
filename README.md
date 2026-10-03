# team

Set up, change and watch a project's team of AI agents from one file.

`team` is a small command-line tool with no runtime dependencies. A project declares its team in
`.agents/team.yaml`: the seats, the tools they work with, how each agent signs its work, the
folders it may work in. Commands then build the team, compare it with the file, watch it and check
its commits before a push. Version 0.1 runs teams in [herdr](https://herdr.dev).

**Status: alpha, in construction.** This build holds the file's parser and validation, the check of
who is calling, `team check`, `team init`, `team status` and `team watch`. The others arrive slice by slice.

## The file is private to each clone

`team init` keeps `.agents/team.yaml` out of git through `.git/info/exclude`, never by editing
`.gitignore`: a public repository shouldn't carry its roster. A fresh clone therefore has no team
file. Run `team init` to write one, or `team init --restore` to bring back the copy you last
approved on this machine. A file you receive from someone else runs nothing until you approve it
yourself.

## The file's format

A documented subset of YAML, read by the library's own parser: maps, lists, one-line `{ }` and
`[ ]`, plain and quoted values, comments. Anchors, aliases, tags, block scalars, several documents
in one file and duplicate keys are refused, with the line number. The file starts with
`format: 1`.

## Development

```sh
bun install
bun run typecheck
bun test
bun run build        # dist/, which runs on Node 22 or later
```

Sources import each other with `.ts` extensions and use erasable syntax only, so Node can run them
directly; `tsc` writes `dist/` for the published command.

## License

MIT
