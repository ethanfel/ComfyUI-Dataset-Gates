# Text Gate — "Protected" mode (standalone text node)

**Goal:** A `protected` switch that turns the Text Gate into a standalone text
node: no pause, it outputs the text you typed every run, ignoring upstream. Toggle
off → back to the normal pause/edit/Pass gate using the upstream text.

Decisions (from brainstorming):
- Protected = **plain-text-node behavior** (no pause), not a "still-pause-but-lock".
- The upstream wire is **kept but its value ignored** while protected (toggle off
  resumes upstream seamlessly — no reconnecting).

## Backend (`gates/textgate.py`)

The authored text and the flag must reach `run()`, so:

- `text` input: `required` → **`optional`** (`forceInput` kept), so the node runs
  standalone. Existing connections still work.
- New serializing widgets:
  - `protected` (BOOLEAN, default `False`) — the switch.
  - `stored_text` (STRING) — the authored text, hidden in the UI behind the DOM
    editor; the textarea syncs into it.
- `run(self, unique_id=None, text=None, signal=None, protected=False, stored_text="")`:
  - `protected` → `return (stored_text, signal)` immediately — no `GateBus`, no
    pause, upstream ignored. (Returns early *before* importing comfy, so it stays
    import-safe/unit-testable.)
  - else → current pause flow, guarding an unconnected input with `text or ""`.
- `IS_CHANGED`: `protected` → return `stored_text` (cache-friendly like a real text
  node; downstream only re-runs when the text changes). Else → `float("nan")` (so
  the existing NaN test still passes).

## Frontend (`web/text_gate.js`)

- Hide the auto-created `stored_text` widget (`computeSize → [0,-4]`, the pool
  node's trick); the DOM textarea stays the single editor and writes its value into
  `stored_text` on every edit (persists + reaches the backend).
- Read the `protected` boolean toggle (label "🔒 Protected (text node)"). On **ON**:
  snapshot the current textarea into `stored_text`, hide Pass / Run-from-here, show
  status "🔒 protected — outputs this text, upstream ignored", keep the textarea
  editable. On **OFF**: revert to the normal pause UI.
- Ignore the `datasete-textgate-show` socket while protected. On load, populate the
  textarea from `stored_text`.

## Persistence & compat

`protected` + `stored_text` are real widgets → save/reload restores mode + text.
Old saved TextGates get `protected=false`, `stored_text=""` defaults (the DOM editor
is `serialize:false`, so old nodes carry no conflicting widgets_values).

## Testing

- Unit: `run(protected=True, stored_text="hi")` → `("hi", signal)` without touching
  `GateBus`; `IS_CHANGED(protected=True, stored_text="hi")` → `"hi"`;
  `IS_CHANGED(protected=False)` → `NaN`; `text` is in `INPUT_TYPES()["optional"]`.
- Frontend: `node --check`; manual — toggle protect, edit freely, Run doesn't
  overwrite, save/reload keeps text, toggle off resumes upstream.

## Rejected

A frontend-only "lock" that still pauses — doesn't give true text-node behavior
(you'd still click Pass each run), which is the point of the switch.
