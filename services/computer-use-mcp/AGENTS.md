# computer-use-mcp agent instructions

## Scope

- Keep changes narrow and evidence-backed.
- Do not touch desktop overlay, Electron bridge, Chrome extension, MCP handler registration, workspace memory, verification gate, or shell guard unless the task explicitly requires it.
- Keep documentation/config changes separate from runtime logic changes.

## Transcript, archive, and retention rules

- Keep planning, archive eligibility, compaction text, provider message emission, and runner semantics separate unless evidence requires a cross-layer change.
- Prefer pure helpers for shared contracts.
- Add regression tests for boundary behavior.
- Do not broaden refactors without evidence.
- Do not treat parser-level coverage as proof that projected provider messages are valid; add projector-level tests when the final message shape is the contract.

## Testing

- Use the narrowest Vitest file first.
- Run package typecheck when runtime contracts changed.
- Run full `@proj-airi/computer-use-mcp` package tests for shared logic refactors.
- Do not rely on real Electron or desktop runtime for unit tests.

## Report

- Exact files changed.
- Exact test command.
- Exit code.
- Relevant pass/fail output.
- Remaining risks and why they are out of scope.
