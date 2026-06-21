# Folder Image Loader Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a ComfyUI custom node `Folder Image Loader` that loads an image by index from a folder (fixed or auto-advancing), plus its sidecar `.txt` caption, alpha mask, file stem, and resolved index.

**Architecture:** A pure stdlib scan layer (`gates/scan.py`, fully unit-testable) lists/sorts images with depth control, resolves the index (raising when out of range), and reads sidecar text. The node (`gates/loader.py`) loads the chosen file into ComfyUI tensors (RGB + alpha→mask) and wires outputs. The index uses ComfyUI's native `control_after_generate` for fixed/increment/decrement. Self-contained except for the shared root `__init__.py` mapping merge.

**Tech Stack:** Python 3.12, torch 2.8, Pillow, numpy, pytest 9; no JS (uses native widgets only).

---

## Conventions (read once)

- **Test python:** `/media/p5/miniforge3/bin/python` (`PY=/media/p5/miniforge3/bin/python`).
- **Run tests:** `cd /media/p5/ComfyUI-Datasete-Gates && $PY -m pytest tests/test_scan.py tests/test_loader.py -v`
- **Concurrency:** the `Image Pool (Grid)` node is being built in another session in this
  same repo. This loader is **all new files** except root `__init__.py`. Do not modify the
  pool's files. When committing, stage only this node's paths
  (`gates/scan.py gates/loader.py tests/test_scan.py tests/test_loader.py` and, in Task 6,
  `__init__.py`). Before editing `__init__.py`, re-Read it (the other session may have
  changed it) and *extend*, don't overwrite.
- `gates/scan.py` MUST stay stdlib-only (no torch) so it tests without ComfyUI.
- Image extensions: `{.png, .jpg, .jpeg, .webp, .bmp, .tif, .tiff}`.
- Mask convention: `1 - alpha`; zeros sized to the image when no alpha.
- Commit style: Conventional Commits + the repo's Co-Authored-By trailer.

---

### Task 1: `scan.py` — `natural_key` + `list_images` (depth-limited, sorted)

**Files:**
- Create: `gates/scan.py`
- Test: `tests/test_scan.py`

**Step 1: Write the failing test**

```python
# tests/test_scan.py
from gates import scan

def _touch(p, data=b"x"):
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_bytes(data)

def test_natural_sort_orders_numerically():
    items = ["img10.png", "img2.png", "img1.png"]
    assert sorted(items, key=scan.natural_key) == ["img1.png", "img2.png", "img10.png"]

def test_list_images_top_level_only_default(tmp_path):
    _touch(tmp_path / "a.png"); _touch(tmp_path / "b.jpg"); _touch(tmp_path / "note.txt")
    _touch(tmp_path / "sub" / "c.png")
    got = [p.split("/")[-1] for p in scan.list_images(str(tmp_path))]
    assert got == ["a.png", "b.jpg"]            # depth 0: no sub/, no .txt

def test_list_images_depth_one(tmp_path):
    _touch(tmp_path / "a.png")
    _touch(tmp_path / "sub" / "c.png")
    _touch(tmp_path / "sub" / "deep" / "d.png")
    got = [p.split("/")[-1] for p in scan.list_images(str(tmp_path), depth=1)]
    assert got == ["a.png", "c.png"]            # depth 1: include sub/, not sub/deep/

def test_list_images_unlimited_depth(tmp_path):
    _touch(tmp_path / "a.png"); _touch(tmp_path / "sub" / "deep" / "d.png")
    got = scan.list_images(str(tmp_path), depth=-1)
    assert len(got) == 2

def test_list_images_natural_sort_by_relpath(tmp_path):
    for n in ["img1.png", "img2.png", "img10.png"]:
        _touch(tmp_path / n)
    got = [p.split("/")[-1] for p in scan.list_images(str(tmp_path))]
    assert got == ["img1.png", "img2.png", "img10.png"]

def test_list_images_bad_path_raises(tmp_path):
    import pytest
    with pytest.raises(NotADirectoryError):
        scan.list_images(str(tmp_path / "nope"))
```

**Step 2: Run → FAIL.** `$PY -m pytest tests/test_scan.py -v`

**Step 3: Implement**

```python
# gates/scan.py
"""Pure folder-scan layer for Folder Image Loader. Stdlib only — no torch."""
import os
import re
from pathlib import Path

IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tif", ".tiff"}


def natural_key(s):
    return [int(t) if t.isdigit() else t.lower() for t in re.split(r"(\d+)", s)]


def list_images(folder, depth=0):
    root = Path(folder)
    if not root.is_dir():
        raise NotADirectoryError(f"Not a folder: {folder}")
    root_depth = len(root.parts)
    results = []
    for dirpath, dirnames, filenames in os.walk(root):
        cur = Path(dirpath)
        rel_depth = len(cur.parts) - root_depth
        if depth >= 0 and rel_depth >= depth:
            dirnames[:] = []                    # don't descend past `depth`
        if depth >= 0 and rel_depth > depth:
            continue
        for name in filenames:
            if Path(name).suffix.lower() in IMAGE_EXTS:
                results.append(str(cur / name))
    results.sort(key=lambda p: natural_key(os.path.relpath(p, root)))
    return results
```

**Step 4: Run → PASS.**

**Step 5: Commit**

```bash
git add gates/scan.py tests/test_scan.py
git commit -m "feat: folder scan — depth-limited natural-sorted image listing"
```

---

### Task 2: `scan.py` — `resolve_index` (raise on out-of-range/empty)

**Files:** Modify `gates/scan.py`, `tests/test_scan.py`

**Step 1: Failing test**

```python
def test_resolve_index_ok():
    assert scan.resolve_index(5, 0) == 0
    assert scan.resolve_index(5, 4) == 4

def test_resolve_index_out_of_range_raises():
    import pytest
    with pytest.raises(IndexError):
        scan.resolve_index(5, 5)
    with pytest.raises(IndexError):
        scan.resolve_index(5, -1)

def test_resolve_index_empty_raises():
    import pytest
    with pytest.raises(FileNotFoundError):
        scan.resolve_index(0, 0)
```

**Step 2: Run → FAIL.**

**Step 3: Implement (append)**

```python
def resolve_index(count, index):
    if count == 0:
        raise FileNotFoundError("No images found in folder")
    if index < 0 or index >= count:
        raise IndexError(f"index {index} out of range: {count} images")
    return index
```

**Step 4: Run → PASS.**  **Step 5: Commit** `feat: scan.resolve_index with end-of-batch error`

---

### Task 3: `scan.py` — `stem`, `sidecar_path`, `read_sidecar`

**Files:** Modify `gates/scan.py`, `tests/test_scan.py`

**Step 1: Failing test**

```python
def test_stem():
    assert scan.stem("/a/b/shot01.png") == "shot01"

def test_sidecar_path():
    assert scan.sidecar_path("/a/b/shot01.png") == "/a/b/shot01.txt"

def test_read_sidecar_present(tmp_path):
    (tmp_path / "x.png").write_bytes(b"i")
    (tmp_path / "x.txt").write_text("a caption\n", encoding="utf-8")
    assert scan.read_sidecar(str(tmp_path / "x.png")) == "a caption"

def test_read_sidecar_missing_returns_empty(tmp_path):
    (tmp_path / "x.png").write_bytes(b"i")
    assert scan.read_sidecar(str(tmp_path / "x.png")) == ""
```

**Step 2: Run → FAIL.**

**Step 3: Implement (append)**

```python
def stem(image_path):
    return os.path.splitext(os.path.basename(image_path))[0]


def sidecar_path(image_path):
    return os.path.splitext(image_path)[0] + ".txt"


def read_sidecar(image_path):
    p = sidecar_path(image_path)
    if not os.path.isfile(p):
        return ""
    with open(p, "r", encoding="utf-8") as f:
        return f.read().rstrip("\n")
```

**Step 4: Run → PASS.**  **Step 5: Commit** `feat: scan stem + sidecar text reader`

---

### Task 4: `loader.py` — the `FolderImageLoader` node

**Files:**
- Create: `gates/loader.py`
- Test: `tests/test_loader.py`

**Step 1: Failing test**

```python
# tests/test_loader.py
import io, os, torch
from PIL import Image
from gates import loader

def _save(path, color=(255, 0, 0), size=(4, 6), mode="RGB"):  # size=(w,h)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    Image.new(mode, size, color).save(path)

def test_run_loads_image_text_stem_index(tmp_path):
    _save(str(tmp_path / "img1.png"), (255, 0, 0))
    _save(str(tmp_path / "img2.png"), (0, 255, 0))
    (tmp_path / "img2.txt").write_text("green frame\n", encoding="utf-8")
    n = loader.FolderImageLoader()
    image, text, mask, filename, index = n.run(folder=str(tmp_path), index=1, depth=0)
    assert image.shape == (1, 6, 4, 3)
    assert float(image[0, 0, 0, 1]) > 0.99          # green
    assert text == "green frame"
    assert filename == "img2"
    assert index == 1
    assert mask.shape == (1, 6, 4) and float(mask.max()) == 0.0  # no alpha -> zeros

def test_run_alpha_becomes_mask(tmp_path):
    # RGBA image, fully opaque alpha=255 -> mask = 1-1 = 0
    _save(str(tmp_path / "a.png"), (255, 255, 255, 255), mode="RGBA")
    n = loader.FolderImageLoader()
    _, _, mask, _, _ = n.run(folder=str(tmp_path), index=0, depth=0)
    assert float(mask.max()) == 0.0
    # transparent alpha=0 -> mask = 1-0 = 1
    _save(str(tmp_path / "b.png"), (255, 255, 255, 0), mode="RGBA")
    _, _, mask2, _, _ = n.run(folder=str(tmp_path), index=1, depth=0)
    assert float(mask2.min()) > 0.99

def test_run_out_of_range_raises(tmp_path):
    import pytest
    _save(str(tmp_path / "only.png"))
    n = loader.FolderImageLoader()
    with pytest.raises(IndexError):
        n.run(folder=str(tmp_path), index=9, depth=0)

def test_is_changed_differs_by_index_and_sidecar(tmp_path):
    _save(str(tmp_path / "img1.png")); _save(str(tmp_path / "img2.png"))
    h0 = loader.FolderImageLoader.IS_CHANGED(folder=str(tmp_path), index=0, depth=0)
    h1 = loader.FolderImageLoader.IS_CHANGED(folder=str(tmp_path), index=1, depth=0)
    assert h0 != h1
```

**Step 2: Run → FAIL.**

**Step 3: Implement**

```python
# gates/loader.py
import hashlib
import os

import numpy as np
import torch
from PIL import Image, ImageOps

from . import scan

NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}


def load_image_and_mask(path):
    img = Image.open(path)
    img = ImageOps.exif_transpose(img)
    arr = np.array(img.convert("RGB"), dtype=np.float32) / 255.0
    image = torch.from_numpy(arr).unsqueeze(0)              # [1,H,W,3]
    h, w = arr.shape[0], arr.shape[1]
    if "A" in img.getbands():
        a = np.array(img.getchannel("A"), dtype=np.float32) / 255.0
        mask = (1.0 - torch.from_numpy(a)).unsqueeze(0)     # [1,H,W]
    else:
        mask = torch.zeros((1, h, w), dtype=torch.float32)
    return image, mask


class FolderImageLoader:
    CATEGORY = "Datasete Gates"
    FUNCTION = "run"
    RETURN_TYPES = ("IMAGE", "STRING", "MASK", "STRING", "INT")
    RETURN_NAMES = ("image", "text", "mask", "filename", "index")

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "folder": ("STRING", {"default": ""}),
                "index": ("INT", {"default": 0, "min": 0,
                                  "max": 0xffffffffffffffff,
                                  "control_after_generate": True}),
                "depth": ("INT", {"default": 0, "min": -1, "max": 64}),
            }
        }

    def run(self, folder, index, depth=0):
        files = scan.list_images(folder, depth)
        idx = scan.resolve_index(len(files), index)
        path = files[idx]
        image, mask = load_image_and_mask(path)
        return (image, scan.read_sidecar(path), mask, scan.stem(path), idx)

    @classmethod
    def IS_CHANGED(cls, folder, index, depth=0, **kwargs):
        try:
            files = scan.list_images(folder, depth)
            idx = scan.resolve_index(len(files), index)
            path = files[idx]
            sc = scan.sidecar_path(path)
            parts = [folder, str(depth), str(idx),
                     str(os.path.getmtime(path)),
                     str(os.path.getmtime(sc)) if os.path.isfile(sc) else "0"]
        except Exception as e:  # surface errors as a changed hash, not a crash here
            parts = [folder, str(depth), str(index), f"err:{e}"]
        return hashlib.sha256("|".join(parts).encode()).hexdigest()


NODE_CLASS_MAPPINGS = {"FolderImageLoader": FolderImageLoader}
NODE_DISPLAY_NAME_MAPPINGS = {"FolderImageLoader": "Folder Image Loader"}
```

**Step 4: Run → PASS.** `$PY -m pytest tests/test_loader.py -v`

**Step 5: Commit** `feat: FolderImageLoader node (image/text/mask/filename/index)`

---

### Task 5: Register in root `__init__.py` (MERGE — re-Read first)

**Files:** Modify `__init__.py`

**Step 1:** Re-Read the current `__init__.py` (the pool session may have changed it). It is
expected to look like:

```python
if __package__:
    from .gates.node import NODE_CLASS_MAPPINGS, NODE_DISPLAY_NAME_MAPPINGS
    from .gates import routes  # noqa: F401
else:
    NODE_CLASS_MAPPINGS = {}
    NODE_DISPLAY_NAME_MAPPINGS = {}
```

**Step 2:** Extend the `if __package__:` branch to merge the loader's mappings (do NOT
remove the pool imports):

```python
if __package__:
    from .gates.node import NODE_CLASS_MAPPINGS as _POOL_NODES, \
        NODE_DISPLAY_NAME_MAPPINGS as _POOL_NAMES
    from .gates.loader import NODE_CLASS_MAPPINGS as _LOADER_NODES, \
        NODE_DISPLAY_NAME_MAPPINGS as _LOADER_NAMES
    from .gates import routes  # noqa: F401  (registers aiohttp routes on import)

    NODE_CLASS_MAPPINGS = {**_POOL_NODES, **_LOADER_NODES}
    NODE_DISPLAY_NAME_MAPPINGS = {**_POOL_NAMES, **_LOADER_NAMES}
else:  # pragma: no cover - exercised only under pytest collection
    NODE_CLASS_MAPPINGS = {}
    NODE_DISPLAY_NAME_MAPPINGS = {}
```

> If the pool session changed the structure, adapt: the only requirement is that the
> final `NODE_CLASS_MAPPINGS`/`NODE_DISPLAY_NAME_MAPPINGS` include both nodes.

**Step 3:** Verify import (pure):
`cd /media/p5/ComfyUI-Datasete-Gates && $PY -c "import gates.loader; print(gates.loader.NODE_CLASS_MAPPINGS)"`
Expected: `{'FolderImageLoader': <class ...>}`

**Step 4:** Full suite green: `$PY -m pytest tests/ -v`

**Step 5: Commit** `feat: register FolderImageLoader in node mappings`

---

### Task 6: Live smoke test in ComfyUI

(The repo is already symlinked into `custom_nodes` by the pool work. If not:
`ln -sfn /media/p5/ComfyUI-Datasete-Gates /media/p5/Comfyui/custom_nodes/ComfyUI-Datasete-Gates`.)

Restart ComfyUI, then verify:
- [ ] "Folder Image Loader" appears under "Datasete Gates".
- [ ] Point `folder` at a real dataset folder, `index=0`, `depth=0` → first image loads.
- [ ] The `index` widget shows the fixed/increment/decrement control; set increment, run repeatedly → advances through files in natural order.
- [ ] An image with a matching `.txt` → `text` output carries the caption; without → empty.
- [ ] `filename` output is the stem (no extension).
- [ ] An RGBA image → `mask` reflects transparency; RGB image → zero mask.
- [ ] `depth=1` picks up one level of subfolders; `depth=-1` everything.
- [ ] Increment past the last image → run errors with `index ... out of range`.

**Commit** (if any fixes) `fix: folder loader live-test adjustments`

---

## Definition of done

- `$PY -m pytest tests/test_scan.py tests/test_loader.py -v` → green; full `tests/` green.
- Manual checklist passes.
- Both nodes coexist in the menu; `__init__.py` merge is clean (no pool regressions).
