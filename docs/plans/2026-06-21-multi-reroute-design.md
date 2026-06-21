# Multi-Reroute (Rail) — Design

Date: 2026-06-21
Status: Approved (brainstorming complete, ready for implementation plan)

## 1. Purpose

A single node holding **N parallel pass-through lanes** (a "rail"), so you can run tidy
bundles of wires across the graph instead of dropping many separate Reroute nodes. Each lane
forwards any type; you grow/shrink the rail with +/− at either end.

Seventh node in the `ComfyUI-Datasete-Gates` suite.

## 2. Approach

A **real pass-through node** with **any-type lanes** (`AnyType("*")`). Lane `i`'s input is
forwarded to lane `i`'s output. An unconnected lane outputs an `ExecutionBlocker` so nothing
downstream of an unused lane runs. (Not the frontend-only virtual-reroute trick — simpler and
robust across all types; the trade-off is slots read as `*` instead of adapting to the wired
type.)

## 3. IO

- Up to `MAX_LANES` (32) lanes, each: optional input `in_<i>` (`*`) → output `out_<i>` (`*`).
- The node always returns a length-`MAX_LANES` tuple; the frontend shows only the active
  lanes (default 4). Wired output indices are stable, so unshown trailing outputs are simply
  unconnected.

```
RETURN_TYPES = (ANY,) * MAX_LANES        RETURN_NAMES = ("out_1", …, "out_32")
INPUT_TYPES  = {"optional": {"in_1": (ANY,), …}}
```

No `IS_CHANGED` override — a reroute should be transparent/cacheable (re-runs only when an
input value actually changes).

## 4. Run logic

```python
def run(self, **kwargs):
    blocker = ExecutionBlocker(None)
    return tuple(
        kwargs.get(f"in_{i+1}") if kwargs.get(f"in_{i+1}") is not None else blocker
        for i in range(MAX_LANES)
    )
```

Lane-count-agnostic: connected lanes forward their value; empty lanes block. The visible lane
count is purely a frontend concern.

## 5. Frontend (`web/multi_reroute.js`)

- Render `lanes` lane rows (input + output pair), default 4; persist the count in a hidden
  widget so reload restores the rail (the "use raw widgets_values to add slots before link
  rewiring" pattern already used in this repo).
- **+/− buttons**:
  - **Bottom add/remove** (Phase 1): reveal/hide the next/last lane pair — trivial and
    wiring-safe (only the end moves).
  - **Top add/remove** (Phase 2): insert/remove a lane at the top while **preserving the
    other lanes' wiring** — requires capturing links and re-mapping slot indices
    (rgthree-style). Kept separate so a bug here can't scramble existing rails.
- Lanes use the shared `AnyType` so any wire connects.
- (Phase 3 polish) compact reroute-pill look / optional per-lane labels.

## 6. Edge cases

- Empty lane → `ExecutionBlocker` (downstream skipped). A legitimate `None` value is treated
  as empty (reroute values are objects/tensors, effectively never `None`).
- Removing a lane is from the **end** in Phase 1 (indices stay stable → links intact).
  Mid/top removal is Phase 2 with remap.
- More than `MAX_LANES` requested → capped (logged in UI).
- Mixed types across lanes is fine — each lane is independent `*`.

## 7. Code shape

- `gates/anytype.py` *(new)* — shared `AnyType("*")` + `ANY` (textgate can dedupe onto this
  later; not touched now).
- `gates/reroute_node.py` *(new)* — pure `build_outputs(values, max_lanes, blocker)` +
  `MultiReroute` node (lazy `ExecutionBlocker` import for testability).
- `web/multi_reroute.js` *(new)* — dynamic lane slots + +/− buttons + persistence.
- root `__init__.py` — additive merge of the node mapping.

## 8. Testing

- pytest: `anytype` equals-everything; `build_outputs` forwards connected lanes and blocks
  empty ones (length == MAX_LANES); node `RETURN_TYPES` length + all-`*`.
- Manual (live): add/remove lanes (bottom, then top), wire mixed types through, confirm values
  pass and reload restores the rail; empty lanes don't trigger downstream.
