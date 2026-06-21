# Multi-Reroute (Rail) Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** A `MultiReroute` node — N parallel any-type pass-through lanes ("rail") with +/− to add/remove lanes — so wire bundles stay tidy without many separate Reroute nodes.

**Architecture:** A real pass-through node with `AnyType("*")` lanes: `in_i → out_i`, empty lane → `ExecutionBlocker`. Pure `build_outputs` is unit-tested; `ExecutionBlocker` is imported lazily. The frontend manages dynamic lane slots and persists the lane count. Bottom add/remove is Phase 1 (wiring-safe); top add/remove (link-preserving) is Phase 2.

**Tech Stack:** Python 3.12 (stdlib), pytest 9; vanilla JS frontend.

---

## Conventions (read once)

- **Test python:** `/media/p5/miniforge3/bin/python` (`PY=...`).
- **Run tests:** `cd /media/p5/ComfyUI-Datasete-Gates && $PY -m pytest tests/test_anytype.py tests/test_reroute.py -v`
- `gates/anytype.py` and `gates/reroute_node.py` import-safe without comfy (lazy
  `ExecutionBlocker` inside `run`).
- `__init__.py` edit is **additive** — re-Read first, extend the mappings.
- `MAX_LANES = 32`, default visible lanes = 4.
- Commit style: Conventional Commits + repo Co-Authored-By; stage only this node's paths.

---

### Task 1: `anytype.py` — shared wildcard

**Files:** Create `gates/anytype.py`; Test `tests/test_anytype.py`

**Step 1: Failing test**

```python
# tests/test_anytype.py
from gates import anytype

def test_any_equals_everything():
    assert (anytype.ANY != "IMAGE") is False
    assert (anytype.ANY != "LATENT") is False
    assert isinstance(anytype.ANY, str)
```

**Step 2: Run → FAIL.**

**Step 3: Implement**

```python
# gates/anytype.py
"""Shared ComfyUI wildcard type."""


class AnyType(str):
    def __ne__(self, other):
        return False


ANY = AnyType("*")
```

**Step 4: Run → PASS.**  **Step 5: Commit** `feat: shared AnyType wildcard`

---

### Task 2: `reroute_node.py` — `build_outputs`

**Files:** Create `gates/reroute_node.py`; Test `tests/test_reroute.py`

**Step 1: Failing test**

```python
# tests/test_reroute.py
from gates import reroute_node as rr

def test_build_outputs_forwards_and_blocks():
    B = object()  # blocker sentinel
    vals = {"in_1": "A", "in_3": "C"}
    out = rr.build_outputs(vals, max_lanes=4, blocker=B)
    assert out == ("A", B, "C", B)

def test_build_outputs_length():
    B = object()
    assert len(rr.build_outputs({}, max_lanes=rr.MAX_LANES, blocker=B)) == rr.MAX_LANES
```

**Step 2: Run → FAIL.**

**Step 3: Implement**

```python
# gates/reroute_node.py
from .anytype import ANY

NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}

MAX_LANES = 32


def build_outputs(values, max_lanes, blocker):
    out = []
    for i in range(max_lanes):
        v = values.get(f"in_{i + 1}")
        out.append(v if v is not None else blocker)
    return tuple(out)
```

**Step 4: Run → PASS.**  **Step 5: Commit** `feat: multi-reroute build_outputs`

---

### Task 3: `reroute_node.py` — `MultiReroute` node

**Files:** Modify `gates/reroute_node.py`, `tests/test_reroute.py`

**Step 1: Failing test**

```python
def test_io_shape():
    assert len(rr.MultiReroute.RETURN_TYPES) == rr.MAX_LANES
    assert all(t == "*" for t in rr.MultiReroute.RETURN_TYPES)
    assert rr.MultiReroute.RETURN_NAMES[0] == "out_1"
    it = rr.MultiReroute.INPUT_TYPES()
    assert "in_1" in it["optional"] and f"in_{rr.MAX_LANES}" in it["optional"]
```

**Step 2: Run → FAIL.**

**Step 3: Implement (append)**

```python
class MultiReroute:
    CATEGORY = "Datasete Gates"
    FUNCTION = "run"
    RETURN_TYPES = (ANY,) * MAX_LANES
    RETURN_NAMES = tuple(f"out_{i + 1}" for i in range(MAX_LANES))

    @classmethod
    def INPUT_TYPES(cls):
        return {"optional": {f"in_{i + 1}": (ANY,) for i in range(MAX_LANES)}}

    def run(self, **kwargs):
        from comfy_execution.graph_utils import ExecutionBlocker
        return build_outputs(kwargs, MAX_LANES, ExecutionBlocker(None))


NODE_CLASS_MAPPINGS = {"MultiReroute": MultiReroute}
NODE_DISPLAY_NAME_MAPPINGS = {"MultiReroute": "Multi Reroute (Rail)"}
```

> `RETURN_TYPES` entries are the `AnyType` instance (`== "*"`), so the test's `t == "*"`
> holds. No `IS_CHANGED` (transparent/cacheable passthrough).

**Step 4: Run → PASS.**  **Step 5: Commit** `feat: MultiReroute node (any-type pass-through lanes)`

---

### Task 4: Register in `__init__.py` (MERGE)

**Files:** Modify `__init__.py`

**Step 1:** Re-Read `__init__.py`; add inside `if __package__:`:

```python
    from .gates.reroute_node import NODE_CLASS_MAPPINGS as _RR_NODES, \
        NODE_DISPLAY_NAME_MAPPINGS as _RR_NAMES
```
and merge into the final dicts:
```python
    NODE_CLASS_MAPPINGS = {**NODE_CLASS_MAPPINGS, **_RR_NODES}
    NODE_DISPLAY_NAME_MAPPINGS = {**NODE_DISPLAY_NAME_MAPPINGS, **_RR_NAMES}
```

**Step 2:** `$PY -c "import gates.reroute_node; print(gates.reroute_node.NODE_CLASS_MAPPINGS)"`.

**Step 3:** Full suite green: `$PY -m pytest tests/ -v`.

**Step 4: Commit** `feat: register MultiReroute`

---

### Task 5: `web/multi_reroute.js` — dynamic lanes + bottom +/− (Phase 1)

**Files:** Create `web/multi_reroute.js`

`app.registerExtension` for `MultiReroute`:
- On `nodeCreated`: ensure the node shows `lanes` lane pairs (default 4). Keep a hidden
  `lanes` widget (count) so the rail count **persists** across save/reload — restore by
  re-adding that many slot pairs (mirror the repo's existing dynamic-slot restore that reads
  raw `widgets_values` before link rewiring).
- Maintain exactly `lanes` visible input slots `in_1..in_lanes` and output slots
  `out_1..out_lanes` (add/remove the trailing pair as the count changes).
- **Bottom +**: `lanes++` → add `in_{n}`/`out_{n}`. **Bottom −**: `lanes--` → remove the last
  pair (only the end moves, so existing wiring is untouched). Clamp `1..MAX_LANES`.
- Buttons via on-node widgets (or the node context menu) labeled `+ lane` / `− lane`.
- Slots are any-type (`*`) so any wire connects.

**Manual verify:** add/remove lanes from the bottom; wire IMAGE through lane 1 and LATENT
through lane 2; values pass; save+reload restores the lane count and wiring.

**Commit** `feat: multi-reroute frontend — dynamic lanes + bottom add/remove`

---

### Task 6: `web/multi_reroute.js` — top +/− with wiring preservation (Phase 2)

**Files:** Modify `web/multi_reroute.js`

- **Top +**: insert a new lane at the top. Because slots are positional and links bind to
  slot index, capture all current input/output links, add a pair, and **re-map links** so the
  existing lanes keep their connections and the new empty lane is visually first.
- **Top −**: remove the top lane, remap the rest up.
- Implement against a small lane-model (list of logical lanes ↔ slot indices); rebuild slots
  and reconnect from the model so a failure can't silently drop wires.

**Manual verify:** with lanes 1–3 wired, Top + adds an empty lane at top and 1–3 stay wired;
Top − removes it cleanly. Save/reload still consistent.

**Commit** `feat: multi-reroute top add/remove (wiring-preserving)`

---

### Task 7: Live smoke test in ComfyUI

Restart ComfyUI. Verify:
- [ ] "Multi Reroute (Rail)" appears under "Datasete Gates" with 4 lanes.
- [ ] Bottom +/− add/remove lanes; Top +/− (Phase 2) keep existing wiring.
- [ ] Route mixed types (IMAGE, MASK, LATENT, STRING) through separate lanes → all pass intact.
- [ ] An unconnected lane doesn't trigger its downstream (ExecutionBlocker).
- [ ] Save + reload restores lane count and all connections.

**Commit** (if fixes) `fix: multi-reroute live-test adjustments`

---

## Definition of done

- `$PY -m pytest tests/test_anytype.py tests/test_reroute.py -v` green; full `tests/` green.
- Manual checklist passes: lanes add/remove (bottom; top in P2), mixed-type pass-through,
  empty-lane blocking, persistence.
