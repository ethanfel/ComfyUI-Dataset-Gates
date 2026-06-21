# Image Pool (Grid) Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a ComfyUI custom node `Image Pool (Grid)` that holds a curated pool of images — each with its own remembered mask and editable label — displayed as an in-node grid, with one selectable as the output (image + mask + index + count + label).

**Architecture:** Pure Python storage layer (`gates/pool.py`, stdlib only — fully unit-testable) manages a managed pool folder under `input/grid_pool/<pool_id>/` with an atomic `manifest.json`. A thin tensor/imaging layer (`gates/imaging.py`, torch+PIL) loads slots into ComfyUI tensors. The node class (`gates/node.py`) wires them together. aiohttp routes (`gates/routes.py`) let the frontend mutate the pool. A JS extension (`web/grid_image_pool.js`) renders the grid, ingests images (paste/drop/upload), and reuses ComfyUI's MaskEditor via the clipspace mechanism.

**Tech Stack:** Python 3.12, torch 2.8, Pillow, numpy, aiohttp (ComfyUI's `PromptServer`), pytest 9; vanilla JS frontend extension (LiteGraph DOM widget + ComfyUI `app`/`api`).

---

## Conventions (read once)

- **Test python:** `/media/p5/miniforge3/bin/python` (call as `PY=/media/p5/miniforge3/bin/python`).
- **Run tests:** `cd /media/p5/ComfyUI-Datasete-Gates && $PY -m pytest tests/ -v`
- **Repo root:** `/media/p5/ComfyUI-Datasete-Gates` (already a git repo with the design doc committed).
- **Install for live testing:** ComfyUI loads custom nodes from `/media/p5/Comfyui/custom_nodes/`. After phase 1 we symlink the repo in:
  `ln -s /media/p5/ComfyUI-Datasete-Gates /media/p5/Comfyui/custom_nodes/ComfyUI-Datasete-Gates`
- **Mask convention:** a mask PNG is grayscale `L`; white (1.0) = the region of interest (area to inpaint). MASK output is `[1,H,W]` float 0..1. No mask file → all-zeros.
- **Image tensor:** `[1,H,W,3]` float 0..1 (ComfyUI IMAGE).
- **Commit style:** Conventional Commits, end body with the Co-Authored-By trailer used in the design-doc commit.
- `gates/pool.py` MUST stay stdlib-only (no torch / no `folder_paths`) so it tests without ComfyUI.
- `gates/node.py` MUST resolve the pool base dir through `_grid_pool_base()` so tests can monkeypatch it (never import `folder_paths` at module top level).

---

# PHASE 1 — Pool storage, node output (no masking), grid UI

### Task 1: Scaffold the package so ComfyUI can load it

**Files:**
- Create: `gates/__init__.py` (empty)
- Create: `pyproject.toml`
- Create: `__init__.py` (repo root — mappings + WEB_DIRECTORY)
- Create: `web/grid_image_pool.js` (placeholder)
- Create: `tests/__init__.py` (empty)
- Create: `requirements.txt` (empty — deps already in comfy env)

**Step 1: Write `pyproject.toml`**

```toml
[project]
name = "comfyui-datasete-gates"
version = "0.1.0"
description = "Dataset Gates — Image Pool (Grid) node for ComfyUI"
requires-python = ">=3.10"

[tool.comfy]
PublisherId = "ethanfel"
DisplayName = "ComfyUI Datasete Gates"
```

**Step 2: Write repo-root `__init__.py`**

```python
"""ComfyUI-Datasete-Gates — custom nodes."""
from .gates.node import NODE_CLASS_MAPPINGS, NODE_DISPLAY_NAME_MAPPINGS
from .gates import routes  # noqa: F401  (registers aiohttp routes on import)

WEB_DIRECTORY = "./web"

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
```

> Note: `gates.node` and `gates.routes` are created in later tasks. Until Task 8/9 exist, temporarily comment those imports OR do Task 1 last. Recommended: create the files as empty stubs now (`NODE_CLASS_MAPPINGS = {}` etc.) and fill them in their tasks.

**Step 3: Create stub `web/grid_image_pool.js`**

```javascript
import { app } from "../../scripts/app.js";
app.registerExtension({ name: "datasete.gates.imagepool" });
```

**Step 4: Verify package imports (pure)**

Run: `cd /media/p5/ComfyUI-Datasete-Gates && /media/p5/miniforge3/bin/python -c "import gates"`
Expected: no error.

**Step 5: Commit**

```bash
git add pyproject.toml __init__.py gates/ web/ tests/ requirements.txt
git commit -m "chore: scaffold ComfyUI-Datasete-Gates package"
```

---

### Task 2: `pool.py` — empty manifest + atomic read/write

**Files:**
- Create: `gates/pool.py`
- Test: `tests/test_pool.py`

**Step 1: Write the failing test**

```python
# tests/test_pool.py
import json
from pathlib import Path
from gates import pool

def test_empty_manifest_shape():
    m = pool.empty_manifest()
    assert m == {"active": 0, "slots": [], "next_seq": 1}

def test_read_missing_creates_empty(tmp_path):
    m = pool.read_manifest(str(tmp_path), "p1")
    assert m == pool.empty_manifest()

def test_write_then_read_roundtrip(tmp_path):
    m = pool.empty_manifest()
    m["active"] = 2
    pool.write_manifest(str(tmp_path), "p1", m)
    # file lives at <base>/p1/manifest.json
    assert (tmp_path / "p1" / "manifest.json").exists()
    assert pool.read_manifest(str(tmp_path), "p1") == m

def test_write_is_atomic_no_partial_temp_left(tmp_path):
    pool.write_manifest(str(tmp_path), "p1", pool.empty_manifest())
    leftovers = list((tmp_path / "p1").glob("*.tmp"))
    assert leftovers == []
```

**Step 2: Run to verify fail**

Run: `$PY -m pytest tests/test_pool.py -v`
Expected: FAIL (module/functions missing).

**Step 3: Implement**

```python
# gates/pool.py
"""Pure storage layer for the Image Pool node. Stdlib only — no torch, no comfy."""
import json
import os
from pathlib import Path


def empty_manifest():
    return {"active": 0, "slots": [], "next_seq": 1}


def pool_dir(base_dir, pool_id):
    return Path(base_dir) / pool_id


def manifest_path(base_dir, pool_id):
    return pool_dir(base_dir, pool_id) / "manifest.json"


def read_manifest(base_dir, pool_id):
    p = manifest_path(base_dir, pool_id)
    if not p.exists():
        return empty_manifest()
    try:
        with open(p, "r", encoding="utf-8") as f:
            m = json.load(f)
        # minimal shape guard
        if not isinstance(m, dict) or "slots" not in m:
            raise ValueError("bad manifest")
        m.setdefault("active", 0)
        m.setdefault("next_seq", len(m.get("slots", [])) + 1)
        return m
    except (ValueError, json.JSONDecodeError):
        return rebuild_manifest(base_dir, pool_id)


def write_manifest(base_dir, pool_id, manifest):
    d = pool_dir(base_dir, pool_id)
    d.mkdir(parents=True, exist_ok=True)
    final = d / "manifest.json"
    tmp = d / "manifest.json.tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2)
    os.replace(tmp, final)  # atomic on same filesystem
    return manifest
```

> `rebuild_manifest` is referenced here but implemented in Task 7. Add a temporary stub returning `empty_manifest()` now; replace it in Task 7. (Its test arrives in Task 7.)

**Step 4: Run to verify pass**

Run: `$PY -m pytest tests/test_pool.py -v`
Expected: PASS (4 tests).

**Step 5: Commit**

```bash
git add gates/pool.py tests/test_pool.py
git commit -m "feat: pool manifest read/write with atomic save"
```

---

### Task 3: `pool.py` — `next_image_name` + `add_image`

**Files:** Modify `gates/pool.py`; Modify `tests/test_pool.py`

**Step 1: Failing test**

```python
def test_next_image_name_uses_next_seq():
    m = pool.empty_manifest()
    assert pool.next_image_name(m) == "img_0001.png"
    m["next_seq"] = 42
    assert pool.next_image_name(m) == "img_0042.png"

def test_add_image_writes_file_and_appends_slot(tmp_path):
    data = b"\x89PNG\r\n\x1a\n" + b"fake"  # bytes are written verbatim
    m = pool.add_image(str(tmp_path), "p1", data, ts=123)
    assert len(m["slots"]) == 1
    slot = m["slots"][0]
    assert slot == {"image": "img_0001.png", "mask": None, "label": "", "added": 123}
    assert m["next_seq"] == 2
    assert (tmp_path / "p1" / "img_0001.png").read_bytes() == data

def test_add_image_monotonic_after_growth(tmp_path):
    pool.add_image(str(tmp_path), "p1", b"a", ts=1)
    m = pool.add_image(str(tmp_path), "p1", b"b", ts=2)
    assert [s["image"] for s in m["slots"]] == ["img_0001.png", "img_0002.png"]
```

**Step 2: Run → FAIL.**  `$PY -m pytest tests/test_pool.py -v`

**Step 3: Implement (append to `pool.py`)**

```python
def next_image_name(manifest):
    return f"img_{manifest.get('next_seq', 1):04d}.png"


def add_image(base_dir, pool_id, data, ts=0):
    m = read_manifest(base_dir, pool_id)
    name = next_image_name(m)
    d = pool_dir(base_dir, pool_id)
    d.mkdir(parents=True, exist_ok=True)
    with open(d / name, "wb") as f:
        f.write(data)
    m["slots"].append({"image": name, "mask": None, "label": "", "added": ts})
    m["next_seq"] = m.get("next_seq", 1) + 1
    write_manifest(base_dir, pool_id, m)
    return m
```

**Step 4: Run → PASS.**

**Step 5: Commit**

```bash
git add gates/pool.py tests/test_pool.py
git commit -m "feat: pool add_image + monotonic naming"
```

---

### Task 4: `pool.py` — `remove_slot` (deletes files, fixes active)

**Files:** Modify `gates/pool.py`; Modify `tests/test_pool.py`

**Step 1: Failing test**

```python
def test_remove_slot_deletes_files_and_reindexes(tmp_path):
    pool.add_image(str(tmp_path), "p1", b"a", ts=1)
    pool.add_image(str(tmp_path), "p1", b"b", ts=2)
    pool.add_image(str(tmp_path), "p1", b"c", ts=3)
    m = pool.set_active(str(tmp_path), "p1", 2)          # active=2
    m = pool.remove_slot(str(tmp_path), "p1", 0)         # drop first
    assert [s["image"] for s in m["slots"]] == ["img_0002.png", "img_0003.png"]
    assert not (tmp_path / "p1" / "img_0001.png").exists()
    assert m["active"] == 1                              # shifted down

def test_remove_active_clamps(tmp_path):
    pool.add_image(str(tmp_path), "p1", b"a", ts=1)
    pool.add_image(str(tmp_path), "p1", b"b", ts=2)
    pool.set_active(str(tmp_path), "p1", 1)
    m = pool.remove_slot(str(tmp_path), "p1", 1)         # removed the active last one
    assert m["active"] == 0
    assert len(m["slots"]) == 1
```

> `set_active` is needed here; implement it in Task 5 first OR move Task 5 before Task 4. The plan keeps numbering but executor may reorder 4/5 freely. Simplest: do Task 5 then Task 4. (Marked.)

**Step 2: Run → FAIL.**

**Step 3: Implement**

```python
def remove_slot(base_dir, pool_id, index):
    m = read_manifest(base_dir, pool_id)
    if index < 0 or index >= len(m["slots"]):
        return m
    slot = m["slots"].pop(index)
    d = pool_dir(base_dir, pool_id)
    for key in ("image", "mask"):
        name = slot.get(key)
        if name:
            f = d / name
            if f.exists():
                f.unlink()
    if index < m["active"]:
        m["active"] -= 1
    m["active"] = _clamp_active(m)
    write_manifest(base_dir, pool_id, m)
    return m


def _clamp_active(m):
    n = len(m["slots"])
    if n == 0:
        return 0
    return max(0, min(m.get("active", 0), n - 1))
```

**Step 4: Run → PASS.**

**Step 5: Commit** `feat: pool remove_slot with file cleanup`

---

### Task 5: `pool.py` — `set_active` + `resolve_slot` (the -1 / clamp rule)

**Files:** Modify `gates/pool.py`; Modify `tests/test_pool.py`

**Step 1: Failing test**

```python
def test_set_active_clamps(tmp_path):
    pool.add_image(str(tmp_path), "p1", b"a", ts=1)
    pool.add_image(str(tmp_path), "p1", b"b", ts=2)
    assert pool.set_active(str(tmp_path), "p1", 1)["active"] == 1
    assert pool.set_active(str(tmp_path), "p1", 9)["active"] == 1   # clamp high
    assert pool.set_active(str(tmp_path), "p1", -5)["active"] == 0  # clamp low

def test_resolve_slot_rules():
    m = {"active": 1, "slots": [0, 1, 2], "next_seq": 4}   # 3 slots
    assert pool.resolve_slot(m, -1) == 1     # manual -> active
    assert pool.resolve_slot(m, 0) == 0      # forced
    assert pool.resolve_slot(m, 9) == 2      # clamp high
    assert pool.resolve_slot({"active": 0, "slots": [], "next_seq": 1}, -1) == -1  # empty
```

**Step 2: Run → FAIL.**

**Step 3: Implement**

```python
def set_active(base_dir, pool_id, index):
    m = read_manifest(base_dir, pool_id)
    m["active"] = index
    m["active"] = _clamp_active(m)
    write_manifest(base_dir, pool_id, m)
    return m


def resolve_slot(manifest, index_widget):
    n = len(manifest["slots"])
    if n == 0:
        return -1
    idx = manifest.get("active", 0) if index_widget == -1 else index_widget
    return max(0, min(idx, n - 1))
```

**Step 4: Run → PASS.**

**Step 5: Commit** `feat: pool set_active + resolve_slot selection rule`

---

### Task 6: `pool.py` — `set_label`

**Files:** Modify `gates/pool.py`; Modify `tests/test_pool.py`

**Step 1: Failing test**

```python
def test_set_label(tmp_path):
    pool.add_image(str(tmp_path), "p1", b"a", ts=1)
    m = pool.set_label(str(tmp_path), "p1", 0, "front view")
    assert m["slots"][0]["label"] == "front view"

def test_set_label_out_of_range_noop(tmp_path):
    pool.add_image(str(tmp_path), "p1", b"a", ts=1)
    m = pool.set_label(str(tmp_path), "p1", 5, "x")
    assert m["slots"][0]["label"] == ""
```

**Step 2: Run → FAIL.**

**Step 3: Implement**

```python
def set_label(base_dir, pool_id, index, label):
    m = read_manifest(base_dir, pool_id)
    if 0 <= index < len(m["slots"]):
        m["slots"][index]["label"] = str(label)
        write_manifest(base_dir, pool_id, m)
    return m
```

**Step 4: Run → PASS.**  **Step 5: Commit** `feat: pool set_label`

---

### Task 7: `pool.py` — `rebuild_manifest` (corrupt/missing recovery)

**Files:** Modify `gates/pool.py`; Modify `tests/test_pool.py`

**Step 1: Failing test**

```python
def test_rebuild_from_files(tmp_path):
    d = tmp_path / "p1"
    d.mkdir()
    (d / "img_0001.png").write_bytes(b"a")
    (d / "img_0001.mask.png").write_bytes(b"m")
    (d / "img_0003.png").write_bytes(b"c")  # gap on purpose
    m = pool.rebuild_manifest(str(tmp_path), "p1")
    assert [s["image"] for s in m["slots"]] == ["img_0001.png", "img_0003.png"]
    assert m["slots"][0]["mask"] == "img_0001.mask.png"
    assert m["slots"][1]["mask"] is None
    assert m["next_seq"] == 4        # max seq 3 + 1
    assert m["active"] == 0

def test_read_corrupt_manifest_triggers_rebuild(tmp_path):
    d = tmp_path / "p1"; d.mkdir()
    (d / "img_0001.png").write_bytes(b"a")
    (d / "manifest.json").write_text("{ not json")
    m = pool.read_manifest(str(tmp_path), "p1")
    assert [s["image"] for s in m["slots"]] == ["img_0001.png"]
```

**Step 2: Run → FAIL** (rebuild stub returns empty).

**Step 3: Replace the stub**

```python
import re

def rebuild_manifest(base_dir, pool_id):
    d = pool_dir(base_dir, pool_id)
    m = empty_manifest()
    if not d.exists():
        return m
    imgs = sorted(p.name for p in d.glob("img_*.png") if not p.name.endswith(".mask.png"))
    max_seq = 0
    for name in imgs:
        match = re.match(r"img_(\d+)\.png$", name)
        seq = int(match.group(1)) if match else 0
        max_seq = max(max_seq, seq)
        mask_name = name.replace(".png", ".mask.png")
        mask = mask_name if (d / mask_name).exists() else None
        m["slots"].append({"image": name, "mask": mask, "label": "", "added": 0})
    m["next_seq"] = max_seq + 1
    return m
```

**Step 4: Run → PASS** (run the whole file: `$PY -m pytest tests/test_pool.py -v`).

**Step 5: Commit** `feat: pool rebuild_manifest recovery`

---

### Task 8: `imaging.py` — tensor loaders + change hash (torch)

**Files:**
- Create: `gates/imaging.py`
- Test: `tests/test_imaging.py`

**Step 1: Failing test**

```python
# tests/test_imaging.py
import numpy as np, torch
from PIL import Image
from gates import imaging

def _png(tmp_path, name, color, size=(4, 6)):  # size = (w, h)
    p = tmp_path / name
    Image.new("RGB", size, color).save(p)
    return str(p)

def test_load_image_tensor_shape_and_range(tmp_path):
    t = imaging.load_image_tensor(_png(tmp_path, "a.png", (255, 0, 0)))
    assert t.shape == (1, 6, 4, 3)         # [B,H,W,C]
    assert t.dtype == torch.float32
    assert 0.0 <= float(t.min()) and float(t.max()) <= 1.0
    assert float(t[0, 0, 0, 0]) > 0.99     # red channel

def test_load_mask_none_is_zeros():
    m = imaging.load_mask_tensor(None, h=6, w=4)
    assert m.shape == (1, 6, 4)
    assert float(m.max()) == 0.0

def test_load_mask_from_file(tmp_path):
    p = tmp_path / "m.png"
    Image.new("L", (4, 6), 255).save(p)
    m = imaging.load_mask_tensor(str(p), h=6, w=4)
    assert m.shape == (1, 6, 4)
    assert float(m.min()) > 0.99

def test_empty_image_is_1x1_black():
    img, mask = imaging.empty_outputs()
    assert img.shape == (1, 1, 1, 3) and float(img.max()) == 0.0
    assert mask.shape == (1, 1, 1)

def test_change_hash_changes_with_mtime():
    h1 = imaging.change_hash("p", 0, [1000.0])
    h2 = imaging.change_hash("p", 0, [1001.0])
    assert h1 != h2
```

**Step 2: Run → FAIL.** `$PY -m pytest tests/test_imaging.py -v`

**Step 3: Implement**

```python
# gates/imaging.py
"""Tensor/imaging helpers (torch + PIL). No comfy imports."""
import hashlib
import numpy as np
import torch
from PIL import Image, ImageOps


def load_image_tensor(path):
    img = Image.open(path)
    img = ImageOps.exif_transpose(img).convert("RGB")
    arr = np.array(img, dtype=np.float32) / 255.0
    return torch.from_numpy(arr).unsqueeze(0)          # [1,H,W,3]


def load_mask_tensor(path, h, w):
    if not path:
        return torch.zeros((1, h, w), dtype=torch.float32)
    m = Image.open(path).convert("L")
    arr = np.array(m, dtype=np.float32) / 255.0
    return torch.from_numpy(arr).unsqueeze(0)          # [1,H,W]


def empty_outputs():
    return (torch.zeros((1, 1, 1, 3), dtype=torch.float32),
            torch.zeros((1, 1, 1), dtype=torch.float32))


def change_hash(pool_id, index, mtimes):
    key = f"{pool_id}|{index}|" + "|".join(f"{t:.3f}" for t in mtimes)
    return hashlib.sha256(key.encode()).hexdigest()
```

**Step 4: Run → PASS.**

**Step 5: Commit** `feat: imaging tensor loaders + change hash`

---

### Task 9: `node.py` — the `GridImagePool` node

**Files:**
- Create: `gates/node.py`
- Test: `tests/test_node.py`

**Step 1: Failing test**

```python
# tests/test_node.py
import numpy as np, torch
from PIL import Image
from gates import node, pool

def _seed_pool(tmp_path, monkeypatch):
    base = str(tmp_path / "grid_pool")
    monkeypatch.setattr(node, "_grid_pool_base", lambda: base)
    return base

def _add_png(base, pid, name_bytes_color, ts):
    # write a real PNG via pool.add_image
    import io
    buf = io.BytesIO(); Image.new("RGB", (4, 6), name_bytes_color).save(buf, "PNG")
    return pool.add_image(base, pid, buf.getvalue(), ts=ts)

def test_execute_empty_pool_returns_blank(tmp_path, monkeypatch):
    _seed_pool(tmp_path, monkeypatch)
    n = node.GridImagePool()
    img, mask, idx, count, label = n.run(index=-1, pool_id="p1")
    assert img.shape == (1, 1, 1, 3)
    assert count == 0 and idx == 0 and label == ""

def test_execute_selects_active(tmp_path, monkeypatch):
    base = _seed_pool(tmp_path, monkeypatch)
    _add_png(base, "p1", (255, 0, 0), 1)
    _add_png(base, "p1", (0, 255, 0), 2)
    pool.set_active(base, "p1", 1)
    pool.set_label(base, "p1", 1, "green")
    n = node.GridImagePool()
    img, mask, idx, count, label = n.run(index=-1, pool_id="p1")
    assert img.shape == (1, 6, 4, 3)
    assert idx == 1 and count == 2 and label == "green"
    assert float(img[0, 0, 0, 1]) > 0.99      # green channel
    assert float(mask.max()) == 0.0           # no mask yet

def test_execute_forced_index_clamps(tmp_path, monkeypatch):
    base = _seed_pool(tmp_path, monkeypatch)
    _add_png(base, "p1", (255, 0, 0), 1)
    n = node.GridImagePool()
    _, _, idx, count, _ = n.run(index=9, pool_id="p1")
    assert idx == 0 and count == 1

def test_is_changed_differs_after_active_change(tmp_path, monkeypatch):
    base = _seed_pool(tmp_path, monkeypatch)
    _add_png(base, "p1", (255, 0, 0), 1)
    _add_png(base, "p1", (0, 255, 0), 2)
    h1 = node.GridImagePool.IS_CHANGED(index=-1, pool_id="p1")
    pool.set_active(base, "p1", 1)
    h2 = node.GridImagePool.IS_CHANGED(index=-1, pool_id="p1")
    assert h1 != h2
```

**Step 2: Run → FAIL.**

**Step 3: Implement**

```python
# gates/node.py
import os
from .gates_compat import grid_pool_base as _grid_pool_base  # see note below
from . import pool, imaging

NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}


class GridImagePool:
    CATEGORY = "Datasete Gates"
    FUNCTION = "run"
    RETURN_TYPES = ("IMAGE", "MASK", "INT", "INT", "STRING")
    RETURN_NAMES = ("image", "mask", "index", "count", "label")

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "index": ("INT", {"default": -1, "min": -1, "max": 9999}),
            },
            "hidden": {"pool_id": "POOL_ID"},
        }

    @staticmethod
    def _resolve(index, pool_id):
        base = _grid_pool_base()
        m = pool.read_manifest(base, pool_id)
        idx = pool.resolve_slot(m, index)
        return base, m, idx

    def run(self, index, pool_id="default"):
        base, m, idx = self._resolve(index, pool_id)
        if idx < 0:
            img, mask = imaging.empty_outputs()
            return (img, mask, 0, 0, "")
        slot = m["slots"][idx]
        d = pool.pool_dir(base, pool_id)
        img = imaging.load_image_tensor(str(d / slot["image"]))
        h, w = int(img.shape[1]), int(img.shape[2])
        mask_name = slot.get("mask")
        mask = imaging.load_mask_tensor(str(d / mask_name) if mask_name else None, h, w)
        return (img, mask, idx, len(m["slots"]), slot.get("label", ""))

    @classmethod
    def IS_CHANGED(cls, index, pool_id="default", **kwargs):
        base, m, idx = cls._resolve(index, pool_id)
        if idx < 0:
            return imaging.change_hash(pool_id, -1, [])
        slot = m["slots"][idx]
        d = pool.pool_dir(base, pool_id)
        mtimes = []
        for key in ("image", "mask"):
            name = slot.get(key)
            p = d / name if name else None
            mtimes.append(os.path.getmtime(p) if p and p.exists() else 0.0)
        # include active so manual selection changes invalidate cache
        return imaging.change_hash(pool_id, f"{idx}:{m.get('active')}", mtimes)


NODE_CLASS_MAPPINGS = {"GridImagePool": GridImagePool}
NODE_DISPLAY_NAME_MAPPINGS = {"GridImagePool": "Image Pool (Grid)"}
```

**Step 3b: Create `gates/gates_compat.py`** (isolates the comfy dependency for testability)

```python
# gates/gates_compat.py
import os

def grid_pool_base():
    import folder_paths  # imported lazily; only available inside ComfyUI
    return os.path.join(folder_paths.get_input_directory(), "grid_pool")
```

> The test monkeypatches `node._grid_pool_base`. Because `node.py` does
> `from .gates_compat import grid_pool_base as _grid_pool_base`, the name
> `node._grid_pool_base` exists at module scope and is patchable. ✅

**Step 4: Run → PASS.** `$PY -m pytest tests/test_node.py -v`

**Step 5: Commit** `feat: GridImagePool node (image/mask/index/count/label + IS_CHANGED)`

---

### Task 10: `routes.py` — aiohttp routes wired to `pool.py`

**Files:**
- Create: `gates/routes.py`
- Test: `tests/test_routes_logic.py` (test the handler *logic* without a live server)

> Routes are thin: parse request → call a pure `_handlers.py` function → JSON. We TDD the pure handler funcs; the aiohttp wrapper is verified live in Task 12.

**Step 1: Failing test**

```python
# tests/test_routes_logic.py
import io
from PIL import Image
from gates import handlers

def _png_bytes(color=(1, 2, 3)):
    b = io.BytesIO(); Image.new("RGB", (4, 4), color).save(b, "PNG"); return b.getvalue()

def test_handle_add_then_list(tmp_path):
    base = str(tmp_path)
    m = handlers.handle_add(base, "p1", _png_bytes(), "png", ts=5)
    assert len(m["slots"]) == 1
    assert handlers.handle_list(base, "p1")["slots"][0]["image"] == "img_0001.png"

def test_handle_active_label_remove(tmp_path):
    base = str(tmp_path)
    handlers.handle_add(base, "p1", _png_bytes(), "png", ts=1)
    handlers.handle_add(base, "p1", _png_bytes(), "png", ts=2)
    assert handlers.handle_active(base, "p1", 1)["active"] == 1
    assert handlers.handle_label(base, "p1", 0, "hi")["slots"][0]["label"] == "hi"
    assert len(handlers.handle_remove(base, "p1", 0)["slots"]) == 1
```

**Step 2: Run → FAIL.**

**Step 3: Implement `gates/handlers.py`**

```python
# gates/handlers.py
"""Pure request handlers — no aiohttp. Each returns the updated manifest dict."""
from . import pool


def handle_add(base, pool_id, data, ext, ts=0):
    return pool.add_image(base, pool_id, data, ts=ts)

def handle_remove(base, pool_id, index):
    return pool.remove_slot(base, pool_id, index)

def handle_active(base, pool_id, index):
    return pool.set_active(base, pool_id, index)

def handle_label(base, pool_id, index, label):
    return pool.set_label(base, pool_id, index, label)

def handle_list(base, pool_id):
    return pool.read_manifest(base, pool_id)

def handle_set_mask(base, pool_id, index, mask_png_bytes):
    return pool.set_mask(base, pool_id, index, mask_png_bytes)  # Task 11
```

**Step 3b: Implement `gates/routes.py`** (aiohttp glue — not unit-tested, verified live)

```python
# gates/routes.py
import json
from aiohttp import web
from server import PromptServer
from . import handlers
from .gates_compat import grid_pool_base

routes = PromptServer.instance.routes


def _base():
    return grid_pool_base()


@routes.post("/grid_pool/add")
async def _add(request):
    reader = await request.multipart()
    pool_id, ts, data = "default", 0, None
    async for part in reader:
        if part.name == "pool_id":
            pool_id = (await part.text())
        elif part.name == "ts":
            ts = int(await part.text())
        elif part.name == "image":
            data = await part.read(decode=False)
    m = handlers.handle_add(_base(), pool_id, data, "png", ts=ts)
    return web.json_response(m)


@routes.post("/grid_pool/remove")
async def _remove(request):
    body = await request.json()
    return web.json_response(handlers.handle_remove(_base(), body["pool_id"], int(body["index"])))


@routes.post("/grid_pool/active")
async def _active(request):
    body = await request.json()
    return web.json_response(handlers.handle_active(_base(), body["pool_id"], int(body["index"])))


@routes.post("/grid_pool/label")
async def _label(request):
    body = await request.json()
    return web.json_response(handlers.handle_label(_base(), body["pool_id"], int(body["index"]), body["label"]))


@routes.get("/grid_pool/list")
async def _list(request):
    pool_id = request.query.get("pool_id", "default")
    return web.json_response(handlers.handle_list(_base(), pool_id))
```

> Update repo-root `__init__.py` to `from .gates import routes` (already there from Task 1).
> `handle_set_mask` route is added in Phase 2 (Task 11/12).

**Step 4: Run → PASS** (`tests/test_routes_logic.py`). The aiohttp module import requires comfy, so do NOT import `gates.routes` in tests — only `gates.handlers`.

**Step 5: Commit** `feat: pool handlers + aiohttp routes`

---

### Task 11: Live smoke test — node loads + grid renders + ingest/select/delete/label

**Files:** Modify `web/grid_image_pool.js` (full Phase-1 UI)

**Step 1: Symlink into ComfyUI**

```bash
ln -sfn /media/p5/ComfyUI-Datasete-Gates /media/p5/Comfyui/custom_nodes/ComfyUI-Datasete-Gates
```

**Step 2: Implement the grid widget JS**

Write `web/grid_image_pool.js` with this structure (complete code):
- `app.registerExtension({ name, beforeRegisterNodeDef })` — for `GridImagePool` only.
- In `nodeCreated`: ensure a `pool_id` exists; if the hidden widget is empty, generate `crypto.randomUUID()` and store it on a hidden widget so it serializes into the workflow.
- `addDOMWidget("grid", "div", el, {})` — a scrollable flex-wrap container.
- `refresh()` → `api.fetchApi('/grid_pool/list?pool_id=' + id)` → render thumbnails. Each thumb `<img src="/view?filename=...&type=input&subfolder=grid_pool/<id>">`, active border, a `<input>` label, a ✕ delete button, a 🖌 mask button (wired in Phase 2).
- **Paste:** on `paste` event when node selected → read clipboard image → `FormData` → POST `/grid_pool/add` → refresh.
- **Drop:** `el.ondrop` → for each image file → POST `/grid_pool/add` → refresh.
- **Upload:** a button → hidden `<input type=file multiple accept=image/*>` → POST each → refresh.
- **Select:** click thumb → POST `/grid_pool/active` `{pool_id,index}` → refresh; also set the node dirty so IS_CHANGED re-fires.
- **Label edit:** `change` on label input → POST `/grid_pool/label`.
- **Delete:** ✕ → POST `/grid_pool/remove` → refresh.

(Provide the full JS in implementation; keep DOM minimal and dependency-free.)

**Step 3: Restart ComfyUI, manual verification checklist**

- [ ] Node "Image Pool (Grid)" appears under "Datasete Gates".
- [ ] Paste an image (Ctrl+V) → thumbnail appears.
- [ ] Drag 2 files onto node → both appear.
- [ ] Click a thumb → active border moves.
- [ ] Edit a label → reload workflow → label persists.
- [ ] Delete a thumb → it disappears + file removed from `input/grid_pool/<id>/`.
- [ ] Connect `IMAGE`/`MASK` to a PreviewImage / preview → run → selected image shows, mask all black.
- [ ] Set `index` widget to `0` → forces first regardless of active.
- [ ] Restart ComfyUI, reload workflow → pool still there.

**Step 4: Fix any issues found, re-verify.**

**Step 5: Commit** `feat: in-node grid UI — ingest/select/delete/label + Phase 1 complete`

---

# PHASE 2 — MaskEditor integration + per-slot mask persistence

### Task 12: `pool.py` — `set_mask` + handler + route

**Files:** Modify `gates/pool.py`, `gates/handlers.py`, `gates/routes.py`; Modify `tests/test_pool.py`, `tests/test_routes_logic.py`

**Step 1: Failing test**

```python
def test_set_mask_writes_sidecar(tmp_path):
    pool.add_image(str(tmp_path), "p1", b"a", ts=1)
    m = pool.set_mask(str(tmp_path), "p1", 0, b"MASKBYTES")
    assert m["slots"][0]["mask"] == "img_0001.mask.png"
    assert (tmp_path / "p1" / "img_0001.mask.png").read_bytes() == b"MASKBYTES"

def test_set_mask_out_of_range_noop(tmp_path):
    m = pool.set_mask(str(tmp_path), "p1", 0, b"x")
    assert m["slots"] == []
```

**Step 2: Run → FAIL.**

**Step 3: Implement (append to `pool.py`)**

```python
def set_mask(base_dir, pool_id, index, mask_bytes):
    m = read_manifest(base_dir, pool_id)
    if not (0 <= index < len(m["slots"])):
        return m
    img_name = m["slots"][index]["image"]
    mask_name = img_name.replace(".png", ".mask.png")
    with open(pool_dir(base_dir, pool_id) / mask_name, "wb") as f:
        f.write(mask_bytes)
    m["slots"][index]["mask"] = mask_name
    write_manifest(base_dir, pool_id, m)
    return m
```

Add `/grid_pool/set_mask` route (multipart: `pool_id`, `index`, `mask` file) calling `handlers.handle_set_mask`.

**Step 4: Run → PASS.**  **Step 5: Commit** `feat: pool set_mask + route`

---

### Task 13: MaskEditor round-trip in JS (clipspace integration)

**Files:** Modify `web/grid_image_pool.js`

**Background (verified against installed frontend):** the editor is opened via the clipspace mechanism. The flow per the legacy `maskeditor.js`:
1. Build a clipspace payload: `ComfyApp.clipspace = { imgs:[Image], images:[{filename,subfolder,type}], selectedIndex:0, ... }`.
2. Set `ComfyApp.clipspace_return_node = node`.
3. Call the editor open API. In the installed frontend this is exposed (`openMaskEditor`). Confirm the exact accessor at implement time:
   `grep -rho "openMaskEditor[^,;]*" <frontend static>` and check `app.extensionManager`/`ComfyApp` for the callable.
4. The editor saves the painted mask to `input/clipspace/...` via `/upload/mask` and calls `node.pasteFromClipspace(clipspace)` on close.

**Implementation:**
- Add `🖌` button per thumbnail → `openMaskEditorForSlot(node, index)`:
  - fetch the slot image as an `Image` from `/view?...`,
  - set up `ComfyApp.clipspace` + `clipspace_return_node = node`,
  - open the editor.
- Implement `node.pasteFromClipspace = async (clipspace) => {...}`:
  - read the saved masked image (`clipspace.imgs[selectedIndex].src`) with `channel=a` to get the alpha,
  - draw alpha to a canvas, export grayscale PNG blob (white = masked),
  - POST to `/grid_pool/set_mask` (multipart) with `pool_id`, `index` (the slot being edited), `mask`,
  - `refresh()` and mark node dirty.
- Track "which slot is being edited" on the node (`node._editingSlot = index`) so `pasteFromClipspace` knows the target.

**Manual verification checklist:**
- [ ] Click 🖌 on a slot → MaskEditor opens with that image.
- [ ] Paint, save → returns to graph; thumbnail shows a "has-mask" dot.
- [ ] `input/grid_pool/<id>/img_XXXX.mask.png` exists.
- [ ] Run graph → MASK output matches the painted region (white = painted).
- [ ] Switch active to another image and back → mask still there (no redraw).
- [ ] Edit the mask again → MASK output updates on next run (IS_CHANGED via mtime).
- [ ] Verify mask orientation/scale matches the image (no flip / off-by-resize).

**Commit** `feat: MaskEditor round-trip — per-slot mask persistence (Phase 2 complete)`

> **Mask polarity check:** confirm whether the alpha from the editor needs inverting so that "painted area" == 1.0 in the MASK output. Adjust the canvas export accordingly and note the decision in code comments + README.

---

# PHASE 3 — Polish (optional, do as needed)

### Task 14: Right-click "Detach pool (new id)"
Add a node context-menu entry that assigns a fresh `crypto.randomUUID()` to `pool_id`, clears the displayed grid, and refreshes — so a cloned node can get its own pool. Manual verify: copy node → both share pool → detach one → independent.
**Commit** `feat: detach-pool context menu`

### Task 15: Drag-to-reorder thumbnails
HTML5 drag-and-drop within the grid → POST a new order to a `/grid_pool/reorder` route that reorders `manifest.slots` (and fixes `active`). Add `pool.reorder(base, pool_id, order)` with a unit test first.
**Commit** `feat: drag-reorder slots`

### Task 16: Badges + empty-state polish
Slot index badge, has-mask dot styling, count display, friendly empty-pool message. Manual verify.
**Commit** `feat: grid badges + empty state`

### Task 17: README
Write `README.md`: what the node does, install (symlink/clone into `custom_nodes`), the IO table, mask polarity note, and the managed-pool-folder layout.
**Commit** `docs: README for Image Pool (Grid)`

---

## Definition of done (Phase 1+2)

- `$PY -m pytest tests/ -v` → all green.
- Manual checklists in Tasks 11 and 13 pass.
- Pool + masks + labels survive a ComfyUI restart.
- No rewiring needed to switch images; masks are never redrawn when switching.
