"""Tensor/imaging helpers (torch + PIL). No comfy imports."""
import hashlib
import numpy as np
import torch
from PIL import Image, ImageOps


def load_image_tensor(path):
    img = Image.open(path)
    img = ImageOps.exif_transpose(img).convert("RGB")
    arr = np.array(img, dtype=np.float32) / 255.0
    return torch.from_numpy(arr).unsqueeze(0)          # [1,H,W,3]


def load_mask_tensor(path, h, w):
    if not path:
        return torch.zeros((1, h, w), dtype=torch.float32)
    m = Image.open(path).convert("L")
    arr = np.array(m, dtype=np.float32) / 255.0
    return torch.from_numpy(arr).unsqueeze(0)          # [1,H,W]


def empty_outputs():
    return (torch.zeros((1, 1, 1, 3), dtype=torch.float32),
            torch.zeros((1, 1, 1), dtype=torch.float32))


def change_hash(pool_id, index, mtimes):
    key = f"{pool_id}|{index}|" + "|".join(f"{t:.3f}" for t in mtimes)
    return hashlib.sha256(key.encode()).hexdigest()
