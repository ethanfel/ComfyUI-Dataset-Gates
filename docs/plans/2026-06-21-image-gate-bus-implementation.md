# Image Gate Send/Get Bus Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Extend `Image Gate (Manual Router)` so it can auto-publish a passed image+mask to a named disk bus (`send_id`) and, when its `image` input is empty, load from a named slot (`get_id`) — enabling wireless, cycle-free "restart from the gate point" across runs.

**Architecture:** A pure stdlib `gates/imagebus.py` manages slot dirs under `input/gate_bus/<id>/`. `gates/imaging.py` gains tensor PNG savers mirroring its loaders. `gates/gate.py` gains `bus_save`/`bus_load` + a pure `resolve_source`, and `run()` makes `image` optional, loads from `get_id` when absent, and publishes to `send_id` on pass. A `GET /datasete_gate/bus/list` route feeds the `get_id` dropdown.

**Tech Stack:** Python 3.12, torch 2.8, Pillow, numpy, aiohttp; pytest 9; vanilla JS.

---

## Conventions (read once)

- **Test python:** `/media/p5/miniforge3/bin/python` (`PY=...`).
- **Run tests:** `cd /media/p5/ComfyUI-Datasete-Gates && $PY -m pytest tests/test_imagebus.py tests/test_gate.py tests/test_imaging.py -v`
- All edits to `gate.py`, `imaging.py`, `gates_compat.py`, `gate_server.py` are **additive** —
  re-Read first, keep the existing Image Gate behavior, run full suite after.
- `gates/imagebus.py` stays stdlib-only. `gate.py` keeps comfy imports lazy (inside `run`).
- Bus base dir = `gates_compat.gate_bus_base()` = `input/gate_bus`.
- Commit style: Conventional Commits + repo Co-Authored-By trailer; stage only this feature's paths.

---

### Task 1: `gates_compat.py` — `gate_bus_base()`

**Files:** Modify `gates/gates_compat.py`

**Step 1:** Re-Read the file, then append (mirrors `grid_pool_base`):

```python
def gate_bus_base():
    import folder_paths
    return os.path.join(folder_paths.get_input_directory(), "gate_bus")
```

**Step 2:** Verify import: `$PY -c "import gates.gates_compat as c; print(hasattr(c,'gate_bus_base'))"` → `True`.

**Step 3: Commit** `feat: gate_bus_base() path helper`

---

### Task 2: `imagebus.py` — slot paths + list/has/delete

**Files:** Create `gates/imagebus.py`; Test `tests/test_imagebus.py`

**Step 1: Failing test**

```python
# tests/test_imagebus.py
from gates import imagebus as ib

def test_paths(tmp_path):
    base = str(tmp_path)
    assert ib.image_path(base, "cp1").name == "image.png"
    assert ib.mask_path(base, "cp1").name == "mask.png"
    assert ib.bus_dir(base, "cp1").name == "cp1"

def test_has_and_ensure(tmp_path):
    base = str(tmp_path)
    assert ib.has(base, "cp1") is False
    ib.ensure_dir(base, "cp1")
    ib.image_path(base, "cp1").write_bytes(b"x")
    assert ib.has(base, "cp1") is True

def test_list_ids_only_populated(tmp_path):
    base = str(tmp_path)
    ib.ensure_dir(base, "empty")                       # dir but no image.png
    ib.ensure_dir(base, "cp1"); ib.image_path(base, "cp1").write_bytes(b"x")
    ib.ensure_dir(base, "cp2"); ib.image_path(base, "cp2").write_bytes(b"y")
    assert ib.list_ids(base) == ["cp1", "cp2"]

def test_delete(tmp_path):
    base = str(tmp_path)
    ib.ensure_dir(base, "cp1"); ib.image_path(base, "cp1").write_bytes(b"x")
    ib.delete_id(base, "cp1")
    assert not ib.bus_dir(base, "cp1").exists()
```

**Step 2: Run → FAIL.**

**Step 3: Implement**

```python
# gates/imagebus.py
"""Disk-backed image bus for Image Gate send/get. Stdlib only."""
import shutil
from pathlib import Path


def bus_dir(base, bus_id):
    return Path(base) / bus_id


def image_path(base, bus_id):
    return bus_dir(base, bus_id) / "image.png"


def mask_path(base, bus_id):
    return bus_dir(base, bus_id) / "mask.png"


def has(base, bus_id):
    return image_path(base, bus_id).exists()


def ensure_dir(base, bus_id):
    d = bus_dir(base, bus_id)
    d.mkdir(parents=True, exist_ok=True)
    return d


def list_ids(base):
    p = Path(base)
    if not p.is_dir():
        return []
    return sorted(d.name for d in p.iterdir() if d.is_dir() and (d / "image.png").exists())


def delete_id(base, bus_id):
    d = bus_dir(base, bus_id)
    if d.exists():
        shutil.rmtree(d)
```

**Step 4: Run → PASS.**  **Step 5: Commit** `feat: imagebus slot store`

---

### Task 3: `imaging.py` — tensor PNG savers

**Files:** Modify `gates/imaging.py`; Test `tests/test_imaging.py`

**Step 1: Failing test** (add)

```python
import torch
from gates import imaging

def test_save_load_image_roundtrip(tmp_path):
    img = torch.zeros((1, 6, 4, 3), dtype=torch.float32)
    img[0, 0, 0, 0] = 1.0                                  # red corner
    p = str(tmp_path / "image.png")
    imaging.save_image_tensor(p, img)
    back = imaging.load_image_tensor(p)
    assert back.shape == (1, 6, 4, 3)
    assert float(back[0, 0, 0, 0]) > 0.99

def test_save_load_mask_roundtrip(tmp_path):
    mask = torch.ones((1, 6, 4), dtype=torch.float32)
    p = str(tmp_path / "mask.png")
    imaging.save_mask_tensor(p, mask)
    back = imaging.load_mask_tensor(p, 6, 4)
    assert back.shape == (1, 6, 4)
    assert float(back.min()) > 0.99
```

**Step 2: Run → FAIL.**

**Step 3: Implement (append to `imaging.py`)**

```python
def save_image_tensor(path, image):
    arr = (image[0].cpu().numpy() * 255.0).clip(0, 255).astype("uint8")
    Image.fromarray(arr).save(path)


def save_mask_tensor(path, mask):
    arr = (mask[0].cpu().numpy() * 255.0).clip(0, 255).astype("uint8")
    Image.fromarray(arr, mode="L").save(path)
```

**Step 4: Run → PASS.**  **Step 5: Commit** `feat: imaging tensor PNG savers`

---

### Task 4: `gate.py` — `bus_save` / `bus_load` / `resolve_source`

**Files:** Modify `gates/gate.py`, `tests/test_gate.py`

**Step 1: Failing test**

```python
import torch
from gates import gate

def _img(r=1.0):
    t = torch.zeros((1, 6, 4, 3), dtype=torch.float32)
    t[0, 0, 0, 0] = r
    return t

def test_bus_save_load_roundtrip(tmp_path):
    base = str(tmp_path)
    gate.bus_save(base, "cp1", _img(1.0), torch.ones((1, 6, 4)))
    img, mask = gate.bus_load(base, "cp1")
    assert img.shape == (1, 6, 4, 3) and float(img[0, 0, 0, 0]) > 0.99
    assert mask.shape == (1, 6, 4) and float(mask.min()) > 0.99

def test_resolve_source_image_wins(tmp_path):
    img = _img()
    out_img, out_mask = gate.resolve_source(str(tmp_path), img, "cp1")
    assert out_img is img and out_mask is None          # given image ignores the bus

def test_resolve_source_loads_from_get(tmp_path):
    base = str(tmp_path)
    gate.bus_save(base, "cp1", _img(1.0), torch.zeros((1, 6, 4)))
    out_img, out_mask = gate.resolve_source(base, None, "cp1")
    assert out_img.shape == (1, 6, 4, 3) and out_mask.shape == (1, 6, 4)

def test_resolve_source_nothing(tmp_path):
    assert gate.resolve_source(str(tmp_path), None, "") == (None, None)
    assert gate.resolve_source(str(tmp_path), None, "missing") == (None, None)
```

**Step 2: Run → FAIL.**

**Step 3: Implement (append to `gate.py`; add `from . import imagebus, imaging` at top)**

```python
def bus_save(base, bus_id, image, mask):
    imagebus.ensure_dir(base, bus_id)
    imaging.save_image_tensor(str(imagebus.image_path(base, bus_id)), image)
    imaging.save_mask_tensor(str(imagebus.mask_path(base, bus_id)), mask)


def bus_load(base, bus_id):
    img = imaging.load_image_tensor(str(imagebus.image_path(base, bus_id)))
    h, w = int(img.shape[1]), int(img.shape[2])
    mp = imagebus.mask_path(base, bus_id)
    mask = imaging.load_mask_tensor(str(mp) if mp.exists() else None, h, w)
    return img, mask


def resolve_source(base, image, get_id):
    if image is not None:
        return image, None
    if get_id and imagebus.has(base, get_id):
        return bus_load(base, get_id)
    return None, None
```

**Step 4: Run → PASS.**  **Step 5: Commit** `feat: gate bus_save/bus_load/resolve_source`

---

### Task 5: `gate.py` — wire send/get into `ImageGate` (MERGE)

**Files:** Modify `gates/gate.py`, `tests/test_gate.py`

**Step 1: Failing test** (input shape)

```python
def test_image_gate_optional_inputs():
    it = gate.ImageGate.INPUT_TYPES()
    assert "image" in it["optional"]
    assert "send_id" in it["optional"] and "get_id" in it["optional"]
    assert "routes" in it["required"]
```

**Step 2: Run → FAIL.**

**Step 3: Implement** — re-Read `gate.py`, then:
- `INPUT_TYPES`:
  ```python
  return {
      "required": {"routes": ("INT", {"default": 2, "min": 1, "max": MAX_ROUTES})},
      "optional": {
          "image": ("IMAGE",),
          "send_id": ("STRING", {"default": ""}),
          "get_id": ("STRING", {"default": ""}),
      },
      "hidden": {"unique_id": "UNIQUE_ID"},
  }
  ```
- `run` signature + body:
  ```python
  def run(self, routes, unique_id, image=None, send_id="", get_id=""):
      from comfy_execution.graph_utils import ExecutionBlocker
      from . import gate_server
      from .gates_compat import gate_bus_base

      base = gate_bus_base()
      image, loaded_mask = resolve_source(base, image, get_id)
      blocker = ExecutionBlocker(None)
      if image is None:                                  # nothing to gate -> silent no-op
          return (torch.zeros((1, 1, 1), dtype=torch.float32),) + tuple(
              blocker for _ in range(MAX_ROUTES))

      gate_bus.GateBus.arm(unique_id)
      gate_server.send_preview(unique_id, image, routes)
      try:
          chosen_1 = gate_bus.GateBus.wait(unique_id)
      except gate_bus.GateCancelled:
          import comfy.model_management as mm
          raise mm.InterruptProcessingException()

      painted = gate_bus.GateBus.pop_mask(unique_id)
      if painted:
          mask = mask_from_stash(painted, image)
      elif loaded_mask is not None:
          mask = loaded_mask
      else:
          mask = mask_from_stash(None, image)

      if send_id:
          bus_save(base, send_id, image, mask)

      chosen = max(0, min(chosen_1 - 1, routes - 1))
      return (mask,) + route_tuple(chosen, image, blocker, MAX_ROUTES)
  ```

**Step 4: Run → PASS** (existing gate tests still pass).

**Step 5: Commit** `feat: Image Gate send_id/get_id bus (optional image, publish on pass)`

---

### Task 6: `gate_server.py` — bus list route

**Files:** Modify `gates/gate_server.py`

**Step 1:** Re-Read, then append (additive):

```python
@routes.get("/datasete_gate/bus/list")
async def _bus_list(request):
    from .gates_compat import gate_bus_base
    from . import imagebus
    return web.json_response({"ids": imagebus.list_ids(gate_bus_base())})
```

**Step 2:** Full suite green: `$PY -m pytest tests/ -v`.

**Step 3: Commit** `feat: gate bus/list route for get_id dropdown`

---

### Task 7: `web/image_gate.js` — optional image + send/get widgets

**Files:** Modify `web/image_gate.js`

- Ensure the node tolerates an **empty `image` input** (it's optional now).
- `send_id`: leave as a plain text widget.
- `get_id`: turn into a **dropdown** populated from `GET /datasete_gate/bus/list` (fetch on
  node create and when the widget is opened/clicked); allow free-text too.
- No change to the pause/preview flow — preview still arrives from the server after the
  source is resolved (so get-loaded images preview fine).

**Manual note:** verify the dropdown lists published ids and refreshes after a pass elsewhere.

**Commit** `feat: image gate frontend — send_id widget + get_id dropdown`

---

### Task 8: Live smoke test in ComfyUI

Restart ComfyUI. Verify:
- [ ] Existing gate with a wired `image` works exactly as before (bus ignored).
- [ ] Set `send_id=cp1` on a gate, pass an image → `input/gate_bus/cp1/{image,mask}.png` appear.
- [ ] A second gate with **no image wired** and `get_id=cp1` → loads that image (+ mask),
      pauses, and routes onward.
- [ ] Works in a **new workflow** / after a restart (cross-run resume).
- [ ] `get_id` dropdown lists existing bus ids.
- [ ] Gate with no image and no/invalid `get_id` → silent no-op (nothing downstream runs).
- [ ] Mask precedence: paint at the get-gate overrides the loaded mask.

**Commit** (if fixes) `fix: image gate bus live-test adjustments`

---

## Definition of done

- `$PY -m pytest tests/test_imagebus.py tests/test_imaging.py tests/test_gate.py -v` green;
  full `tests/` green (existing gate/pool/loader/text unaffected).
- Manual checklist passes: publish on pass, get-load (incl. cross-run), dropdown, optional
  image, mask precedence, silent no-op.
