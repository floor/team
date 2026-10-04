# Fixtures

Add a screen capture as a `.txt` under its CLI's folder — a version folder inside it is fine — and
a YAML case as a `.yaml` under `yaml/`, then add each file to `test/fixtures/conformance.json`: a
screen with the `classify` and `composer` kinds its test expects, a YAML case with `ok`. The
command `bun run conformance` fails, naming every fixture the manifest does not list and every
manifest entry whose file is missing. The folders that are not conformance input (the herdr JSON
shapes, the fake `/proc` tree) are exempt by name in `scripts/conformance.ts`, with the reason
beside each; a new folder is not exempt.
