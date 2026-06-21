# Image Pool (Grid) — Design

Date: 2026-06-21
Status: Approved (brainstorming complete, ready for implementation plan)

## 1. Purpose & scope

An **input-side** ComfyUI node that holds a curated *pool* of images, each with its
own remembered mask and an editable label. The user picks an active image (or drives
it by index) and the node outputs that image + mask (+ index/count/label).

The node does **not** inpaint. It feeds downstream edit nodes (Klein / Flux Kontext).
It exists to remove two recurring annoyances in the dataset/inpaint workflow:

1. **Rewiring** — instead of swapping `LoadImage` nodes, keep one node holding many
   images and click the active one. Downstream wiring never changes.
2. **Re-masking** — each image remembers its own mask, so switching back to an image
   never means redrawing the mask.

Node name: **`Image Pool (Grid)`**.

### Non-goals (YAGNI for v1)

- Bulk folder load
- Batch-output mode (output the whole pool at once)
- Drag-to-reorder (deferred to phase 3)
- Cross-machine workflow portability (pool is disk-backed, local)

## 2. Node IO

| dir | name | type | notes |
|---|---|---|---|
| out | `IMAGE` | IMAGE | selected slot's image |
| out | `MASK` | MASK | selected slot's mask; all-zeros if none drawn (= nothing masked) |
| out | `index` | INT | the slot actually used |
| out | `count` | INT | total images in pool |
| out | `label` | STRING | selected slot's label ("" if unset) |
| widget | `index` | INT | `-1` = use grid-clicked active slot; `>=0` = force that slot (clamped to `0..count-1`) |
| hidden | `pool_id` | STRING | stable UUID, generated on node create, saved in workflow |

Selection rule: if `index` widget `== -1`, use `manifest.active`; else use
`clamp(index, 0, count-1)`. The actually-used index is echoed on the `index` output.

## 3. Storage — managed pool folder

```
input/grid_pool/<pool_id>/
  manifest.json
  img_0001.png   img_0001.mask.png
  img_0002.png   ...
```

`manifest.json`:

```json
{
  "active": 0,
  "slots": [
    { "image": "img_0001.png", "mask": "img_0001.mask.png", "label": "", "added": 1718960000 }
  ]
}
```

- Workflow JSON stores only `pool_id` + the `index` widget → stays tiny.
- Pool survives restart (lives in ComfyUI's `input/`).
- `mask` may be `null`/absent until a mask is drawn.

## 4. Components & data flow

### Python node (`__init__.py`)
- On execute: resolve pool dir from `pool_id`, read `manifest.json`, choose slot,
  load image + mask → tensors, return `(IMAGE, MASK, index, count, label)`.
- Empty pool → return a 1x1 black image + zero mask + `count=0` (never crash the graph).
- `IS_CHANGED` returns a hash of `(pool_id, chosen_index, image_mtime, mask_mtime)` so
  that editing a mask or replacing an image forces re-execution (otherwise ComfyUI
  caches the output and the new mask is never seen).
- Mask convention: load as single-channel float; if no mask file, emit zeros matching
  image H×W.

### JS extension (`web/`)
A resizable **in-node DOM widget** rendering the thumbnail grid (scrollable so a big
pool doesn't blow up the node). Responsibilities:

- **Ingest**: paste (Ctrl+V on node), drag-drop files, upload button → POST to
  `/grid_pool/add`; server copies into the pool, appends a slot, returns manifest.
- **Select**: click thumbnail → `/grid_pool/active`, highlight active.
- **Mask**: brush button / double-click → push the slot image into `ComfyApp.clipspace`
  (`imgs`/`images`/`selectedIndex`), set `ComfyApp.clipspace_return_node = node`, call
  `openMaskEditor()`. The editor saves the alpha mask via `/upload/mask`; on return the
  node's `pasteFromClipspace()` fires → we extract the alpha and POST it to
  `/grid_pool/set_mask` to write the slot's `.mask.png`.
- **Label**: inline-editable caption under each thumbnail → `/grid_pool/label`.
- **Delete**: ✕ on thumbnail → `/grid_pool/remove`.
- Badges: active border, "has-mask" dot, slot index.

### Server routes (aiohttp, registered from Python)
Under `/grid_pool/*`: `add`, `remove`, `active`, `set_mask`, `label`, `list`.
All mutate `manifest.json` atomically and return the updated manifest.

## 5. UI approach

Chosen: **in-node grid** (thumbnails in the node body; resize node to see more,
scroll for large pools). Rejected alternative: modal "manage pool" gallery — better for
huge pools but more clicks and more UI code; revisit only if pools get large.

## 6. Edge cases & error handling

- Empty pool → 1x1 black image + zero mask + `count=0`.
- `index >= count` → clamp; echo the clamped value on `index` output.
- Missing/corrupt manifest → rebuild from files on disk.
- Cloning a node copies `pool_id` → both nodes share one pool. Provide right-click
  **"Detach pool (new id)"** to split. v1 may just document the behavior.
- MaskEditor integration verified against the installed frontend: `openMaskEditor`,
  `copyToClipspace`/`pasteFromClipspace`, `clipspace_return_node`, and `/upload/mask`
  all exist. This is the standard "Open in MaskEditor" pattern used by many nodes.

## 7. Phasing & testing

- **Phase 1** — storage + manifest + Python node + server routes + grid display +
  select + delete + labels (no masking). E2E: add images, pick one, it outputs
  image/mask(zeros)/index/count/label.
- **Phase 2** — MaskEditor integration + per-slot mask persistence + `IS_CHANGED`.
- **Phase 3** — polish: drag-reorder, "detach pool", badges.

Testing:
- pytest (Python): manifest read/write, atomic mutation, slot selection rule, tensor
  shapes/dtypes, zero-mask fallback, `IS_CHANGED` hashing, manifest rebuild.
- Manual checklist (JS/MaskEditor): ingest paths, select, mask round-trip, label edit,
  delete, persistence across restart.
