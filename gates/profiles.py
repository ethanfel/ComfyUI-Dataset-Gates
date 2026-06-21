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
