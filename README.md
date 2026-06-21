# ComfyUI Datasete Gates

Custom nodes for curating image datasets in ComfyUI.

## Image Pool (Grid)

A node that holds a curated **pool of images** — each with its own remembered
mask and editable label — shown as an in-node thumbnail grid. One image is
selectable as the node's output (image + mask + index + count + label), so you
can switch which image flows downstream **without rewiring**.

![category: Datasete Gates]

### What it does

- **In-node grid** of the pooled images. Ingest by **paste** (Ctrl+V),
  **drag-and-drop**, or the **Upload** button.
- **Click a thumbnail** to make it the active output. No rewiring needed to
  switch images.
- **Per-slot mask**: click the 🖌 button to paint a mask in ComfyUI's
  MaskEditor. The mask is remembered per image and never redrawn when you switch
  between images.
- **Per-slot label**: type a label under each thumbnail; it's saved with the
  pool and exposed on the `label` output.
- **Drag to reorder** thumbnails; **✕** to delete.
- The pool is stored on disk, so it **survives a ComfyUI restart** and travels
  with the workflow (via a per-node pool id).

### Inputs

| Input     | Type   | Description |
|-----------|--------|-------------|
| `index`   | INT    | `-1` (default) outputs the in-node **selected** image. `0+` forces that slot index (clamped to the pool size). |
| `pool_id` | STRING | Per-node pool identifier. Managed automatically by the UI (a UUID minted per node and hidden); you normally never touch it. |

### Outputs

| Output  | Type   | Description |
|---------|--------|-------------|
| `image` | IMAGE  | The selected image, `[1, H, W, 3]` float 0..1. A 1×1 black image when the pool is empty. |
| `mask`  | MASK   | The selected image's mask, `[1, H, W]` float 0..1. **All zeros** when the slot has no mask. |
| `index` | INT    | The resolved slot index that was output. |
| `count` | INT    | Number of images in the pool. |
| `label` | STRING | The selected slot's label. |

### Mask polarity

A mask is a grayscale PNG where **white (1.0) = the painted region of interest**
(the area you painted in the MaskEditor — i.e. the area to inpaint). No mask file
means an all-zeros MASK output. The MaskEditor stores the painted region in the
image's alpha channel; the extension bakes that alpha into a grayscale mask on
save so that white = painted.

### Managed pool folder

Each pool lives under ComfyUI's input directory:

```
input/grid_pool/<pool_id>/
├── manifest.json        # {active, slots:[{image, mask, label, added}], next_seq}
├── img_0001.png         # an image
├── img_0001.mask.png    # its mask (sidecar; optional)
├── img_0002.png
└── ...
```

- Images are named monotonically (`img_0001.png`, `img_0002.png`, …).
- A mask is stored as a `*.mask.png` sidecar next to its image.
- `manifest.json` is written atomically. If it's missing or corrupt, it is
  rebuilt from the files on disk.

### Cloning nodes

Copy/paste of a node shares the source node's `pool_id` (both show the same
pool). To give a clone its **own** independent pool, right-click it →
**“Detach pool (new id)”**.

## Install

Clone (or symlink) this repo into ComfyUI's `custom_nodes/`:

```bash
git clone <repo-url> /path/to/ComfyUI/custom_nodes/ComfyUI-Datasete-Gates
# or, for local development:
ln -sfn /media/p5/ComfyUI-Datasete-Gates /path/to/ComfyUI/custom_nodes/ComfyUI-Datasete-Gates
```

Restart ComfyUI. The node appears under the **“Datasete Gates”** category as
**“Image Pool (Grid)”**.

Dependencies (torch, Pillow, numpy, aiohttp) are already provided by ComfyUI.

## Development

The storage layer (`gates/pool.py`) is pure stdlib and fully unit-tested without
ComfyUI. Run the tests with:

```bash
python -m pytest tests/ -v
```

Layout:

- `gates/pool.py` — pure storage (manifest, add/remove/reorder/active/label/mask). Stdlib only.
- `gates/imaging.py` — torch/PIL tensor loaders.
- `gates/node.py` — the `GridImagePool` node.
- `gates/handlers.py` / `gates/routes.py` — pure handlers + aiohttp routes (`/grid_pool/*`).
- `web/grid_image_pool.js` — the in-node grid UI + MaskEditor integration.
