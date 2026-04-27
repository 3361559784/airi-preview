# Desktop Lane Status

Updated: 2026-04-27

This note is a factual status memo for the current desktop lane. It replaces the
older PR #1649-era snapshot. Treat it as a recovery map, not architecture
authority: verify current behavior against code, tests, support matrix entries,
and live smoke runs before changing runtime.

## Current Decision

Desktop v2 runtime discipline has been absorbed into current `origin/main`.

Do not continue the old worktrees as implementation bases:

- `/Users/liuziheng/airi-desktop-v2`
  - branch: `codex/desktop-v2-runtime-discipline`
  - status: useful as history only
  - current target runtime files have no meaningful diff against latest
    `origin/main`; the remaining branch diff is mostly old-main drift
- `/Users/liuziheng/airi-pr1649`
  - branch: `codex/desktop-v3-agent-session`
  - status: useful as history only
  - contains old stack state, temporary files, and broad reverse diff against
    latest `origin/main`

New desktop v3 work should be recut from latest `origin/main` or from a clean
worktree based on it. Do not rebase the stale v2/v3 worktrees and carry their
history forward.

## Direction That Is Still Valid

- Platform: macOS first.
- Browser target: Chrome first.
- Observation: visual screenshot + accessibility + Chrome semantic DOM.
- Execution: real OS input for desktop actions; browser DOM bridge is a precise
  helper path only when capability and click semantics are safe.
- Overlay: visualization layer for target boxes and ghost pointer state, not a
  second real system cursor.
- Completion standard: desktop line needs code + tests + a narrow live smoke
  before being called product-supported.

## Desktop V3 Structure On Current Main

Service-side structure:

- `services/computer-use-mcp/src/chrome-session-manager.ts`
  - Owns agent Chrome session lifecycle and foreground restore hooks.
- `services/computer-use-mcp/src/desktop-session.ts`
  - Tracks controlled app, owned windows, previous user foreground, and session
    activity.
- `services/computer-use-mcp/src/server/register-chrome-session.ts`
  - Registers `desktop_ensure_chrome`.
  - Begins a desktop session for Google Chrome.
  - Best-effort connects CDP from the Chrome session.
- `services/computer-use-mcp/src/server/register-desktop-grounding.ts`
  - Registers `desktop_observe` and `desktop_click_target`.
  - Stores observe screenshots in both grounding state and last-screenshot
    runtime state.
  - Delegates target clicks through the shared action executor.
- `services/computer-use-mcp/src/server/desktop-grounding-actions.ts`
  - Implements snap resolution, duplicate/stale snapshot checks, browser-DOM
    fallback, OS input fallback, and pointer intent updates.
- `services/computer-use-mcp/src/server/action-executor.ts`
  - Runs `desktop_click_target` through shared policy, approval, audit, budget,
    and failure response paths.
  - Uses controlled-app policy context but records the actual foreground when it
    differs.
- `services/computer-use-mcp/src/browser-action-router.ts`
  - Routes browser-DOM clicks only for left single-click.
  - Forces right/middle/multi-click back to OS input.
- `services/computer-use-mcp/chrome-extension/background.js`
  - Actively connects to the local extension bridge.
  - Unknown actions return `ok: false`.
  - Frame offsets are propagated for iframe candidates.

Desktop app structure:

- `apps/stage-tamagotchi/src/main/windows/desktop-overlay/index.ts`
  - Creates the transparent click-through overlay.
  - Wires desktop-overlay Eventa RPC before loading the renderer page.
- `apps/stage-tamagotchi/src/main/windows/desktop-overlay/rpc/`
  - Owns overlay window RPC for calling `computer_use::desktop_get_state`.
- `apps/stage-tamagotchi/src/renderer/pages/desktop-overlay-polling.ts`
  - Polls `desktop_get_state` with bounded per-call timeout behavior.
- `apps/stage-tamagotchi/src/renderer/pages/desktop-overlay-coordinates.ts`
  - Converts screen-space data to overlay-local coordinates.
- `apps/stage-tamagotchi/src/renderer/pages/desktop-overlay.vue`
  - Renders candidate boxes, stale badges, ghost pointer, executing/completed
    phases, and click ripple.

## What Is Confirmed By Tests

Latest narrow validation on 2026-04-27:

```bash
pnpm -F @proj-airi/computer-use-mcp exec vitest run src/desktop-session.test.ts src/chrome-session-manager.test.ts src/server/register-chrome-session.test.ts src/server/register-desktop-grounding.test.ts src/server/register-desktop-grounding-tools.test.ts
pnpm -F @proj-airi/stage-tamagotchi exec vitest run src/renderer/pages/desktop-overlay-polling.test.ts src/renderer/pages/desktop-overlay-coordinates.test.ts
pnpm -F @proj-airi/computer-use-mcp smoke:desktop-v3
```

Result:

```text
computer-use-mcp: 5 files passed, 76 tests passed
stage-tamagotchi overlay: 2 files passed, 35 tests passed
desktop v3 smoke: PASS
```

This validates the unit/integration contract around session state, Chrome
session tools, grounding state, target click registration, and overlay polling
helpers. The live smoke validates the MCP desktop v3 chain:
`desktop_ensure_chrome -> desktop_observe -> desktop_get_state ->
desktop_click_target -> desktop_get_state`.

The smoke selected the controlled page's AX button target and verified
post-click pointer/candidate state. It does not prove Chrome semantic DOM click
routing, the Electron overlay renderer in a live window, or user-input
isolation.

## What Is No Longer A Current Blocker

The older PR #1649 blockers below are already resolved on current main:

- Extension unknown actions returning `ok: true`.
  - Current `background.js` returns `ok: false` for unknown actions.
- Browser-DOM routing ignoring non-default click semantics.
  - Current `browser-action-router.ts` only uses browser-DOM for left
    single-click; right/middle/multi-click use OS input.
- iframe DOM candidate offsets being hypothetical.
  - Current extension background and Chrome semantic adapter carry frame offsets
    into candidates.
- Overlay input interception.
  - Current overlay window uses ignore-mouse-events and non-focusable behavior.

Do not reopen those as fresh blockers unless a live run proves regression.

## Actual Remaining Product Gaps

These are the real desktop v3 gaps now:

1. Live desktop v3 MCP smoke exists, but is still baseline coverage.
   - Current smoke proves:
     `desktop_ensure_chrome -> desktop_observe -> desktop_click_target ->
     desktop_get_state/overlay-consumable state`.
   - It should be treated as `covered`, not product-supported.
   - It does not prove Chrome semantic DOM routing, live overlay-window
     rendering, or user-input isolation.

2. Overlay lifecycle is still not product-proven in a real window context.
   - The code has preload-order and polling timeout protections.
   - Tests cover helper behavior.
   - A live Electron overlay run still needs to prove the renderer can poll MCP
     state repeatedly without hanging or stealing focus.

3. Support matrix should record desktop v3 smoke coverage but still should not
   call desktop v3 product-supported.
   - Keep desktop-native claims conservative.
   - Do not promote support level based on one MCP smoke alone.
   - Product support still needs live overlay-window proof and the next
     input-isolation runtime contract.

4. Old desktop branches need recut, not repair.
   - Continuing stale branches risks dragging reversed translations, removed
     files, old transcript state, temporary scripts, and old lockfile changes.

## Next Knife

Recommended next PR:

```text
docs(computer-use-mcp): mark desktop v3 smoke coverage in support matrix
```

Scope:

- Add the desktop v3 Chrome grounding smoke to `src/support-matrix.ts`.
- Keep the level at `covered`, not `product-supported`.
- Record that the existing live smoke proves MCP grounding state, not Chrome
  semantic DOM click routing or live overlay-window rendering.
- Do not redesign overlay visuals or browser-DOM policy.

Follow-up after that, only if the smoke is green:

```text
test(stage-tamagotchi): prove desktop overlay live-window polling
```

## Stop Rules

- Do not continue the stale v2/v3 branches as implementation bases.
- Do not mix desktop v3 smoke, overlay UI polish, extension bridge policy, and
  support-matrix promotion in one commit.
- Do not call desktop v3 product-supported until the live smoke exists and is
  documented.
- Do not reopen desktop architecture. The direction is stable; the gap is proof.
