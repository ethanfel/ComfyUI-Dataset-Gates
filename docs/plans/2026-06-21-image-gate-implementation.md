# Image Gate (Manual Router) Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a ComfyUI custom node `Image Gate (Manual Router)` that pauses a running prompt, shows the image with up to 10 labeled route buttons + a mask-edit + a stop button, and routes the image down the clicked output (others `ExecutionBlocker`-ed), emitting any gate-painted mask on a fixed `mask` output.

**Architecture:** A pure, torch-free `gates/gate_bus.py` (a `MessageHolder`-style blocking waiter + mask stash) is unit-testable without ComfyUI. `gates/gate.py` holds the node plus pure helpers (`route_tuple`, `mask_from_stash`); it imports `ExecutionBlocker`/`model_management` lazily so tests don't need comfy. `gates/gate_server.py` is the aiohttp glue (choice/mask routes + `send_preview`). `web/image_gate.js` renders preview + dynamic labeled outputs + buttons and posts the choice; it reuses the pool node's MaskEditor helper.

**Tech Stack:** Python 3.12, torch 2.8, Pillow, numpy, aiohttp; pytest 9; vanilla JS frontend.

---

## Conventions (read once)

- **Test python:** `/media/p5/miniforge3/bin/python` (`PY=...`).
- **Run tests:** `cd /media/p5/ComfyUI-Datasete-Gates && $PY -m pytest tests/test_gate_bus.py tests/test_gate.py -v`
- **Concurrency:** other sessions may share this working tree. Stage only this node's paths
  when committing; re-Read `__init__.py` before editing (Task 6) and *extend*, don't overwrite.
- `gates/gate_bus.py` MUST be import-safe without comfy/torch (stdlib only).
- `gates/gate.py` MUST import `ExecutionBlocker` and `comfy.model_management` **lazily inside
  `run()`** (and `send_preview` lazily) so `import gates.gate` works under pytest.
- Mask convention: grayscale `L`, white = painted; zeros sized to the image if none.
- Commit style: Conventional Commits + repo Co-Authored-By trailer.
- `MAX_ROUTES = 10`.

---

### Task 1: `gate_bus.py` — `GateBus` (arm/put/wait/cancel)

**Files:** Create `gates/gate_bus.py`; Test `tests/test_gate_bus.py`

**Step 1: Failing test**

```python
# tests/test_gate_bus.py
import pytest
from gates import gate_bus as gb

def test_put_and_wait_returns_choice():
    gb.GateBus.arm("7")
    gb.GateBus.put("7", "3")
    assert gb.GateBus.wait("7") == 3

def test_wait_consumes_message():
    gb.GateBus.arm("7")
    gb.GateBus.put("7", "2")
    gb.GateBus.wait("7")
    assert "7" not in gb.GateBus.messages

def test_cancel_raises_and_resets():
    gb.GateBus.arm("7")
    gb.GateBus.put("7", "__cancel__")
    with pytest.raises(gb.GateCancelled):
        gb.GateBus.wait("7")
    assert gb.GateBus.cancelled is False      # reset after raising

def test_arm_clears_stale_state():
    gb.GateBus.put("1", "5")
    gb.GateBus.cancelled = True
    gb.GateBus.arm("1")
    assert "1" not in gb.GateBus.messages
    assert gb.GateBus.cancelled is False
```

**Step 2: Run → FAIL.**

**Step 3: Implement**

```python
# gates/gate_bus.py
"""Blocking choice bus for the Image Gate node. Stdlib only — no comfy/torch."""
import time


class GateCancelled(Exception):
    pass


class GateBus:
    messages = {}     # node_id(str) -> chosen int (1-based)
    masks = {}        # node_id(str) -> PNG bytes
    cancelled = False

    @classmethod
    def arm(cls, node_id):
        cls.messages.pop(str(node_id), None)
        cls.masks.pop(str(node_id), None)
        cls.cancelled = False

    @classmethod
    def put(cls, node_id, message):
        if message == "__cancel__":
            cls.cancelled = True
        else:
            cls.messages[str(node_id)] = int(message)

    @classmethod
    def wait(cls, node_id, period=0.1):
        sid = str(node_id)
        while sid not in cls.messages:
            if cls.cancelled:
                cls.cancelled = False
                raise GateCancelled()
            time.sleep(period)
        return cls.messages.pop(sid)
```

**Step 4: Run → PASS.**  **Step 5: Commit** `feat: gate_bus blocking choice waiter`

---

### Task 2: `gate_bus.py` — mask stash

**Files:** Modify `gates/gate_bus.py`, `tests/test_gate_bus.py`

**Step 1: Failing test**

```python
def test_mask_stash_roundtrip():
    gb.GateBus.put_mask("9", b"PNGDATA")
    assert gb.GateBus.pop_mask("9") == b"PNGDATA"
    assert gb.GateBus.pop_mask("9") is None   # popped

def test_arm_clears_mask():
    gb.GateBus.put_mask("9", b"x")
    gb.GateBus.arm("9")
    assert gb.GateBus.pop_mask("9") is None
```

**Step 2: Run → FAIL.**

**Step 3: Implement (append to `GateBus`)**

```python
    @classmethod
    def put_mask(cls, node_id, data):
        cls.masks[str(node_id)] = data

    @classmethod
    def pop_mask(cls, node_id):
        return cls.masks.pop(str(node_id), None)
```

**Step 4: Run → PASS.**  **Step 5: Commit** `feat: gate_bus mask stash`

---

### Task 3: `gate.py` — `route_tuple` pure helper

**Files:** Create `gates/gate.py`; Test `tests/test_gate.py`

**Step 1: Failing test**

```python
# tests/test_gate.py
from gates import gate

def test_route_tuple_places_image_at_chosen():
    B = object()
    t = gate.route_tuple(2, "IMG", B, max_routes=5)
    assert t == (B, B, "IMG", B, B)

def test_route_tuple_length_is_max():
    B = object()
    assert len(gate.route_tuple(0, "IMG", B, max_routes=10)) == 10
```

**Step 2: Run → FAIL.**

**Step 3: Implement**

```python
# gates/gate.py
import io
import math

import numpy as np
import torch
from PIL import Image

from . import gate_bus

MAX_ROUTES = 10


def route_tuple(chosen, image, blocker, max_routes=MAX_ROUTES):
    return tuple(image if i == chosen else blocker for i in range(max_routes))
```

**Step 4: Run → PASS.**  **Step 5: Commit** `feat: gate route_tuple helper`

---

### Task 4: `gate.py` — `mask_from_stash`

**Files:** Modify `gates/gate.py`, `tests/test_gate.py`

**Step 1: Failing test**

```python
import io, torch
from PIL import Image

def test_mask_from_stash_none_is_zeros():
    img = torch.zeros((1, 6, 4, 3))
    m = gate.mask_from_stash(None, img)
    assert m.shape == (1, 6, 4) and float(m.max()) == 0.0

def test_mask_from_stash_decodes_png():
    buf = io.BytesIO(); Image.new("L", (4, 6), 255).save(buf, "PNG")
    img = torch.zeros((1, 6, 4, 3))
    m = gate.mask_from_stash(buf.getvalue(), img)
    assert m.shape == (1, 6, 4) and float(m.min()) > 0.99
```

**Step 2: Run → FAIL.**

**Step 3: Implement (append)**

```python
def mask_from_stash(data, image):
    b, h, w = image.shape[0], image.shape[1], image.shape[2]
    if not data:
        return torch.zeros((b, h, w), dtype=torch.float32)
    m = Image.open(io.BytesIO(data)).convert("L")
    arr = np.array(m, dtype=np.float32) / 255.0
    return torch.from_numpy(arr).unsqueeze(0)
```

**Step 4: Run → PASS.**  **Step 5: Commit** `feat: gate mask_from_stash (paint or zeros)`

---

### Task 5: `gate.py` — `ImageGate` node class

**Files:** Modify `gates/gate.py`, `tests/test_gate.py`

**Step 0: Verify the interrupt symbol** (so Stop cancels cleanly):
`grep -n "class InterruptProcessingException\|def interrupt_current_processing" /media/p5/Comfyui/comfy/model_management.py`
Use whatever exists (expected: `InterruptProcessingException`).

**Step 1: Failing test**

```python
import math

def test_is_changed_always_nan():
    v = gate.ImageGate.IS_CHANGED(image=None, routes=2, unique_id="1")
    assert math.isnan(v)

def test_return_types_shape():
    assert gate.ImageGate.RETURN_TYPES[0] == "MASK"
    assert len(gate.ImageGate.RETURN_TYPES) == gate.MAX_ROUTES + 1
    assert all(t == "IMAGE" for t in gate.ImageGate.RETURN_TYPES[1:])
```

**Step 2: Run → FAIL.**

**Step 3: Implement (append)**

```python
class ImageGate:
    CATEGORY = "Datasete Gates"
    FUNCTION = "run"
    RETURN_TYPES = ("MASK",) + ("IMAGE",) * MAX_ROUTES
    RETURN_NAMES = ("mask",) + tuple(f"route_{i + 1}" for i in range(MAX_ROUTES))

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image": ("IMAGE",),
                "routes": ("INT", {"default": 2, "min": 1, "max": MAX_ROUTES}),
            },
            "hidden": {"unique_id": "UNIQUE_ID"},
        }

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        return float("nan")            # always pause; never cached

    def run(self, image, routes, unique_id):
        from comfy_execution.graph_utils import ExecutionBlocker
        from . import gate_server

        gate_bus.GateBus.arm(unique_id)
        gate_server.send_preview(unique_id, image, routes)
        try:
            chosen_1 = gate_bus.GateBus.wait(unique_id)
        except gate_bus.GateCancelled:
            import comfy.model_management as mm
            raise mm.InterruptProcessingException()   # confirm symbol in Step 0

        mask = mask_from_stash(gate_bus.GateBus.pop_mask(unique_id), image)
        chosen = max(0, min(chosen_1 - 1, routes - 1))
        blocker = ExecutionBlocker(None)
        return (mask,) + route_tuple(chosen, image, blocker, MAX_ROUTES)


NODE_CLASS_MAPPINGS = {"ImageGate": ImageGate}
NODE_DISPLAY_NAME_MAPPINGS = {"ImageGate": "Image Gate (Manual Router)"}
```

**Step 4: Run → PASS.** (`run()` itself is covered by the live smoke test, not unit tests.)

**Step 5: Commit** `feat: ImageGate node — pause, route via ExecutionBlocker, mask out`

---

### Task 6: `gate_server.py` — routes + preview, and register (MERGE)

**Files:** Create `gates/gate_server.py`; Modify `__init__.py`

**Step 1: Implement `gates/gate_server.py`** (aiohttp glue — verified live, not unit-tested)

```python
# gates/gate_server.py
import base64
import io

import numpy as np
from aiohttp import web
from PIL import Image
from server import PromptServer

from .gate_bus import GateBus

routes = PromptServer.instance.routes


def send_preview(node_id, image, n_routes):
    arr = (image[0].cpu().numpy() * 255.0).clip(0, 255).astype("uint8")
    buf = io.BytesIO()
    Image.fromarray(arr).save(buf, "PNG")
    b64 = base64.b64encode(buf.getvalue()).decode()
    PromptServer.instance.send_sync(
        "datasete-gate-show",
        {"id": str(node_id), "image": b64, "routes": int(n_routes)},
    )


@routes.post("/datasete_gate/choice")
async def _choice(request):
    post = await request.post()
    GateBus.put(post.get("id"), post.get("message"))
    return web.json_response({})


@routes.post("/datasete_gate/mask")
async def _mask(request):
    reader = await request.multipart()
    node_id, data = None, None
    async for part in reader:
        if part.name == "id":
            node_id = await part.text()
        elif part.name == "mask":
            data = await part.read(decode=False)
    if node_id is not None:
        GateBus.put_mask(node_id, data)
    return web.json_response({})
```

**Step 2: Re-Read `__init__.py`** and extend the `if __package__:` block to merge the gate
node and import its server (registers routes):

```python
    from .gates.gate import NODE_CLASS_MAPPINGS as _GATE_NODES, \
        NODE_DISPLAY_NAME_MAPPINGS as _GATE_NAMES
    from .gates import gate_server  # noqa: F401  (registers /datasete_gate/* routes)
    NODE_CLASS_MAPPINGS = {**NODE_CLASS_MAPPINGS, **_GATE_NODES}
    NODE_DISPLAY_NAME_MAPPINGS = {**NODE_DISPLAY_NAME_MAPPINGS, **_GATE_NAMES}
```
(Adapt to the file's current merge structure; the only requirement is the gate node ends up
in the mappings and `gate_server` is imported.)

**Step 3:** `$PY -c "import gates.gate; print(gates.gate.NODE_CLASS_MAPPINGS)"` → shows ImageGate.

**Step 4:** Full suite green: `$PY -m pytest tests/ -v`

**Step 5: Commit** `feat: gate server routes + preview + register ImageGate`

---

### Task 7: `web/image_gate.js` — preview, dynamic outputs, buttons

**Files:** Create `web/image_gate.js`

Implement an `app.registerExtension` for `ImageGate`:
- **Dynamic outputs:** on `nodeCreated` and when the `routes` widget changes, show only the
  first `routes` of the 10 `route_*` outputs (hide/remove the rest); give each visible output
  an editable label (default `1..N`) persisted in `widgets_values`; keep the `mask` output
  (slot 0) always visible. (Reuse your existing dynamic-slot pattern.)
- **Preview + buttons:** listen for the `datasete-gate-show` socket event
  (`api.addEventListener`); when it fires for this node's id, render the image in a DOM widget
  with: one button per visible route (labeled), an **🖌 Edit mask** button, and a **■ Stop**
  button.
- **Choice:** route button → POST `/datasete_gate/choice` `{id, message: <1-based index>}`.
  Stop → POST `{id, message: "__cancel__"}`.
- **Mask:** 🖌 → open MaskEditor on the previewed image (reuse the pool node's clipspace
  helper); on save, export the grayscale mask PNG and POST it to `/datasete_gate/mask`
  (multipart `id`, `mask`) **before** clicking a route.

**Manual verification (live, Task 8 covers the run):** node shows N labeled outputs that
track the `routes` widget; labels persist across reload.

**Commit** `feat: image gate frontend — preview, dynamic outputs, route/stop/mask`

---

### Task 8: Live smoke test in ComfyUI

Restart ComfyUI (repo already symlinked into `custom_nodes`). Build: `Folder Image Loader →
Image Gate`, wire `route_1`/`route_2` to two `PreviewImage`/`SaveImage` nodes, `mask` to a
`MaskPreview`. Verify:
- [ ] "Image Gate (Manual Router)" appears under "Datasete Gates".
- [ ] Queue → execution **pauses**, image preview + labeled buttons + 🖌 + ■ appear.
- [ ] Click route 1 → only route-1's downstream runs; route-2's does not.
- [ ] Click route 2 → only route-2's downstream runs.
- [ ] 🖌 Edit mask → MaskEditor opens; paint, save; then click a route → `mask` output carries the painted mask; no mask painted → zeros.
- [ ] ■ Stop → the run cancels cleanly (no scary traceback; queue stops).
- [ ] Change `routes` from 2→4 → two more labeled outputs appear; reload keeps labels.
- [ ] Run twice in a row → it pauses **both** times (not cached).

**Commit** (if fixes) `fix: image gate live-test adjustments`

---

## Definition of done

- `$PY -m pytest tests/test_gate_bus.py tests/test_gate.py -v` green; full `tests/` green.
- Manual checklist passes: pause, route isolation (ExecutionBlocker), mask round-trip, clean Stop, dynamic labeled outputs.
