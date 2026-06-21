# Folder Image Loader — Design

Date: 2026-06-21
Status: Approved (brainstorming complete, ready for implementation plan)

## 1. Purpose

A dataset-oriented image loader node: point it at a folder, pick an index (fixed or
auto-advancing), and it outputs the image, its sidecar caption text, an alpha mask, the
file stem, and the resolved index. Designed for sequential one-image-per-run dataset
processing (inpaint/sort pipelines) where you want to walk a folder and stop cleanly
when exhausted.

Second node in the `ComfyUI-Datasete-Gates` package (alongside `Image Pool (Grid)`).

## 2. IO

| dir | name | type | notes |
|---|---|---|---|
| widget | `folder` | STRING | any absolute path |
| widget | `index` | INT (`control_after_generate`) | fixed / increment / decrement after each run; min `0` |
| widget | `depth` | INT, default `0` | `0` = top-level only; `N` = recurse up to N levels; `-1` = unlimited |
| out | `image` | IMAGE | `[1,H,W,3]` float 0..1 |
| out | `text` | STRING | sidecar `<stem>.txt` content (UTF-8, trailing newline stripped); `""` if absent |
| out | `mask` | MASK | from alpha channel (`1 - alpha`, the LoadImage convention); zeros sized to image if no alpha |
| out | `filename` | STRING | the file **stem** (no extension, no dir) |
| out | `index` | INT | the resolved index actually loaded |

## 3. Behavior

- **Scan**: walk `folder` depth-limited, keep files whose suffix is in
  `{.png, .jpg, .jpeg, .webp, .bmp, .tif, .tiff}`, **natural-sort by path relative to
  the folder** (so `img2.png` < `img10.png`) → a deterministic list.
- **Index control**: native `control_after_generate` gives fixed/increment/decrement.
  Increment past the last image walks off the end → **error** (the intended
  end-of-batch stop signal). `min=0` means decrement floors at the first image.
- **Out of range / empty / bad path** → raise a clear error:
  - `index N out of range: M images in <folder>`
  - `No images found in <folder>` / `Not a folder: <folder>`
- **Sidecar**: `<same-stem>.txt` next to the image; UTF-8, `rstrip("\n")`; missing → `""`.
- **IS_CHANGED**: hash `(folder, depth, resolved index, image mtime, sidecar mtime)` so
  fixed-mode file edits re-trigger. (Increment mode re-runs anyway — the widget value
  changes each run.)

## 4. Code shape

Kept **self-contained** so it can be built independently of the in-flight pool work.

- `gates/scan.py` — pure, stdlib-only, unit-testable: `natural_key`, `list_images`,
  `resolve_index`, `sidecar_path`, `read_sidecar`, `stem`.
- `gates/loader.py` — the `FolderImageLoader` node (torch/PIL); contains its own
  `load_image_and_mask(path)` (RGB + alpha→mask). ~10 lines overlap with the pool's
  `imaging.py`; deliberate, to decouple the two workstreams. Optional post-merge dedupe.
- **Shared file**: root `__init__.py` — the only place both nodes meet. The plan
  *extends* the existing `if __package__:` block to also import + merge the loader's
  mappings (does not overwrite).

## 5. Edge cases

- Non-existent / non-dir path → `NotADirectoryError` with the path.
- Folder with no matching images → `FileNotFoundError`.
- Image without alpha → zero mask sized to the image (not 64×64).
- Symlinks/hidden files: included if extension matches (no special handling v1).
- Huge folders: `os.walk` + one sort per run is fine for thousands of files.

## 6. Testing

- pytest (`tests/test_scan.py`): natural sort, depth limiting (0 / N / -1), extension
  filter, `resolve_index` raises on OOB and empty, sidecar present/missing, stem.
- pytest (`tests/test_loader.py`): `run()` against a tmp folder of real PNGs (with and
  without alpha + sidecars) — output tensor shapes, text, mask polarity, stem, resolved
  index; OOB raises; `IS_CHANGED` differs across index and sidecar mtime.
- Manual: drop the node in ComfyUI, point at a real dataset folder, increment through it,
  confirm caption text + mask, and confirm it errors at the end.
