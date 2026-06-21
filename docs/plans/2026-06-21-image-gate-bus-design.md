# Image Gate — Send/Get Bus (teleport + checkpoint) — Design

Date: 2026-06-21
Status: Approved (brainstorming complete, ready for implementation plan)

## 1. Purpose

Let Image Gates pass images to each other by **name** through a disk-backed bus, so you can
**re-enter the pipeline at a gate** after manual editing/looking — without dragging wires and
without creating graph cycles. A gate **auto-publishes** its passed image (+ mask) to a named
slot; another gate (or a fresh workflow) **loads** that slot to resume from that point.

This is an enhancement to the existing `Image Gate (Manual Router)` — no new node.

## 2. Why no wire / no cycle

ComfyUI graphs must be acyclic; a real wire from a downstream gate's output back into an
upstream gate is a cycle and is rejected at validation. The bus links sender↔receiver by a
**string id**, so there is no live wire and no cycle. "Ignore on the normal path" falls out
naturally from making `image` optional (see §4).

## 3. Changes to the Image Gate

New ports/widgets (all backward compatible):

| Port | Type | Description |
|------|------|-------------|
| `image` | IMAGE | **now optional.** Wired → normal path. Empty → load from `get_id`. |
| `send_id` | STRING (widget) | If non-empty, on every **pass** the chosen image + mask are written to the bus slot `send_id` (latest-wins). Empty = don't publish. |
| `get_id` | STRING (widget, dropdown) | Used only when `image` is **not** connected: load the latest image + mask from this bus slot, then gate as usual. Dropdown lists existing bus ids. |

Existing inputs (`routes`) and outputs (`mask`, `route_1..route_10`) are unchanged.

## 4. Run logic

```
base = input/gate_bus
image, loaded_mask = resolve_source(base, image, get_id)
    # image given  -> (image, None)                     [normal path; get ignored]
    # else get_id  -> load (image, mask) from bus slot  [re-entry]
    # else         -> nothing: block all routes silently, return zero mask
pause + wait (Stop -> InterruptProcessingException)     [unchanged]
mask = painted-at-gate  OR  loaded_mask  OR  zeros      [precedence]
if send_id: write image+mask to bus[send_id]            [auto-publish on pass]
return (mask,) + route_tuple(chosen)                    [unchanged routing]
```

`IS_CHANGED` stays `nan` (always pauses). A gate with no image and no valid `get_id` is a
silent no-op (all routes `ExecutionBlocker`, zero mask) so it never breaks a graph.

## 5. Bus storage

```
input/gate_bus/<id>/
├── image.png     # latest passed image for this slot
└── mask.png      # its mask (white = painted)
```
Latest-wins (overwrite). `id` is the human-chosen name. Survives restart → cross-run resume.

## 6. Frontend (`web/image_gate.js`)

- Make the `image` input optional (litegraph) — the node works with it empty.
- `send_id`: a plain text widget.
- `get_id`: render as a **dropdown** populated from `GET /datasete_gate/bus/list`
  (refresh when opened), plus free-text entry.
- Pause/preview UI unchanged — `send_preview` runs after the source is resolved, so
  get-loaded images preview correctly.

## 7. Code shape

- `gates/imagebus.py` *(new, stdlib)* — slot paths, `has`, `ensure_dir`, `list_ids`,
  `delete_id`. Unit-testable.
- `gates/imaging.py` *(additive)* — `save_image_tensor`, `save_mask_tensor` (mirror the
  existing loaders). Unit-testable with torch.
- `gates/gate.py` *(additive)* — `bus_save`/`bus_load`, pure `resolve_source`, and the
  `run()` wiring (optional image, publish on pass). comfy imports stay lazy.
- `gates/gates_compat.py` *(additive)* — `gate_bus_base()` → `input/gate_bus`.
- `gates/gate_server.py` *(additive)* — `GET /datasete_gate/bus/list`.

## 8. Edge cases

- `image` empty + `get_id` empty/missing → silent no-op (no pause, all blocked).
- Mask precedence: gate-painted > loaded-from-bus > zeros.
- Same `send_id` from multiple gates → latest pass wins (documented).
- `get_id` referencing a deleted slot → treated as missing (no-op).
- Cross-run: publish in run A, load in run B (even after restart) — that's the whole point.

## 9. Testing

- pytest: `imagebus` (paths/has/list/delete); `imaging` save→load round-trip (shapes, mask
  polarity); `gate.resolve_source` (image wins / get loads / nothing → None); `bus_save`+
  `bus_load` round-trip.
- Manual (live): publish at gate A (`send_id=cp1`), then a gate with empty image +
  `get_id=cp1` loads it (even in a new workflow), edit mask, route onward; dropdown lists ids;
  normal wired path ignores the bus.
