"""Pure storage layer for the Image Pool node. Stdlib only — no torch, no comfy."""
import json
import os
from pathlib import Path


def empty_manifest():
    return {"active": 0, "slots": [], "next_seq": 1}


def pool_dir(base_dir, pool_id):
    return Path(base_dir) / pool_id


def manifest_path(base_dir, pool_id):
    return pool_dir(base_dir, pool_id) / "manifest.json"


def read_manifest(base_dir, pool_id):
    p = manifest_path(base_dir, pool_id)
    if not p.exists():
        return empty_manifest()
    try:
        with open(p, "r", encoding="utf-8") as f:
            m = json.load(f)
        # minimal shape guard
        if not isinstance(m, dict) or "slots" not in m:
            raise ValueError("bad manifest")
        m.setdefault("active", 0)
        m.setdefault("next_seq", len(m.get("slots", [])) + 1)
        return m
    except (ValueError, json.JSONDecodeError):
        return rebuild_manifest(base_dir, pool_id)


def write_manifest(base_dir, pool_id, manifest):
    d = pool_dir(base_dir, pool_id)
    d.mkdir(parents=True, exist_ok=True)
    final = d / "manifest.json"
    tmp = d / "manifest.json.tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2)
    os.replace(tmp, final)  # atomic on same filesystem
    return manifest


def next_image_name(manifest):
    return f"img_{manifest.get('next_seq', 1):04d}.png"


def add_image(base_dir, pool_id, data, ts=0):
    m = read_manifest(base_dir, pool_id)
    name = next_image_name(m)
    d = pool_dir(base_dir, pool_id)
    d.mkdir(parents=True, exist_ok=True)
    with open(d / name, "wb") as f:
        f.write(data)
    m["slots"].append({"image": name, "mask": None, "label": "", "added": ts})
    m["next_seq"] = m.get("next_seq", 1) + 1
    write_manifest(base_dir, pool_id, m)
    return m


def remove_slot(base_dir, pool_id, index):
    m = read_manifest(base_dir, pool_id)
    if index < 0 or index >= len(m["slots"]):
        return m
    slot = m["slots"].pop(index)
    d = pool_dir(base_dir, pool_id)
    for key in ("image", "mask"):
        name = slot.get(key)
        if name:
            f = d / name
            if f.exists():
                f.unlink()
    if index < m["active"]:
        m["active"] -= 1
    m["active"] = _clamp_active(m)
    write_manifest(base_dir, pool_id, m)
    return m


def _clamp_active(m):
    n = len(m["slots"])
    if n == 0:
        return 0
    return max(0, min(m.get("active", 0), n - 1))


def set_active(base_dir, pool_id, index):
    m = read_manifest(base_dir, pool_id)
    m["active"] = index
    m["active"] = _clamp_active(m)
    write_manifest(base_dir, pool_id, m)
    return m


def resolve_slot(manifest, index_widget):
    n = len(manifest["slots"])
    if n == 0:
        return -1
    idx = manifest.get("active", 0) if index_widget == -1 else index_widget
    return max(0, min(idx, n - 1))


def set_label(base_dir, pool_id, index, label):
    m = read_manifest(base_dir, pool_id)
    if 0 <= index < len(m["slots"]):
        m["slots"][index]["label"] = str(label)
        write_manifest(base_dir, pool_id, m)
    return m


def rebuild_manifest(base_dir, pool_id):
    # Temporary stub — replaced in Task 7.
    return empty_manifest()
