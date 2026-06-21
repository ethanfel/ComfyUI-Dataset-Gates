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


def create_profile(base, name, pid, ts=0):
    reg = read_registry(base)
    if find_by_name(reg, name):
        raise ValueError(f"profile name already exists: {name}")
    (Path(base) / pid).mkdir(parents=True, exist_ok=True)
    entry = {"id": pid, "name": name, "created": ts}
    reg["profiles"].append(entry)
    write_registry(base, reg)
    return entry


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


def delete_profile(base, pid):
    reg = read_registry(base)
    reg["profiles"] = [p for p in reg["profiles"] if p["id"] != pid]
    write_registry(base, reg)
    d = Path(base) / pid
    if d.exists():
        shutil.rmtree(d)
    return reg


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
