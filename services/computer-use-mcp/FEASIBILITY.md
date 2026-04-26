# Feasibility Summary

This document records the validated state of the AIRI-specific macOS desktop orchestration v1 in `services/computer-use-mcp`.

## Bottom Line

The current direction is feasible and materially stronger than the earlier pure-vision-only path.
The validated architecture is now:

- AIRI keeps the control plane
- `computer-use-mcp` keeps trace, audit, screenshot persistence, policy, and the MCP surface
- the primary execution backend is local macOS window automation
- AIRI desktop handles human approval through native dialogs
- terminal commands run in a controlled background shell runner instead of a Terminal tab script

That makes the feature an orchestration layer, not just a mouse-clicking demo.

## What Was Verified

### 1. The service still fits AIRI's MCP attachment model

AIRI continues to use the existing stdio MCP bridge through `mcp.json`.
No transport rewrite was required.

### 2. The service now exposes a tool-first desktop orchestration surface

Validated surface in this checkout:

- desktop observation tools
- deterministic app open/focus tools
- background terminal execution tools
- primitive UI interaction tools
- approval / trace / audit helpers

This is a better fit for AIRI than leading with pure screenshot-driven action selection.

### 3. Terminal execution is now first-class and auditable

Validated by tests:

- commands run in a local background shell process
- non-zero exit codes are returned without throwing away stderr/stdout
- cwd is sticky across calls unless explicitly overridden
- reset clears terminal state

This gives AIRI a deterministic execution path for many developer workflows without relying on Terminal.app scripting.

### 4. Native approval now sits in the AIRI desktop layer

Validated by implementation shape:

- MCP still returns `approval_required`
- AIRI renderer intercepts `computer_use` pending actions
- Electron main shows a native approval dialog
- AIRI automatically follows up with approve/reject tool calls
- session-scoped approval reuse is limited to terminal and app open/focus actions

That keeps approval as a user action, not a model action.

### 5. The old remote Linux path still compiles and tests

The previous `linux-x11` backend remains available as a legacy experimental path.
It is not the primary v1 story anymore, but it was intentionally kept compiling so existing remote smoke tooling still works.

## Current Boundary

Main v1 story:

- executor: `macos-local`
- apps explicitly supported for open/focus by default:
  - `Finder`
  - `Terminal`
  - `Cursor`
  - `Visual Studio Code`
  - `Google Chrome`
- safety boundary:
  - native approval dialogs
  - `denyApps`
  - trace / audit
  - screenshot persistence
  - operation budgets

Current terminal boundary (from `src/support-matrix.ts`):

- `terminal_exec` is product-supported for non-interactive exec.
- `terminal_pty` and `terminal_pty_self_acquire` are product-supported as the interactive mainline.
- `terminal_exec_to_pty_reroute` is covered and explicitly marked as legacy fallback in the matrix label.
- `terminal_auto_surface_resolution` and `terminal_pty_step_family` are covered and remain part of the lane contract.
- `terminal_pty_open_grant` and `terminal_pty_audit` remain covered, while strict proof is expected on the matrix `product-supported` gates.

Historical path vs current path:

- Historical outward reroute and harness-side assumptions are retained only as backup lanes.
- Current product flow is workflow-owned PTY self-acquire when the surface resolves to PTY.

Explicit non-goals of this pass:

- deep accessibility tree grounding
- strict app-level UI sandboxing
- remote sandbox hosting for other users
- Windows / Wayland / multi-monitor support

## Commands Verified In This Checkout

- `pnpm -F @proj-airi/computer-use-mcp typecheck`
- `pnpm -F @proj-airi/computer-use-mcp test`
- `pnpm -F @proj-airi/stage-ui typecheck`
- `pnpm -F @proj-airi/stage-tamagotchi typecheck`

## Practical Interpretation

The feature is now credible as:

- a macOS desktop orchestration layer for AIRI
- a way to connect chat, MCP, terminal execution, and UI observation into one task flow
- a safer incremental path than trying to solve generic pure-vision computer use first

It should not be pitched as:

- a general desktop sandbox platform
- a no-approval autonomous agent
- a production-grade app-isolated desktop security boundary
