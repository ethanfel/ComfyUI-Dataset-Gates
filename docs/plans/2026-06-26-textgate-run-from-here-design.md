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

**Run from here** click → executes the `Comfy.QueuePrompt` command via
`app.extensionManager.command.execute(...)` — the same path the Run button and
Ctrl+Enter use, so the prompt actually starts. A bare `app.queuePrompt(0, 1)`
enqueues but skips the command's run setup, so the 1.47 frontend doesn't kick off
execution (you'd have to press Run yourself). `app.queuePrompt` remains a fallback
for older frontends without the command registry.

## Sticky edited text (by intent, not text comparison)

The Image Gate keeps its mask sticky; the Text Gate keeps its text. Stickiness is
keyed off **which action triggered the run**, not a text comparison — because the
upstream feeding `text` is often non-deterministic (random/seeded prompts), so a
text comparison would wrongly clobber the edit on every Run-from-here.

- The "Run from here" button sets `node._tgKeepEdit = true` before re-queuing.
- On the next re-pause (`datasete-textgate-show`):
  - if `node._tgKeepEdit` → **keep** the current textarea value and clear the
    flag, so the gate re-emits *your* edited text downstream.
  - else (a normal toolbar Queue) → overwrite the textarea with the incoming
    upstream text.

Net: Run-from-here always preserves your edit; a deliberate full Queue shows the
fresh upstream text. `_tgKeepEdit` is per-session (not serialized).

**Out of scope:** re-queuing still recomputes non-cacheable upstream nodes — that
is inherent to ComfyUI and identical for the Image Gate. With intent-based
stickiness the regenerated text is simply ignored, so it can't change the result;
to skip the compute, Bypass (Ctrl+B) the upstream node manually.

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
