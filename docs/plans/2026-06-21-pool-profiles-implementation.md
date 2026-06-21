# Pool Profiles Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add named, portable **profiles** to the Image Pool — a `Pool Profile` companion node (create/select/rename/delete/duplicate/export/import) that feeds a `POOL_PROFILE` id into the Image Pool node, with live edit-time grid switching.

**Architecture:** A pure stdlib `gates/profiles.py` manages a `profiles.json` registry (name→id) plus per-profile dir ops and zip export/import — fully unit-testable. `gates/profile_node.py` is the companion node (outputs the id). The existing pool node gains an optional `profile` input and uses `profile or pool_id`. `gates/profiles_routes.py` is the aiohttp glue (uuid gen + zip streaming). Frontend (`web/pool_profile.js`) drives a dropdown + action buttons and propagates the selected id into connected pool nodes (project_key.js style); a small `grid_image_pool.js` tweak accepts the input + exposes a refresh hook.

**Tech Stack:** Python 3.12 (stdlib: json/shutil/zipfile), aiohttp, pytest 9; vanilla JS frontend.

---

## Conventions (read once)

- **Test python:** `/media/p5/miniforge3/bin/python` (`PY=...`).
- **Run tests:** `cd /media/p5/ComfyUI-Datasete-Gates && $PY -m pytest tests/test_profiles.py -v`
- `gates/profiles.py` MUST be stdlib-only (no comfy/torch); ids are passed in as params
  (UUIDs are generated in the route layer) so tests are deterministic.
- Edits to `gates/node.py`, `web/grid_image_pool.js`, `__init__.py` are **additive** —
  re-Read first, keep existing Image Pool behavior, run full suite after.
- Base dir for all profile ops = `gates_compat.grid_pool_base()` (= `input/grid_pool`).
- Concurrency: stage only this feature's paths per commit. Commit style: Conventional
  Commits + repo Co-Authored-By trailer.

---

### Task 1: `profiles.py` — registry read/write + find helpers

**Files:** Create `gates/profiles.py`; Test `tests/test_profiles.py`

**Step 1: Failing test**

```python
# tests/test_profiles.py
from gates import profiles as pr

def test_empty_registry():
    assert pr.empty_registry() == {"profiles": []}

def test_read_missing_is_empty(tmp_path):
    assert pr.read_registry(str(tmp_path)) == {"profiles": []}

def test_write_then_read(tmp_path):
    reg = {"profiles": [{"id": "a", "name": "n", "created": 1}]}
    pr.write_registry(str(tmp_path), reg)
    assert (tmp_path / "profiles.json").exists()
    assert pr.read_registry(str(tmp_path)) == reg

def test_read_corrupt_is_empty(tmp_path):
    (tmp_path / "profiles.json").write_text("{ not json")
    assert pr.read_registry(str(tmp_path)) == {"profiles": []}

def test_find_helpers():
    reg = {"profiles": [{"id": "a", "name": "x"}, {"id": "b", "name": "y"}]}
    assert pr.find_by_id(reg, "b")["name"] == "y"
    assert pr.find_by_name(reg, "x")["id"] == "a"
    assert pr.find_by_id(reg, "z") is None
```

**Step 2: Run → FAIL.**

**Step 3: Implement**

```python
# gates/profiles.py
"""Named-profile registry + dir ops for the Image Pool. Stdlib only."""
import json
import os
import shutil
import zipfile
from pathlib import Path

REGISTRY_NAME = "profiles.json"


def registry_path(base):
    return Path(base) / REGISTRY_NAME


def empty_registry():
    return {"profiles": []}


def read_registry(base):
    p = registry_path(base)
    if not p.exists():
        return empty_registry()
    try:
        with open(p, "r", encoding="utf-8") as f:
            reg = json.load(f)
        if not isinstance(reg, dict) or "profiles" not in reg:
            raise ValueError("bad registry")
        return reg
    except (ValueError, json.JSONDecodeError):
        return empty_registry()


def write_registry(base, reg):
    Path(base).mkdir(parents=True, exist_ok=True)
    final = registry_path(base)
    tmp = final.with_name(REGISTRY_NAME + ".tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(reg, f, indent=2)
    os.replace(tmp, final)
    return reg


def find_by_id(reg, pid):
    return next((p for p in reg["profiles"] if p["id"] == pid), None)


def find_by_name(reg, name):
    return next((p for p in reg["profiles"] if p["name"] == name), None)
```

**Step 4: Run → PASS.**  **Step 5: Commit** `feat: profiles registry read/write + find`

---

### Task 2: `profiles.py` — `create_profile`

**Files:** Modify `gates/profiles.py`, `tests/test_profiles.py`

**Step 1: Failing test**

```python
def test_create_profile(tmp_path):
    e = pr.create_profile(str(tmp_path), "setA", "id1", ts=10)
    assert e == {"id": "id1", "name": "setA", "created": 10}
    assert (tmp_path / "id1").is_dir()
    assert pr.find_by_name(pr.read_registry(str(tmp_path)), "setA")["id"] == "id1"

def test_create_duplicate_name_raises(tmp_path):
    import pytest
    pr.create_profile(str(tmp_path), "setA", "id1")
    with pytest.raises(ValueError):
        pr.create_profile(str(tmp_path), "setA", "id2")
```

**Step 2: Run → FAIL.**

**Step 3: Implement (append)**

```python
def create_profile(base, name, pid, ts=0):
    reg = read_registry(base)
    if find_by_name(reg, name):
        raise ValueError(f"profile name already exists: {name}")
    (Path(base) / pid).mkdir(parents=True, exist_ok=True)
    entry = {"id": pid, "name": name, "created": ts}
    reg["profiles"].append(entry)
    write_registry(base, reg)
    return entry
```

**Step 4: Run → PASS.**  **Step 5: Commit** `feat: profiles create_profile`

---

### Task 3: `profiles.py` — `rename_profile`

**Step 1: Failing test**

```python
def test_rename_profile(tmp_path):
    pr.create_profile(str(tmp_path), "old", "id1")
    e = pr.rename_profile(str(tmp_path), "id1", "new")
    assert e["name"] == "new"
    assert pr.find_by_name(pr.read_registry(str(tmp_path)), "new")["id"] == "id1"

def test_rename_to_existing_name_raises(tmp_path):
    import pytest
    pr.create_profile(str(tmp_path), "a", "id1")
    pr.create_profile(str(tmp_path), "b", "id2")
    with pytest.raises(ValueError):
        pr.rename_profile(str(tmp_path), "id2", "a")
```

**Step 2: Run → FAIL.**  **Step 3: Implement (append)**

```python
def rename_profile(base, pid, name):
    reg = read_registry(base)
    entry = find_by_id(reg, pid)
    if not entry:
        raise KeyError(pid)
    other = find_by_name(reg, name)
    if other and other["id"] != pid:
        raise ValueError(f"profile name already exists: {name}")
    entry["name"] = name
    write_registry(base, reg)
    return entry
```

**Step 4: Run → PASS.**  **Step 5: Commit** `feat: profiles rename_profile`

---

### Task 4: `profiles.py` — `delete_profile`

**Step 1: Failing test**

```python
def test_delete_profile_removes_dir_and_entry(tmp_path):
    pr.create_profile(str(tmp_path), "a", "id1")
    (tmp_path / "id1" / "img_0001.png").write_bytes(b"x")
    pr.delete_profile(str(tmp_path), "id1")
    assert not (tmp_path / "id1").exists()
    assert pr.find_by_id(pr.read_registry(str(tmp_path)), "id1") is None
```

**Step 2: Run → FAIL.**  **Step 3: Implement (append)**

```python
def delete_profile(base, pid):
    reg = read_registry(base)
    reg["profiles"] = [p for p in reg["profiles"] if p["id"] != pid]
    write_registry(base, reg)
    d = Path(base) / pid
    if d.exists():
        shutil.rmtree(d)
    return reg
```

**Step 4: Run → PASS.**  **Step 5: Commit** `feat: profiles delete_profile`

---

### Task 5: `profiles.py` — `duplicate_profile`

**Step 1: Failing test**

```python
def test_duplicate_copies_images(tmp_path):
    pr.create_profile(str(tmp_path), "src", "id1")
    (tmp_path / "id1" / "img_0001.png").write_bytes(b"abc")
    e = pr.duplicate_profile(str(tmp_path), "id1", "copy", "id2", ts=5)
    assert e == {"id": "id2", "name": "copy", "created": 5}
    assert (tmp_path / "id2" / "img_0001.png").read_bytes() == b"abc"

def test_duplicate_duplicate_name_raises(tmp_path):
    import pytest
    pr.create_profile(str(tmp_path), "src", "id1")
    with pytest.raises(ValueError):
        pr.duplicate_profile(str(tmp_path), "id1", "src", "id2")
```

**Step 2: Run → FAIL.**  **Step 3: Implement (append)**

```python
def duplicate_profile(base, src_id, name, new_id, ts=0):
    reg = read_registry(base)
    if not find_by_id(reg, src_id):
        raise KeyError(src_id)
    if find_by_name(reg, name):
        raise ValueError(f"profile name already exists: {name}")
    src = Path(base) / src_id
    dst = Path(base) / new_id
    if src.exists():
        shutil.copytree(src, dst)
    else:
        dst.mkdir(parents=True, exist_ok=True)
    entry = {"id": new_id, "name": name, "created": ts}
    reg["profiles"].append(entry)
    write_registry(base, reg)
    return entry
```

**Step 4: Run → PASS.**  **Step 5: Commit** `feat: profiles duplicate_profile`

---

### Task 6: `profiles.py` — `export_profile` + `import_profile`

**Step 1: Failing test**

```python
def test_export_import_roundtrip(tmp_path):
    src_base = str(tmp_path / "a"); dst_base = str(tmp_path / "b")
    pr.create_profile(src_base, "setA", "id1", ts=1)
    from pathlib import Path
    (Path(src_base) / "id1" / "img_0001.png").write_bytes(b"hello")
    zpath = str(tmp_path / "setA.zip")
    pr.export_profile(src_base, "id1", zpath)
    assert (tmp_path / "setA.zip").exists()
    # import into a different base, fresh id
    e = pr.import_profile(dst_base, zpath, "id99", ts=2)
    assert e["id"] == "id99"
    assert e["name"] == "setA"                       # name carried in zip meta
    assert (Path(dst_base) / "id99" / "img_0001.png").read_bytes() == b"hello"

def test_import_name_collision_suffixes(tmp_path):
    base = str(tmp_path)
    pr.create_profile(base, "setA", "id1")
    from pathlib import Path
    (Path(base) / "id1" / "f.png").write_bytes(b"x")
    z = str(tmp_path / "e.zip"); pr.export_profile(base, "id1", z)
    e = pr.import_profile(base, z, "id2")
    assert e["name"] == "setA (2)"
```

**Step 2: Run → FAIL.**  **Step 3: Implement (append)**

```python
def export_profile(base, pid, dest_zip):
    src = Path(base) / pid
    if not src.exists():
        raise KeyError(pid)
    entry = find_by_id(read_registry(base), pid)
    name = entry["name"] if entry else pid
    with zipfile.ZipFile(dest_zip, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("profile_meta.json", json.dumps({"name": name}))
        for f in src.rglob("*"):
            if f.is_file():
                z.write(f, arcname=str(Path("pool") / f.relative_to(src)))
    return dest_zip


def import_profile(base, src_zip, new_id, name=None, ts=0):
    reg = read_registry(base)
    meta_name = None
    dst = Path(base) / new_id
    dst.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(src_zip) as z:
        names = z.namelist()
        if "profile_meta.json" in names:
            meta_name = json.loads(z.read("profile_meta.json")).get("name")
        for n in names:
            if n.startswith("pool/") and not n.endswith("/"):
                target = dst / n[len("pool/"):]
                target.parent.mkdir(parents=True, exist_ok=True)
                with z.open(n) as srcf, open(target, "wb") as out:
                    shutil.copyfileobj(srcf, out)
    final = name or meta_name or new_id
    candidate, i = final, 2
    while find_by_name(reg, candidate):
        candidate = f"{final} ({i})"
        i += 1
    entry = {"id": new_id, "name": candidate, "created": ts}
    reg["profiles"].append(entry)
    write_registry(base, reg)
    return entry
```

**Step 4: Run → PASS.**  **Step 5: Commit** `feat: profiles export/import (portable zip)`

---

### Task 7: `profile_node.py` — the `PoolProfile` node

**Files:** Create `gates/profile_node.py`; Test `tests/test_profile_node.py`

**Step 1: Failing test**

```python
# tests/test_profile_node.py
from gates import profile_node as pn

def test_io():
    assert pn.PoolProfile.RETURN_TYPES == ("POOL_PROFILE",)
    assert pn.PoolProfile.RETURN_NAMES == ("profile",)

def test_run_returns_id_or_default():
    assert pn.PoolProfile().run(profile="setA", profile_id="id1") == ("id1",)
    assert pn.PoolProfile().run(profile="", profile_id="") == ("default",)

def test_is_changed_tracks_id():
    assert pn.PoolProfile.IS_CHANGED(profile="x", profile_id="id1") == "id1"
```

**Step 2: Run → FAIL.**  **Step 3: Implement**

```python
# gates/profile_node.py
NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}


class PoolProfile:
    CATEGORY = "Datasete Gates"
    FUNCTION = "run"
    RETURN_TYPES = ("POOL_PROFILE",)
    RETURN_NAMES = ("profile",)

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "profile": ("STRING", {"default": ""}),      # name; JS renders a dropdown
                "profile_id": ("STRING", {"default": ""}),    # hidden, JS-owned id
            },
        }

    def run(self, profile, profile_id=""):
        return (profile_id or "default",)

    @classmethod
    def IS_CHANGED(cls, profile, profile_id="", **kwargs):
        return profile_id


NODE_CLASS_MAPPINGS = {"PoolProfile": PoolProfile}
NODE_DISPLAY_NAME_MAPPINGS = {"PoolProfile": "Pool Profile"}
```

**Step 4: Run → PASS.**  **Step 5: Commit** `feat: PoolProfile companion node`

---

### Task 8: `node.py` — optional `profile` input on the pool (MERGE)

**Files:** Modify `gates/node.py`, `tests/test_node.py`

**Step 1: Failing test** (add)

```python
def test_profile_input_overrides_pool_id(tmp_path, monkeypatch):
    base = str(tmp_path / "grid_pool")
    monkeypatch.setattr(node, "_grid_pool_base", lambda: base)
    import io
    from PIL import Image
    from gates import pool
    buf = io.BytesIO(); Image.new("RGB", (4, 6), (255, 0, 0)).save(buf, "PNG")
    pool.add_image(base, "prof1", buf.getvalue(), ts=1)   # images under the PROFILE id
    n = node.GridImagePool()
    # pool_id is "default" (empty) but profile points at prof1
    img, mask, idx, count, label = n.run(index=-1, pool_id="default", profile="prof1")
    assert count == 1 and idx == 0
```

**Step 2: Run → FAIL.**

**Step 3: Implement** — re-Read `gates/node.py`, then:
- In `INPUT_TYPES`, add an optional block:
  ```python
  "optional": {"profile": ("POOL_PROFILE",)},
  ```
- Compute the effective id wherever `pool_id` is used. Simplest: update `_resolve`, `run`,
  `IS_CHANGED` signatures to accept `profile=None` and resolve `effective = profile or pool_id`
  at the top, then use `effective` instead of `pool_id`:
  ```python
  def run(self, index, pool_id="default", profile=None):
      effective = profile or pool_id
      base, m, idx = self._resolve(index, effective)
      ...
      d = pool.pool_dir(base, effective)
      ...
  ```
  ```python
  @classmethod
  def IS_CHANGED(cls, index, pool_id="default", profile=None, **kwargs):
      effective = profile or pool_id
      base, m, idx = cls._resolve(index, effective)
      ...
      return imaging.change_hash(effective, f"{idx}:{m.get('active')}", mtimes)
  ```
  (`_resolve` already takes the id as its 2nd arg — pass `effective`.)

**Step 4: Run → PASS** (existing pool tests still pass).

**Step 5: Commit** `feat: Image Pool accepts optional POOL_PROFILE (profile or pool_id)`

---

### Task 9: `profiles_routes.py` — aiohttp glue + register (MERGE)

**Files:** Create `gates/profiles_routes.py`; Modify `__init__.py`

**Step 1: Implement `gates/profiles_routes.py`** (verified live, not unit-tested)

```python
# gates/profiles_routes.py
import os
import tempfile
import uuid

from aiohttp import web
from server import PromptServer

from . import profiles
from .gates_compat import grid_pool_base

routes = PromptServer.instance.routes


def _base():
    return grid_pool_base()


@routes.get("/grid_pool/profiles/list")
async def _list(request):
    return web.json_response(profiles.read_registry(_base()))


@routes.post("/grid_pool/profiles/create")
async def _create(request):
    body = await request.json()
    e = profiles.create_profile(_base(), body["name"], uuid.uuid4().hex)
    return web.json_response(e)


@routes.post("/grid_pool/profiles/rename")
async def _rename(request):
    body = await request.json()
    return web.json_response(profiles.rename_profile(_base(), body["id"], body["name"]))


@routes.post("/grid_pool/profiles/delete")
async def _delete(request):
    body = await request.json()
    return web.json_response(profiles.delete_profile(_base(), body["id"]))


@routes.post("/grid_pool/profiles/duplicate")
async def _duplicate(request):
    body = await request.json()
    e = profiles.duplicate_profile(_base(), body["id"], body["name"], uuid.uuid4().hex)
    return web.json_response(e)


@routes.get("/grid_pool/profiles/export")
async def _export(request):
    pid = request.query["id"]
    reg = profiles.read_registry(_base())
    entry = profiles.find_by_id(reg, pid)
    fname = (entry["name"] if entry else pid) + ".zip"
    tmp = os.path.join(tempfile.gettempdir(), f"profile_{pid}.zip")
    profiles.export_profile(_base(), pid, tmp)
    return web.FileResponse(tmp, headers={"Content-Disposition": f'attachment; filename="{fname}"'})


@routes.post("/grid_pool/profiles/import")
async def _import(request):
    reader = await request.multipart()
    tmp = os.path.join(tempfile.gettempdir(), f"import_{uuid.uuid4().hex}.zip")
    async for part in reader:
        if part.name == "file":
            with open(tmp, "wb") as f:
                while True:
                    chunk = await part.read_chunk()
                    if not chunk:
                        break
                    f.write(chunk)
    e = profiles.import_profile(_base(), tmp, uuid.uuid4().hex)
    return web.json_response(e)
```

**Step 2: Re-Read `__init__.py`** and merge the companion node + import the routes:

```python
    from .gates.profile_node import NODE_CLASS_MAPPINGS as _PROF_NODES, \
        NODE_DISPLAY_NAME_MAPPINGS as _PROF_NAMES
    from .gates import profiles_routes  # noqa: F401  (registers /grid_pool/profiles/*)
    NODE_CLASS_MAPPINGS = {**NODE_CLASS_MAPPINGS, **_PROF_NODES}
    NODE_DISPLAY_NAME_MAPPINGS = {**NODE_DISPLAY_NAME_MAPPINGS, **_PROF_NAMES}
```

**Step 3:** `$PY -c "import gates.profile_node; print(gates.profile_node.NODE_CLASS_MAPPINGS)"`.

**Step 4:** Full suite green: `$PY -m pytest tests/ -v`.

**Step 5: Commit** `feat: profiles routes + register PoolProfile`

---

### Task 10: `web/pool_profile.js` — dropdown, actions, propagation

**Files:** Create `web/pool_profile.js`

`app.registerExtension` for `PoolProfile`:
- Replace the `profile` STRING widget with a **combo** populated from `GET
  /grid_pool/profiles/list`; keep a hidden `profile_id` widget (mint/sync like `pool_id`).
- Action buttons: **Create** (prompt name → POST create), **Rename**, **Delete** (confirm),
  **Duplicate** (prompt name), **Export** (`window.open('/grid_pool/profiles/export?id=...')`),
  **Import** (hidden file input → multipart POST → refresh). After each, re-list + reselect.
- On selection change: set `profile_id`, then **propagate** — for each link from this node's
  `POOL_PROFILE` output, find the target pool node, set its hidden `pool_id` widget to the id,
  and call `node._datasetePoolRefresh?.()`. Also propagate on `onConnectionsChange` when the
  output gets connected. (Model on `ComfyUI-JSON-Manager/web/project_key.js`.)

**Manual verify:** dropdown lists profiles; create adds one; selecting updates a connected
pool's grid live.

**Commit** `feat: pool profile frontend — dropdown, actions, cross-node propagation`

---

### Task 11: `grid_image_pool.js` — accept `profile` input + refresh hook

**Files:** Modify `web/grid_image_pool.js`

- Expose `node._datasetePoolRefresh = () => refresh(node)` in the pool's `nodeCreated` so the
  companion can trigger a grid reload.
- No other change required: propagation sets the pool's existing `pool_id` widget, and the
  grid/routes already key off `getPoolId(node)`. (Optional: when the `profile` input is
  disconnected, leave the last id in place.)

**Manual verify:** selecting in the companion repaints the pool grid with the profile's images.

**Commit** `feat: pool grid exposes refresh hook for profile sync`

---

### Task 12: Live smoke test in ComfyUI

Restart ComfyUI. Drop `Pool Profile` + `Image Pool (Grid)`, wire profile→profile. Verify:
- [ ] Both nodes appear under "Datasete Gates".
- [ ] Create profile "A" → folder + registry entry appear; dropdown shows "A".
- [ ] Add images to the pool → they land under the profile's id dir.
- [ ] Create "B", switch → pool grid switches live (empty); switch back to "A" → images return.
- [ ] In a **new** workflow, add both nodes, select "A" → the same images load.
- [ ] Rename / Delete / Duplicate behave; duplicate copies images.
- [ ] Export "A" downloads a zip; Import it → a new profile with the same images.
- [ ] A pool with **no** profile connected still works (per-node UUID, unchanged).
- [ ] Run the graph → IMAGE/MASK come from the selected profile's active slot.

**Commit** (if fixes) `fix: pool profiles live-test adjustments`

---

## Definition of done

- `$PY -m pytest tests/test_profiles.py tests/test_profile_node.py -v` green; full `tests/`
  green (existing pool/gate/loader unaffected).
- Manual checklist passes: create/select with live grid switch, reuse across workflows,
  rename/delete/duplicate, export/import round-trip, backward-compatible unconnected pools.
