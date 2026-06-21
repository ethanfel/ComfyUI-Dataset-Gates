# Bucket Resize (Klein 9B) Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** A `BucketResize` node that snaps any image onto its ai-toolkit training bucket (W×H ÷64, ≤ ~1.64 MP) via cover-scale + center-crop (Lanczos), transforms an optional mask identically, and outputs the bucketed image + chosen `width`/`height`/`label`.

**Architecture:** A pure stdlib+math `gates/buckets.py` selects the bucket and computes the cover-crop geometry — fully unit-testable against the spec's table. `gates/bucket_node.py` (torch/PIL) does the actual tensor resize/crop; its `run()` is pure compute (no comfy, no blocking) so it unit-tests end-to-end. No custom frontend.

**Spec:** `/media/unraid/davinci/comics-lora/dataset/KLEIN_BUCKET_SIZES.md`

**Tech Stack:** Python 3.12, torch 2.8, Pillow, numpy; pytest 9.

---

## Conventions (read once)

- **Test python:** `/media/p5/miniforge3/bin/python` (`PY=...`).
- **Run tests:** `cd /media/p5/ComfyUI-Datasete-Gates && $PY -m pytest tests/test_buckets.py tests/test_bucket_node.py -v`
- `gates/buckets.py` is pure (stdlib + `math`); no torch/comfy.
- IMAGE tensors are `[B,H,W,3]` float 0..1; MASK is `[B,H,W]`.
- `__init__.py` edit is **additive** — re-Read first, extend the mappings.
- Commit style: Conventional Commits + repo Co-Authored-By; stage only this node's paths.

---

### Task 1: `buckets.py` — `pick_bucket` (reproduce the spec table)

**Files:** Create `gates/buckets.py`; Test `tests/test_buckets.py`

**Step 1: Failing test**

```python
# tests/test_buckets.py
from gates import buckets

# (iw, ih) -> expected (W, H) from KLEIN_BUCKET_SIZES.md, budget 1280, ÷64
CASES = [
    (1000, 1000, 1280, 1280),   # square
    (1000, 2000, 896, 1792),    # a=0.50 portrait
    (1000, 1730, 960, 1664),    # a≈0.58
    (1000, 1100, 1216, 1344),   # a≈0.90 -> portrait-leaning
    (2000, 1000, 1792, 896),    # a=2.00 landscape
    (1500, 1000, 1536, 1024),   # a=1.50
]

def test_pick_bucket_matches_table():
    for iw, ih, W, H in CASES:
        assert buckets.pick_bucket(iw, ih, 1280, 64) == (W, H)

def test_buckets_are_on_grid_and_within_budget():
    for iw, ih, *_ in CASES:
        W, H = buckets.pick_bucket(iw, ih, 1280, 64)
        assert W % 64 == 0 and H % 64 == 0
        assert W * H <= 1280 * 1280

def test_square_is_exactly_1280():
    assert buckets.pick_bucket(512, 512, 1280, 64) == (1280, 1280)
```

**Step 2: Run → FAIL.**

**Step 3: Implement**

```python
# gates/buckets.py
"""Pure bucket math for KLEIN_BUCKET_SIZES.md. Stdlib only."""
import math


def pick_bucket(iw, ih, resolution=1280, divisible=64):
    """Choose the on-grid bucket (W,H), area <= resolution^2, nearest to the
    image aspect (log distance; tie-break larger area)."""
    budget = resolution * resolution
    target = iw / ih
    best = None
    w = divisible
    w_max = budget // divisible
    while w <= w_max:
        h = (budget // w // divisible) * divisible      # largest on-grid h within budget
        if h >= divisible:
            err = abs(math.log(w / h) - math.log(target))
            cand = (err, -(w * h), w, h)                 # min err, then max area
            if best is None or cand < best:
                best = cand
        w += divisible
    return best[2], best[3]


def cover_crop_params(iw, ih, W, H):
    """Cover-scale + centered crop to land (iw,ih) exactly on (W,H)."""
    scale = max(W / iw, H / ih)
    new_w = max(W, round(iw * scale))
    new_h = max(H, round(ih * scale))
    left = (new_w - W) // 2
    top = (new_h - H) // 2
    return new_w, new_h, left, top, scale
```

**Step 4: Run → PASS.**  **Step 5: Commit** `feat: bucket selection matching Klein 9B table`

---

### Task 2: `buckets.py` — `cover_crop_params`

**Files:** Modify `tests/test_buckets.py`

**Step 1: Failing test**

```python
def test_cover_crop_exact_aspect_no_crop():
    # a=2.0 image onto 1792x896 bucket -> scale 0.896, no crop
    new_w, new_h, left, top, scale = buckets.cover_crop_params(2000, 1000, 1792, 896)
    assert (new_w, new_h) == (1792, 896)
    assert (left, top) == (0, 0)
    assert round(scale, 3) == 0.896

def test_cover_crop_square_into_landscape_crops_height():
    new_w, new_h, left, top, scale = buckets.cover_crop_params(1000, 1000, 1792, 896)
    assert new_w == 1792 and new_h >= 896
    assert left == 0 and top == (new_h - 896) // 2     # centered vertical crop
    assert scale > 1.0                                  # upscaled to cover width

def test_cover_crop_upscale_square():
    *_, scale = buckets.cover_crop_params(1000, 1000, 1280, 1280)
    assert round(scale, 2) == 1.28
```

**Step 2: Run → PASS** (implemented in Task 1). If it fails, fix `cover_crop_params`.

**Step 3:** (no new code — locks the geometry with tests.)

**Step 4: Commit** `test: bucket cover_crop_params geometry`

---

### Task 3: `bucket_node.py` — fit helpers + `BucketResize` node

**Files:** Create `gates/bucket_node.py`; Test `tests/test_bucket_node.py`

**Step 1: Failing test**

```python
# tests/test_bucket_node.py
import torch
from gates import bucket_node as bn

def test_square_to_1280():
    out, m, w, h, label = bn.BucketResize().run(image=torch.rand((1, 1000, 1000, 3)))
    assert (w, h) == (1280, 1280)
    assert out.shape == (1, 1280, 1280, 3)
    assert m.shape == (1, 1280, 1280) and float(m.max()) == 0.0   # no mask -> zeros
    assert label == "1280x1280"

def test_landscape_bucket_shapes():
    # tensor [B,H,W,3] with H=1000,W=2000 -> aspect 2.0 -> 1792x896
    out, m, w, h, label = bn.BucketResize().run(image=torch.rand((1, 1000, 2000, 3)))
    assert (w, h) == (1792, 896)
    assert out.shape == (1, 896, 1792, 3)
    assert label == "1792x896"

def test_mask_resized_and_aligned():
    out, m, w, h, _ = bn.BucketResize().run(
        image=torch.rand((1, 1000, 1000, 3)), mask=torch.ones((1, 1000, 1000)))
    assert m.shape == (1, 1280, 1280) and float(m.min()) > 0.9

def test_outputs_are_on_grid():
    out, m, w, h, _ = bn.BucketResize().run(
        image=torch.rand((1, 777, 1333, 3)), resolution=1280, divisible=64)
    assert w % 64 == 0 and h % 64 == 0
    assert out.shape[1] == h and out.shape[2] == w
```

**Step 2: Run → FAIL.**

**Step 3: Implement**

```python
# gates/bucket_node.py
import numpy as np
import torch
from PIL import Image

from . import buckets

NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}


def _resize_crop_pil(pil, new_w, new_h, left, top, W, H):
    pil = pil.resize((new_w, new_h), Image.LANCZOS)
    return pil.crop((left, top, left + W, top + H))


def fit_image(image, W, H):
    """image [B,H,W,3] -> [B,H,W,3] at (W,H) using the first image's geometry."""
    b, ih, iw = image.shape[0], image.shape[1], image.shape[2]
    new_w, new_h, left, top, scale = buckets.cover_crop_params(iw, ih, W, H)
    out = []
    for i in range(b):
        arr = (image[i].cpu().numpy() * 255.0).clip(0, 255).astype("uint8")
        pil = _resize_crop_pil(Image.fromarray(arr), new_w, new_h, left, top, W, H)
        out.append(torch.from_numpy(np.array(pil, dtype=np.float32) / 255.0))
    return torch.stack(out, 0), scale


def fit_mask(mask, W, H):
    b, ih, iw = mask.shape[0], mask.shape[1], mask.shape[2]
    new_w, new_h, left, top, _ = buckets.cover_crop_params(iw, ih, W, H)
    out = []
    for i in range(b):
        arr = (mask[i].cpu().numpy() * 255.0).clip(0, 255).astype("uint8")
        pil = _resize_crop_pil(Image.fromarray(arr, mode="L"), new_w, new_h, left, top, W, H)
        out.append(torch.from_numpy(np.array(pil, dtype=np.float32) / 255.0))
    return torch.stack(out, 0)


class BucketResize:
    CATEGORY = "Datasete Gates"
    FUNCTION = "run"
    RETURN_TYPES = ("IMAGE", "MASK", "INT", "INT", "STRING")
    RETURN_NAMES = ("image", "mask", "width", "height", "label")

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image": ("IMAGE",),
                "resolution": ("INT", {"default": 1280, "min": 64, "max": 8192}),
                "divisible": ("INT", {"default": 64, "min": 8, "max": 256}),
                "max_upscale": ("FLOAT", {"default": 1.5, "min": 1.0, "max": 8.0, "step": 0.1}),
            },
            "optional": {"mask": ("MASK",)},
        }

    def run(self, image, resolution=1280, divisible=64, max_upscale=1.5, mask=None):
        ih, iw = int(image.shape[1]), int(image.shape[2])
        W, H = buckets.pick_bucket(iw, ih, resolution, divisible)
        out_img, scale = fit_image(image, W, H)
        if scale > max_upscale:
            print(f"[BucketResize] cover scale {scale:.2f}x exceeds max_upscale "
                  f"{max_upscale} for {iw}x{ih} -> {W}x{H}")
        out_mask = fit_mask(mask, W, H) if mask is not None \
            else torch.zeros((out_img.shape[0], H, W), dtype=torch.float32)
        return (out_img, out_mask, W, H, f"{W}x{H}")


NODE_CLASS_MAPPINGS = {"BucketResize": BucketResize}
NODE_DISPLAY_NAME_MAPPINGS = {"BucketResize": "Bucket Resize (Klein 9B)"}
```

**Step 4: Run → PASS.**  **Step 5: Commit** `feat: BucketResize node (cover-crop onto Klein buckets)`

---

### Task 4: Register in `__init__.py` (MERGE)

**Files:** Modify `__init__.py`

**Step 1:** Re-Read `__init__.py`, then add inside the `if __package__:` block:

```python
    from .gates.bucket_node import NODE_CLASS_MAPPINGS as _BUCKET_NODES, \
        NODE_DISPLAY_NAME_MAPPINGS as _BUCKET_NAMES
```
and merge:
```python
    NODE_CLASS_MAPPINGS = {**NODE_CLASS_MAPPINGS, **_BUCKET_NODES}
    NODE_DISPLAY_NAME_MAPPINGS = {**NODE_DISPLAY_NAME_MAPPINGS, **_BUCKET_NAMES}
```
(No routes/web — standard widgets only.)

**Step 2:** `$PY -c "import gates.bucket_node; print(gates.bucket_node.NODE_CLASS_MAPPINGS)"`.

**Step 3:** Full suite green: `$PY -m pytest tests/ -v`.

**Step 4: Commit** `feat: register BucketResize`

---

### Task 5: Live smoke test in ComfyUI

Restart ComfyUI. Build: `Folder Image Loader → Bucket Resize → PreviewImage` (+ a SaveImage
using `label` for the filename). Verify:
- [ ] "Bucket Resize (Klein 9B)" appears under "Datasete Gates".
- [ ] A square-ish image → `1280x1280`; a 2:1 image → `1792x896`; a tall image → a portrait
      bucket — all ÷64, output exactly bucket-sized.
- [ ] An odd size (e.g. 1333×777) lands on-grid with a clean center-crop.
- [ ] Feeding a mask (e.g. from the loader's alpha) → mask comes out aligned at bucket size.
- [ ] `width`/`height`/`label` outputs match the preview.
- [ ] A small input triggers the console `max_upscale` warning but still outputs on-grid.

**Commit** (if fixes) `fix: bucket resize live-test adjustments`

---

## Definition of done

- `$PY -m pytest tests/test_buckets.py tests/test_bucket_node.py -v` green; full `tests/` green.
- `pick_bucket` reproduces the spec table; outputs are always ÷divisible and ≤ budget.
- Manual checklist passes: on-grid output, aligned mask, correct label, upscale warning.
