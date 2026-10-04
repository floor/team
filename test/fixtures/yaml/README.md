# YAML subset refusals

The 32 documents the subset refuses, moved out of the parser test so a conformance
run can hand the same bytes to another implementation. Each one is refused.
`test/fixtures/conformance.json` records that. The parser test still checks the
line and the message.

Nothing here was read from a live session.
