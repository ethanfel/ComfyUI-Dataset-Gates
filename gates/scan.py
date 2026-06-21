"""Pure folder-scan layer for Folder Image Loader. Stdlib only — no torch."""
import os
import re
from pathlib import Path

IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tif", ".tiff"}


def natural_key(s):
    return [int(t) if t.isdigit() else t.lower() for t in re.split(r"(\d+)", s)]


def list_images(folder, depth=0):
    root = Path(folder)
    if not root.is_dir():
        raise NotADirectoryError(f"Not a folder: {folder}")
    root_depth = len(root.parts)
    results = []
    for dirpath, dirnames, filenames in os.walk(root):
        cur = Path(dirpath)
        rel_depth = len(cur.parts) - root_depth
        if depth >= 0 and rel_depth >= depth:
            dirnames[:] = []                    # don't descend past `depth`
        if depth >= 0 and rel_depth > depth:
            continue
        for name in filenames:
            if Path(name).suffix.lower() in IMAGE_EXTS:
                results.append(str(cur / name))
    results.sort(key=lambda p: natural_key(os.path.relpath(p, root)))
    return results


def resolve_index(count, index):
    if count == 0:
        raise FileNotFoundError("No images found in folder")
    if index < 0 or index >= count:
        raise IndexError(f"index {index} out of range: {count} images")
    return index
