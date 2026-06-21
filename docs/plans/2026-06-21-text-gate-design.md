# Text Gate (Manual Pass) — Design

Date: 2026-06-21
Status: Approved (brainstorming complete, ready for implementation plan)

## 1. Purpose

A simple blocking gate for text: during a run it **pauses**, shows the incoming text in an
**editable** box, and waits for a **Pass** click; on pass it emits the (possibly edited)
text. An optional any-type **signal** input lets you force execution order, and a
**signal** passthrough output lets you chain gates in a fixed sequence. Fourth node in the
`ComfyUI-Datasete-Gates` suite; reuses the Image Gate's `gate_bus` blocking infra.

## 2. IO

| dir | name | type | notes |
|---|---|---|---|
| in | `text` | STRING (`forceInput`) | incoming text from upstream |
| in (optional) | `signal` | `*` (AnyType) | accepts anything; only used to sequence this node after its source |
| hidden | `unique_id` | UNIQUE_ID | keys the pause |
| out | `text` | STRING | the edited text passed by the user |
| out | `signal` | `*` (AnyType) | passthrough of the input signal (fires on pass) → chain ordering |

## 3. Behavior (the pause)

On execute:
1. `GateBus.arm(unique_id)`; push the incoming text to the UI
   (`PromptServer.send_sync("datasete-textgate-show", {id, text})`).
2. Frontend shows an **editable textarea** prefilled with the text + a **Pass** button.
3. **Block** on `GateBus.wait_payload(unique_id, should_cancel=...)` until Pass.
4. **Pass** → frontend POSTs the edited text to `/datasete_text_gate/pass`; the node returns
   `(edited_text, signal)`.

`IS_CHANGED` returns `nan` → pauses on every run.

**No Stop button**, but the wait loop honors ComfyUI's global Cancel via a `should_cancel`
callback (`comfy.model_management.processing_interrupted`) so a queue-cancel can't deadlock
the gate; on cancel it raises `InterruptProcessingException`.

## 4. Reuse / changes to existing files (all additive)

- `gates/gate_bus.py` — add a **payload channel**: `payloads` dict, `put_payload`,
  `wait_payload(..., should_cancel=None)`; `arm()` also clears `payloads`. Existing
  int-choice/mask API untouched (Image Gate keeps working).
- `gates/gate_server.py` — add `send_text()` + route `POST /datasete_text_gate/pass`.
- `gates/textgate.py` *(new)* — `AnyType("*")` + `ANY`; the `TextGate` node (lazy comfy
  imports so it unit-tests without ComfyUI).
- `web/text_gate.js` *(new)* — listen for `datasete-textgate-show`, render editable textarea
  + Pass, POST the edited text.
- root `__init__.py` — merge `TextGate` into the mappings (gate_server already imported).

## 5. Edge cases

- Signal not connected → `signal=None`; output `None` (downstream still ordered by the
  dependency).
- `AnyType` output value `None` connects fine (the `__ne__`→False trick makes type checks
  pass), matching the installed custom-node convention.
- Empty incoming text → empty textarea; Pass emits whatever's there (possibly `""`).
- Global queue-cancel while blocked → clean interrupt (see §3).

## 6. Testing

- pytest: `gate_bus` payload roundtrip + `arm` clears payloads + `wait_payload` cancel via
  flag and via `should_cancel`; `AnyType` equals-everything; `TextGate` RETURN_TYPES/NAMES
  and `IS_CHANGED==nan`.
- Manual (live): pause shows editable text, edit + Pass emits edited text; signal in forces
  order; signal out chains to a second gate; global Cancel unblocks cleanly.
