# Text Gate — "Run from here" + sticky edit (design)

**Goal:** Bring the Text Gate to parity with the Image Gate's "Run from here"
affordance, plus a text-specific touch: keep the user's edited text across
re-runs ("start from there").

**Scope:** Frontend only — `web/text_gate.js`. No changes to `gates/textgate.py`,
`gates/gate_bus.py`, or `gates/gate_server.py`. The gate already re-arms and
re-pauses on every run (`GateBus.arm` → `wait_payload`) and `IS_CHANGED` returns
`NaN`, so re-queuing the prompt is enough to "resume": cached upstream means the
gate re-pauses near-instantly.

## State machine

The node currently has no explicit state. Add three:

- **idle** — before the first run. Pass shown, Run-from-here hidden.
- **paused** — socket `datasete-textgate-show` arrived. Textarea editable &
  populated, **▶ Pass** shown, **Run from here** hidden, status `edit, then Pass`.
- **passed** — after Pass click. Textarea keeps the edited text, **Pass** hidden,
  **▶ Run from here** shown, status `passed — Run from here to re-run`.

**Run from here** click → `app.queuePrompt(0, 1)` with `app.queuePrompt(0)`
fallback — copied verbatim from the Image Gate's `queueFromHere`.

## Sticky edited text

The Image Gate keeps its mask sticky; the Text Gate keeps its text. The live
textarea IS the sticky store, gated by the last-seen input:

- Track `node._tgInput` = the last incoming text the server pushed.
- On each re-pause with `incoming`:
  - if `incoming === node._tgInput` (upstream unchanged — the Run-from-here
    case) → **keep** the current textarea value, so the gate re-runs *your*
    edited version (including any edits made after Pass).
  - else (a genuine upstream recompute) → overwrite the textarea with `incoming`.
  - always set `node._tgInput = incoming`.

Net: "Run from here" re-runs your version, but a real upstream change still
surfaces instead of hiding behind a stale edit. `_tgInput` is per-session
(not serialized) — a page reload starts fresh, which is fine.

## Verification

- `node --check web/text_gate.js` (no JS test harness in the repo — consistent
  with the other `web/*.js`).
- Manual: pause → edit → Pass → button appears → Run-from-here re-pauses showing
  your edited text → downstream re-runs; change something upstream → new input
  shows.

## Dropped (YAGNI)

- A separate "↺ reset to input" button — the upstream-change detection covers the
  stale-edit footgun.
- Any backend auto-pass / bypass mode — not requested.
