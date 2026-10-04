# Herdr process-info

Cleaned `pane process-info` objects. Arguments past the program name, command lines, working directories, and pane ids are withheld. Nothing here was typed into a live pane for this test.

- `claude-with-caffeinate.json`: two foreground entries. The first `argv0` is `caffeinate`. The second `argv0` is `claude` and its `name` is a version.
- `claude-plain.json`: the same pair, with a different version in `name`.
- `cursor-agent.json`: one entry. `argv0` is `cursor-agent` and `name` is `node`.
