# Text Gate (Manual Pass) Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a ComfyUI node `Text Gate (Manual Pass)` that pauses a run, shows the incoming text in an editable box, and on a Pass click emits the (edited) text — plus an optional any-type `signal` input and a `signal` passthrough output for ordering.

**Architecture:** Reuse the Image Gate's `gates/gate_bus.py` blocking infra, extended with a string **payload channel** (`put_payload`/`wait_payload`) plus a `should_cancel` hook so the Pass-only gate still honors ComfyUI's global Cancel. The node `gates/textgate.py` defines an `AnyType("*")` and keeps comfy imports lazy so it unit-tests without ComfyUI. `gates/gate_server.py` gains `send_text()` + a pass route; `web/text_gate.js` renders the editable textarea + Pass.

**Tech Stack:** Python 3.12, aiohttp; pytest 9; vanilla JS frontend. (No torch needed for this node.)

---

## Conventions (read once)

- **Test python:** `/media/p5/miniforge3/bin/python` (`PY=...`).
- **Run tests:** `cd /media/p5/ComfyUI-Datasete-Gates && $PY -m pytest tests/test_gate_bus.py tests/test_textgate.py -v`
- Edits to `gate_bus.py` / `gate_server.py` / `__init__.py` are **additive** — re-Read each
  first, keep the Image Gate working, and run the full suite after.
- `gate_bus.py` stays stdlib-only. `textgate.py` imports comfy lazily inside `run()`.
- Concurrency: other sessions may share this tree; stage only this node's paths per commit.
- Commit style: Conventional Commits + repo Co-Authored-By trailer.

---

### Task 1: `gate_bus.py` — string payload channel

**Files:** Modify `gates/gate_bus.py`, `tests/test_gate_bus.py`

**Step 1: Failing test**

```python
# add to tests/test_gate_bus.py
def test_payload_roundtrip():
    gb.GateBus.arm("p")
    gb.GateBus.put_payload("p", "hello edited")
    assert gb.GateBus.wait_payload("p") == "hello edited"

def test_payload_consumed():
    gb.GateBus.arm("p")
    gb.GateBus.put_payload("p", "x")
    gb.GateBus.wait_payload("p")
    assert "p" not in gb.GateBus.payloads

def test_arm_clears_payload():
    gb.GateBus.put_payload("p", "stale")
    gb.GateBus.arm("p")
    assert "p" not in gb.GateBus.payloads

def test_wait_payload_cancel_flag_raises():
    import pytest
    gb.GateBus.arm("p")
    gb.GateBus.cancelled = True
    with pytest.raises(gb.GateCancelled):
        gb.GateBus.wait_payload("p")
```

**Step 2: Run → FAIL.** `$PY -m pytest tests/test_gate_bus.py -v`

**Step 3: Implement** — add a class attr and methods to `GateBus`, and clear payloads in `arm`:

```python
    payloads = {}     # node_id(str) -> arbitrary payload (e.g., edited text)
```

In `arm`, add:

```python
        cls.payloads.pop(str(node_id), None)
```

New methods:

```python
    @classmethod
    def put_payload(cls, node_id, value):
        cls.payloads[str(node_id)] = value

    @classmethod
    def wait_payload(cls, node_id, period=0.1, should_cancel=None):
        sid = str(node_id)
        while sid not in cls.payloads:
            if cls.cancelled or (should_cancel is not None and should_cancel()):
                cls.cancelled = False
                raise GateCancelled()
            time.sleep(period)
        return cls.payloads.pop(sid)
```

**Step 4: Run → PASS** (and existing gate_bus tests still pass).

**Step 5: Commit** `feat: gate_bus payload channel + should_cancel`

---

### Task 2: `gate_bus.py` — `should_cancel` triggers cancel

**Files:** Modify `tests/test_gate_bus.py`

**Step 1: Failing test**

```python
def test_wait_payload_should_cancel_raises():
    import pytest
    gb.GateBus.arm("p")
    with pytest.raises(gb.GateCancelled):
        gb.GateBus.wait_payload("p", should_cancel=lambda: True)
```

**Step 2: Run → PASS immediately** (implemented in Task 1). If it fails, fix Task 1's loop.

**Step 3:** (no code) — this task just locks the behavior with a test.

**Step 4: Commit** `test: gate_bus wait_payload honors should_cancel`

---

### Task 3: `textgate.py` — `AnyType` wildcard

**Files:** Create `gates/textgate.py`; Test `tests/test_textgate.py`

**Step 1: Failing test**

```python
# tests/test_textgate.py
from gates import textgate

def test_anytype_is_compatible_with_everything():
    assert (textgate.ANY != "IMAGE") is False
    assert (textgate.ANY != "LATENT") is False
    assert isinstance(textgate.ANY, str)
```

**Step 2: Run → FAIL.**

**Step 3: Implement**

```python
# gates/textgate.py
from . import gate_bus

NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}


class AnyType(str):
    """Type that compares equal to any other type (ComfyUI wildcard convention)."""
    def __ne__(self, other):
        return False


ANY = AnyType("*")
```

**Step 4: Run → PASS.**  **Step 5: Commit** `feat: textgate AnyType wildcard`

---

### Task 4: `textgate.py` — `TextGate` node

**Files:** Modify `gates/textgate.py`, `tests/test_textgate.py`

**Step 0: Verify the global-cancel getter:**
`grep -n "def processing_interrupted\|def interrupt_current_processing\|class InterruptProcessingException" /media/p5/Comfyui/comfy/model_management.py`
Use the boolean getter that exists (expected `processing_interrupted`).

**Step 1: Failing test**

```python
import math

def test_textgate_io_shape():
    assert textgate.TextGate.RETURN_NAMES == ("text", "signal")
    assert textgate.TextGate.RETURN_TYPES[0] == "STRING"
    assert textgate.TextGate.RETURN_TYPES[1] == textgate.ANY

def test_textgate_is_changed_nan():
    v = textgate.TextGate.IS_CHANGED(text="hi", unique_id="1")
    assert math.isnan(v)
```

**Step 2: Run → FAIL.**

**Step 3: Implement (append)**

```python
class TextGate:
    CATEGORY = "Datasete Gates"
    FUNCTION = "run"
    RETURN_TYPES = ("STRING", ANY)
    RETURN_NAMES = ("text", "signal")

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "text": ("STRING", {"forceInput": True}),
            },
            "optional": {
                "signal": (ANY, {}),
            },
            "hidden": {"unique_id": "UNIQUE_ID"},
        }

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        return float("nan")

    def run(self, text, unique_id, signal=None):
        from . import gate_server
        import comfy.model_management as mm

        gate_bus.GateBus.arm(unique_id)
        gate_server.send_text(unique_id, text)
        try:
            edited = gate_bus.GateBus.wait_payload(
                unique_id, should_cancel=mm.processing_interrupted)  # confirm symbol (Step 0)
        except gate_bus.GateCancelled:
            raise mm.InterruptProcessingException()
        return (edited, signal)


NODE_CLASS_MAPPINGS = {"TextGate": TextGate}
NODE_DISPLAY_NAME_MAPPINGS = {"TextGate": "Text Gate (Manual Pass)"}
```

**Step 4: Run → PASS.** (`run()` covered by the live test, not unit tests.)

**Step 5: Commit** `feat: TextGate node — pause, editable pass-through, signal passthrough`

---

### Task 5: `gate_server.py` — text route + preview, and register (MERGE)

**Files:** Modify `gates/gate_server.py`, `__init__.py`

**Step 1: Re-Read `gates/gate_server.py`**, then append (additive — don't touch the image-gate routes):

```python
def send_text(node_id, text):
    PromptServer.instance.send_sync(
        "datasete-textgate-show", {"id": str(node_id), "text": text or ""}
    )


@routes.post("/datasete_text_gate/pass")
async def _text_pass(request):
    post = await request.post()
    GateBus.put_payload(post.get("id"), post.get("text", ""))
    return web.json_response({})
```

**Step 2: Re-Read `__init__.py`** and merge `TextGate` into the mappings (gate_server is
already imported for the Image Gate, so the new route registers automatically):

```python
    from .gates.textgate import NODE_CLASS_MAPPINGS as _TEXT_NODES, \
        NODE_DISPLAY_NAME_MAPPINGS as _TEXT_NAMES
    NODE_CLASS_MAPPINGS = {**NODE_CLASS_MAPPINGS, **_TEXT_NODES}
    NODE_DISPLAY_NAME_MAPPINGS = {**NODE_DISPLAY_NAME_MAPPINGS, **_TEXT_NAMES}
```

**Step 3:** `$PY -c "import gates.textgate; print(gates.textgate.NODE_CLASS_MAPPINGS)"` → shows TextGate.

**Step 4:** Full suite green: `$PY -m pytest tests/ -v`

**Step 5: Commit** `feat: text gate server route + register TextGate`

---

### Task 6: `web/text_gate.js` — editable pause UI

**Files:** Create `web/text_gate.js`

Implement `app.registerExtension` for `TextGate`:
- Listen for the `datasete-textgate-show` socket event (`api.addEventListener`); when it
  fires for this node's id, render a DOM widget: an **editable `<textarea>`** prefilled with
  the event's `text`, and a **Pass** button.
- **Pass** → POST `/datasete_text_gate/pass` form-encoded `{id, text: <textarea value>}`,
  then hide the pause UI.
- Keep it minimal — no dynamic outputs (the two outputs are static).

**Manual note:** verify the textarea grows/scrolls for long captions.

**Commit** `feat: text gate frontend — editable textarea + pass`

---

### Task 7: Live smoke test in ComfyUI

Restart ComfyUI. Build: a text source (e.g., `Folder Image Loader.text` or a primitive) →
`Text Gate` → a text consumer (ShowText/SaveText). Optionally wire a `signal` from one node
and the `signal` output to another. Verify:
- [ ] "Text Gate (Manual Pass)" appears under "Datasete Gates".
- [ ] Queue → pauses; editable textarea shows the incoming text.
- [ ] Edit the text, click **Pass** → downstream receives the **edited** text.
- [ ] Pauses again on a second run (not cached).
- [ ] `signal` input forces this node to run after its source; `signal` output triggers a
      downstream node after pass (chain order holds).
- [ ] Hitting ComfyUI's global **Cancel** while paused unblocks cleanly (no deadlock, no
      scary traceback).

**Commit** (if fixes) `fix: text gate live-test adjustments`

---

## Definition of done

- `$PY -m pytest tests/test_gate_bus.py tests/test_textgate.py -v` green; full `tests/` green
  (Image Gate unaffected).
- Manual checklist passes: editable pause, edited pass-through, signal ordering, clean cancel.
