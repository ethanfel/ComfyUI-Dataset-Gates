# Bucket Resize (Klein 9B) — Design

Date: 2026-06-21
Status: Approved (brainstorming complete, ready for implementation plan)
Spec: `/media/unraid/davinci/comics-lora/dataset/KLEIN_BUCKET_SIZES.md`

## 1. Purpose

Automatically resize any image so it lands **exactly on its training bucket** — W×H
multiples of 64 within a ~1.64 MP area budget (FLUX.2 [klein] 9B, ai-toolkit
`resolution: [1280]`). Resize-to-cover + center-crop, with slight Lanczos upscale only when
needed. Outputs the bucketed image (+ identically transformed mask) and the chosen size.

Sixth node in the `ComfyUI-Datasete-Gates` suite. **No custom frontend** — standard widgets.

## 2. Bucket selection (generated grid)

Budget = `resolution²` (default 1280 → 1,638,400 px). For an image of aspect `a = iw/ih`:

- Enumerate widths `w` in multiples of `divisible` (default 64). For each, take the **largest**
  on-grid height within budget: `h = floor(budget / w / divisible) * divisible` (skip if
  `h < divisible`). This is the max-area frontier per width.
- Pick the candidate minimizing **log-aspect distance** `|ln(w/h) − ln(a)|`; tie-break by
  larger area. This reproduces the doc's 13 rows for normal aspects (square→1280×1280,
  0.5→896×1792, 2.0→1792×896, …) and extends to extreme aspects (≈0.09–2.67).

## 3. Fit: cover + center-crop

For chosen bucket `(W, H)` and image `(iw, ih)`:
- `scale = max(W/iw, H/ih)` (cover). `new = (round(iw*scale), round(ih*scale))`.
- Resize with **Lanczos** (good for up- and down-scale), then **center-crop** to exactly
  `W×H`: `left=(new_w−W)//2`, `top=(new_h−H)//2`.
- If `scale > max_upscale` (default 1.5), still fit but **log a warning** (the doc warns big
  upscales soften texture).

The optional **mask** gets the identical scale+crop (so it stays aligned); absent → zeros
sized to the bucket.

## 4. IO

| dir | name | type | notes |
|-----|------|------|-------|
| in | `image` | IMAGE | required |
| in (opt) | `mask` | MASK | transformed identically; zeros if absent |
| widget | `resolution` | INT (default 1280, min 64) | area budget = `resolution²` |
| widget | `divisible` | INT (default 64, min 8) | grid step |
| widget | `max_upscale` | FLOAT (default 1.5, min 1.0) | warn above this cover-scale |
| out | `image` | IMAGE | exactly bucket `W×H`, `[1,H,W,3]` |
| out | `mask` | MASK | `[1,H,W]` |
| out | `width` | INT | chosen bucket width |
| out | `height` | INT | chosen bucket height |
| out | `label` | STRING | `"WxH"` (e.g. `1280x1280`) |

## 5. Code shape

- `gates/buckets.py` *(new, pure stdlib + math)* — `pick_bucket(iw, ih, resolution, divisible)`
  → `(W, H)`; `cover_crop_params(iw, ih, W, H)` → `(new_w, new_h, left, top, scale)`.
  Fully unit-testable; **tested against the doc's table**.
- `gates/bucket_node.py` *(new, torch/PIL)* — tensor↔PIL resize/crop using `buckets`, the
  `BucketResize` node. `run()` is pure compute (no comfy, no blocking) → fully unit-testable.
- root `__init__.py` — additive merge of the node mapping.

## 6. Edge cases

- Batch `B>1`: bucket is chosen from the **first** image's aspect and applied to all (keeps a
  uniform output tensor); documented. (Dataset flow is typically one image per run.)
- Image already exactly on a bucket → `scale≈1`, no crop.
- Tiny/extreme aspect → handled by the generated grid (nearest of the frontier).
- `max_upscale` only warns; it never refuses (the node always returns an on-grid image).
- Mask resized with the same geometry (Lanczos), then clamped to [0,1].

## 7. Testing

- pytest `tests/test_buckets.py`: `pick_bucket` reproduces the doc rows for a set of aspects
  (1.0→1280×1280, 0.5→896×1792, 0.58→960×1664, 2.0→1792×896, …); all outputs are ÷divisible
  and ≤ budget; `cover_crop_params` math (cover scale, centered crop, exact target).
- pytest `tests/test_bucket_node.py`: feed known tensor sizes → output is exactly the bucket
  shape; mask aligned; `label`/`width`/`height` correct; no-mask → zeros.
- Manual (live): drop node after a loader, confirm odd-sized inputs come out on-grid and the
  label matches the table.
