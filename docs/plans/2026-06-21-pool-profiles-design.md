# Pool Profiles (companion node) — Design

Date: 2026-06-21
Status: Approved (brainstorming complete, ready for implementation plan)

## 1. Purpose

Make Image Pool contents durable and reusable across workflows via named **profiles**.
A companion node `Pool Profile` creates/selects/manages named profiles and feeds the chosen
one into an Image Pool node, so the same set of images (with their masks/labels) can be
reloaded in any workflow by picking the profile. Profiles are also portable (zip
export/import) to move between machines.

## 2. Storage / registry

`input/grid_pool/profiles.json` maps a friendly **name → stable id**:

```json
{ "profiles": [ {"id": "<uuid>", "name": "characters_A", "created": 1718960000} ] }
```

Each profile's data stays in the existing layout `input/grid_pool/<id>/` (manifest.json +
images + masks). **Backward compatible:** existing random-UUID pools are simply unregistered
ids and keep working unchanged.

## 3. Nodes

### `Pool Profile` (companion, new)
- Widgets: `profile` (dropdown of names, JS-populated) + hidden `profile_id` (JS-owned, like
  `pool_id`).
- Buttons: **Create, Rename, Delete, Duplicate/Save-as, Export, Import**.
- Output: `POOL_PROFILE` = the selected profile id.
- `run()` returns `profile_id or "default"`; `IS_CHANGED` returns `profile_id` (so a
  selection change re-runs downstream).

### `Image Pool (Grid)` (existing, change — backward compatible)
- New **optional input `profile`** (`POOL_PROFILE`).
- `run()`/`_resolve()`/`IS_CHANGED` use `effective = profile or pool_id` (connected id wins).
- With nothing connected, behaves exactly as today (per-node UUID).

## 4. Live edit-time sync (key UX)

Modeled on `ComfyUI-JSON-Manager/web/project_key.js`: when the companion's selection changes
(or on connect), it walks its `POOL_PROFILE` output links, sets each connected pool node's
hidden `pool_id` widget to the profile id, and calls that pool's refresh. So selecting a
profile instantly shows its images in the grid, and adds/masks land in that profile. The
pool JS exposes a `node._datasetePoolRefresh()` hook for the companion to call.

## 5. Server routes (`/grid_pool/profiles/*`)

`list` (GET), `create` `{name}`, `rename` `{id,name}`, `delete` `{id}`, `duplicate`
`{id,name}`, `export` (GET `?id=` → streams a zip), `import` (multipart zip [+name] → new id).
The route layer generates UUIDs; the pure layer takes ids as params (testable).

## 6. Code shape

- `gates/profiles.py` — pure stdlib: registry read/write (atomic), `find_by_id/name`,
  `create/rename/delete/duplicate`, and `export_profile`/`import_profile` (zipfile). Unit-
  testable with tmp dirs; no comfy/torch.
- `gates/profiles_routes.py` — aiohttp glue (uuid gen, file streaming).
- `gates/profile_node.py` — the `PoolProfile` node.
- `web/pool_profile.js` — dropdown + action buttons + cross-node propagation.
- `gates/node.py` + `web/grid_image_pool.js` — small additive tweak: optional `profile`
  input, `effective` id, and the `_datasetePoolRefresh` hook.

## 7. Edge cases

- Duplicate/import name collision → auto-suffix `name (2)`; create/rename reject duplicates.
- Delete removes the dir (`shutil.rmtree`) and the registry entry.
- Corrupt/missing `profiles.json` → treated as empty registry.
- Import zip carries a `profile_meta.json` (original name) under an internal `pool/` prefix;
  imported under a fresh id so it never clobbers an existing profile.
- Profile connected then disconnected → pool keeps the last id (the profile); no data loss.

## 8. Phasing & testing

- **Phase 1**: `profiles.py` (registry + create/select) + `PoolProfile` node + routes +
  frontend dropdown + live sync into the pool.
- **Phase 2**: rename / delete / duplicate.
- **Phase 3**: export / import (portable zip).
- **Phase 4 (optional)**: "adopt" an existing unnamed pool into a profile.

Testing: pytest for `profiles.py` (CRUD, duplicate copies images, export→import round-trips a
profile with its files); manual for dropdown, cross-node propagation, and the zip UI.
