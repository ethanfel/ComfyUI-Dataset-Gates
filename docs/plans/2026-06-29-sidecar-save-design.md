# Save Image + chainable sidecars (design)

**Goal:** A save-image node (like KJ's `SaveImageKJ`) that, instead of a single
caption, writes any number of **sidecar** text/JSON files alongside the image,
each sharing the image's base name so associations never break.

Decisions (from brainstorming):
- **One unified `Sidecar` node** (content + name + extension), not per-type nodes.
- **JSON is just a string** — content is a STRING written verbatim; the extension
  decides `.txt` vs `.json`.

## Nodes (backend-only — standard widgets/slots, no web JS)

### `Sidecar` — one link in the chain
- Inputs: `content` (STRING, forceInput) · `name` (STRING, default `""`) ·
  `extension` (STRING, default `.txt`) · `sidecar` (optional `SIDECAR` chain-in).
- Output: `sidecar` (`SIDECAR`) — a list; appends `{content, name, ext}` to the
  incoming chain and passes it on. Pure, no comfy imports.
- `SIDECAR` is a custom type so only sidecar/save ports interconnect.

### `Save Image (Sidecars)` — end of the chain
- Inputs: `images` (IMAGE) · `filename_prefix` (default `ComfyUI`) ·
  `output_folder` (default `output`; absolute or under the ComfyUI output dir) ·
  `sidecar` (optional `SIDECAR`). `OUTPUT_NODE`, returns the image preview.
- `folder_paths.get_save_image_path()` → `base = f"{filename}_{counter:05}_"`
  (mirrors `SaveImageKJ`). Saves `base.png`, then each sidecar as `base + name + ext`.

## Filename rule

`base` already ends in `_`, so it is the separator:

| name | ext | file |
|---|---|---|
| `""` | `.txt` | `ComfyUI_00001_.txt` (caption, shares the image base) |
| `""` | `.json` | `ComfyUI_00001_.json` |
| `variant_a` | `.txt` | `ComfyUI_00001_variant_a.txt` |

Image: `ComfyUI_00001_.png`. Batch > 1 writes each sidecar per image.

## Validation (all before any file is written → no partial output)

- **Duplicate → error:** two sidecars resolving to the same `name+ext`
  (two empty-name `.txt`, or two `variant_a.json`) raise a clear `ValueError`.
- **Extension allowlist:** `.txt .caption .json .yaml .yml .md .csv .tsv .xml .log
  .ini .toml`. `name`/`extension` sanitized to a basename; per-file `commonpath`
  path-traversal guard. (All copied from `SaveImageKJ`.)

## Code layout / testing

- `gates/sidecar.py` — pure logic: `ALLOWED_EXTENSIONS`, `normalize_ext`,
  `sanitize_name`, `append_spec`, `build_plan`. Unit-tested (chain build, filename
  resolution, duplicate raises, bad-ext raises) — no torch/comfy.
- `gates/sidecar_node.py` — the two node classes; torch/PIL/`folder_paths`
  imported lazily inside `save()`. `build_plan` runs before any I/O.
- `__init__.py` — additive registration.

## Rejected / deferred

- Per-type text/json nodes (unified node covers both).
- Structured JSON/dict input (string-JSON is enough).
