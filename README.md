# ComfyUI Datasete Gates

A suite of custom nodes for **curating, loading, and gating image datasets** in
ComfyUI — built for human-in-the-loop inpaint/sort pipelines where you review
images, route them, and reuse them across workflows without rewiring.

All nodes appear under the **“Dataset Gates”** category.

## Nodes at a glance

| Node | Class | What it does |
|------|-------|--------------|
| **Image Pool (Grid)** | `GridImagePool` | Holds a curated pool of images (each with a remembered mask + label) as an in-node grid; outputs the selected one — switch images without rewiring. |
| **Pool Profile** | `PoolProfile` | Companion node: create/select/manage **named profiles** so a pool's images can be reused in any workflow and moved between machines. |
| **Folder Image Loader** | `FolderImageLoader` | Loads an image by index from a folder (fixed or auto-advancing), with its sidecar `.txt` caption and alpha mask. |
| **Image Gate (Manual Router)** | `ImageGate` | Pauses the run and lets you **click a button to route** the image down one of up to 10 outputs; optional gate-time mask; Stop cancels. |
| **Image Chooser Gate (Batch)** | `ImageChooserGate` | Pauses the run, displays every image in an incoming batch, and passes the **selected subset** onward as a batch. |
| **Text Gate (Manual Pass)** | `TextGate` | Pauses the run, shows the incoming text in an **editable** box, and passes it on a click; any-type `signal` in/out for ordering. |

## Install

Clone (or symlink) this repo into ComfyUI's `custom_nodes/`:

```bash
git clone <repo-url> /path/to/ComfyUI/custom_nodes/ComfyUI-Datasete-Gates
# or, for local development:
ln -sfn /media/p5/ComfyUI-Datasete-Gates /path/to/ComfyUI/custom_nodes/ComfyUI-Datasete-Gates
```

Restart ComfyUI. Dependencies (torch, Pillow, numpy, aiohttp) are already
provided by ComfyUI.

---

## Image Pool (Grid)

Holds a curated **pool of images** — each with its own remembered mask and
editable label — shown as an in-node thumbnail grid. One image is selectable as
the node's output, so you can switch which image flows downstream **without
rewiring**.

### What it does

- **In-node grid** of pooled images. Ingest by **paste** (Ctrl+V),
  **drag-and-drop**, or the **Upload** button.
- **Click a thumbnail** to make it the active output. No rewiring to switch.
- **Per-slot mask**: click 🖌 to paint a mask in ComfyUI's MaskEditor. The mask
  is remembered per image and never redrawn when you switch between images.
- **Per-slot label**: type a label under each thumbnail; saved with the pool and
  exposed on the `label` output.
- **Drag to reorder** thumbnails; **✕** to delete.
- Stored on disk, so the pool **survives a restart**. Pair with **Pool Profile**
  to reuse it across workflows.

### Inputs

| Input     | Type          | Description |
|-----------|---------------|-------------|
| `index`   | INT           | `-1` (default) outputs the in-node **selected** image. `0+` forces that slot index (clamped to the pool size). |
| `pool_id` | STRING        | Per-node pool identifier; managed by the UI (a hidden per-node UUID). You normally never touch it. |
| `profile` | POOL_PROFILE  | *Optional.* When connected to a **Pool Profile** node, the pool uses that profile instead of its own `pool_id` (`profile or pool_id`). |

### Outputs

| Output  | Type   | Description |
|---------|--------|-------------|
| `image` | IMAGE  | The selected image, `[1, H, W, 3]` float 0..1. A 1×1 black image when the pool is empty. |
| `mask`  | MASK   | The selected image's mask, `[1, H, W]` float 0..1. **All zeros** when the slot has no mask. |
| `index` | INT    | The resolved slot index that was output. |
| `count` | INT    | Number of images in the pool. |
| `label` | STRING | The selected slot's label. |

### Cloning nodes

Copy/paste shares the source node's `pool_id` (both show the same pool). To give
a clone its **own** independent pool, right-click → **“Detach pool (new id)”**.

---

## Pool Profile

Companion to the Image Pool. Turns a pool's fragile per-node UUID into a
**named, reusable profile**, so the same images (with masks/labels) can be loaded
in any workflow — and exported to another machine.

Wire its `profile` output into a pool's `profile` input. Selecting a profile
**live-switches** the connected pool's grid to that profile's images, and any
adds/masks land in it.

### Actions

- **Create** a new named profile, **Select** an existing one (dropdown).
- **Rename**, **Delete** (removes its images), **Duplicate / Save-as** (snapshot
  to a new profile).
- **Export** a profile to a `.zip`, **Import** one back — pools become portable.

### Inputs / Outputs

| Port | Type | Description |
|------|------|-------------|
| `profile` (widget) | STRING | The selected profile name (UI renders a dropdown). |
| `profile_id` (widget) | STRING | Hidden, UI-managed stable id. |
| `profile` (output) | POOL_PROFILE | The selected profile's id → connect to a pool's `profile` input. |

### Registry

`input/grid_pool/profiles.json` maps friendly **name → stable id**; each
profile's data lives in the existing `input/grid_pool/<id>/` layout. Existing
unnamed pools keep working unchanged — they're just unregistered ids.

---

## Folder Image Loader

Loads an image by index from a folder, plus its sidecar caption text and alpha
mask. Built for sequential, one-image-per-run dataset processing.

### Inputs

| Input    | Type | Description |
|----------|------|-------------|
| `folder` | STRING | Absolute path to a folder of images. |
| `index`  | INT  | Which image (after natural sort). Has **`control_after_generate`** → set it to fixed / increment / decrement; auto-advances after each run. |
| `depth`  | INT  | `0` = top-level only; `N` = recurse up to N levels; `-1` = unlimited. |

### Outputs

| Output     | Type   | Description |
|------------|--------|-------------|
| `image`    | IMAGE  | The loaded image. |
| `text`     | STRING | Contents of the sidecar `<stem>.txt`, or `""` if none. |
| `mask`     | MASK   | From the image's alpha channel (`1 - alpha`); zeros sized to the image if no alpha. |
| `filename` | STRING | The file **stem** (no extension). |
| `index`    | INT    | The resolved index actually loaded. |

### Notes

- Files are **natural-sorted** (`img2` before `img10`); extensions
  `.png/.jpg/.jpeg/.webp/.bmp/.tif/.tiff`.
- Walking past the end (or below 0) **raises** — a clean end-of-batch stop signal
  when running in increment mode. Empty folder / bad path raise too.

---

## Image Gate (Manual Router)

Pauses the running prompt and shows the image with a row of labeled **route
buttons**. Click a route to send the image down that output; every other route is
silently skipped. Built for manual dataset sorting.

### Inputs

| Input    | Type  | Description |
|----------|-------|-------------|
| `image`  | IMAGE | The image (or batch, routed as one unit). |
| `routes` | INT   | Number of visible route buttons/outputs (1–10). |

### Outputs

| Output            | Type | Description |
|-------------------|------|-------------|
| `mask`            | MASK | Painted at the gate (🖌), or zeros. Always emitted. |
| `route_1`…`route_10` | IMAGE | The chosen route carries the image; the rest return an `ExecutionBlocker` so only the chosen branch runs. The UI shows only `routes` of them, with editable labels. |

### How it works

- During execution the node **blocks** until you click. **Route K** → image to
  output K (others blocked). **🖌 Edit mask** → opens the MaskEditor; the result
  comes out on `mask`. **■ Stop** → cancels the whole run cleanly.
- Because any `ExecutionBlocker` input skips a node, a non-chosen route's
  downstream never runs — as long as it also consumes the routed image (the
  normal wiring). It re-pauses on every run (never cached).

---

## Image Chooser Gate (Batch)

Pauses the running prompt and shows the complete incoming image batch as a
scrollable thumbnail grid. Click one or more thumbnails, then click **Pass
selected** to emit just those images as a new batch.

### Inputs / Outputs

| Port | Type | Description |
|------|------|-------------|
| `images` (input) | IMAGE | The batch to review. It must contain at least one image. |
| `images` (output) | IMAGE | The selected images as a batch, in their original input order. |

### How it works

- Click a thumbnail to select or deselect it. **Select all** and **Clear** help
  with larger batches; at least one image is required before passing.
- Each new run starts with an empty selection, so a stale choice cannot be
  applied to a different batch. The gate always pauses and is never cached.
- The browser receives only small JPEG thumbnails. The output comes directly
  from the original tensor, so choosing images does not resize or recompress
  them.
- **Stop** cancels the run. After passing, **Run from here** queues the workflow
  again and presents a fresh choice.

---

## Text Gate (Manual Pass)

Pauses the run, shows the incoming text in an **editable** box, and emits it
(edited) when you click **Pass**. An optional any-type `signal` lets you force
execution order.

### Inputs

| Input    | Type | Description |
|----------|------|-------------|
| `text`   | STRING (`forceInput`) | The incoming text to review/edit. |
| `signal` | `*` (any) | *Optional.* Accepts any type; only used to sequence this node after its source. |

### Outputs

| Output   | Type | Description |
|----------|------|-------------|
| `text`   | STRING | The text you passed (possibly edited). |
| `signal` | `*` (any) | Passthrough of the input signal — chain gates in a fixed order. |

Pauses every run; ComfyUI's global **Cancel** unblocks it cleanly (no deadlock).

---

## Concepts

### Human-in-the-loop gates

Image Gate, Image Chooser Gate, and Text Gate **block the executor thread**
during a run and wait for a click (a small server-side waiter plus an HTTP route
the UI posts to). Stop / Cancel raise ComfyUI's
`InterruptProcessingException`. These nodes always re-execute
(`IS_CHANGED = nan`) so they pause every time.

### Mask polarity

A mask is a grayscale PNG where **white (1.0) = the painted region of interest**
(the area to inpaint). No mask → an all-zeros MASK. The MaskEditor stores the
painted region in the image's alpha channel; the extension bakes that alpha into
a grayscale mask on save so that white = painted.

### Storage layout

```
input/grid_pool/
├── profiles.json              # {profiles:[{id, name, created}]}  (Pool Profile)
└── <pool_id or profile_id>/
    ├── manifest.json          # {active, slots:[{image, mask, label, added}], next_seq}
    ├── img_0001.png           # an image (named monotonically)
    ├── img_0001.mask.png      # its mask (sidecar; optional)
    └── ...
```

`manifest.json` is written atomically; if missing or corrupt it is rebuilt from
the files on disk.

---

## Development

The pure storage/scan layers are stdlib-only and unit-tested without ComfyUI:

```bash
python -m pytest tests/ -v
```

Layout:

- `gates/pool.py` — pure pool storage (manifest, add/remove/reorder/active/label/mask).
- `gates/profiles.py` — pure profile registry + dir ops + zip export/import.
- `gates/scan.py` — pure folder scan (natural sort, depth, sidecar, index).
- `gates/gate_bus.py` — pure blocking choice/text/mask/selection waiter for the gates.
- `gates/imaging.py` — torch/PIL tensor loaders.
- `gates/node.py` · `loader.py` · `gate.py` · `image_chooser.py` · `textgate.py` ·
  `profile_node.py` — the nodes.
- `gates/handlers.py` · `routes.py` · `gate_server.py` · `profiles_routes.py` — aiohttp glue
  (`/grid_pool/*`, `/datasete_gate/*`, `/datasete_image_chooser/*`,
  `/grid_pool/profiles/*`).
- `web/*.js` — the in-node UIs (grid + MaskEditor, gate previews, profile dropdown).
