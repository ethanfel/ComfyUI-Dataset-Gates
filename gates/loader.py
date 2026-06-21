# gates/loader.py
import hashlib
import os

import numpy as np
import torch
from PIL import Image, ImageOps

from . import scan

NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}


def load_image_and_mask(path):
    img = Image.open(path)
    img = ImageOps.exif_transpose(img)
    arr = np.array(img.convert("RGB"), dtype=np.float32) / 255.0
    image = torch.from_numpy(arr).unsqueeze(0)              # [1,H,W,3]
    h, w = arr.shape[0], arr.shape[1]
    if "A" in img.getbands():
        a = np.array(img.getchannel("A"), dtype=np.float32) / 255.0
        mask = (1.0 - torch.from_numpy(a)).unsqueeze(0)     # [1,H,W]
    else:
        mask = torch.zeros((1, h, w), dtype=torch.float32)
    return image, mask


class FolderImageLoader:
    CATEGORY = "Datasete Gates"
    FUNCTION = "run"
    RETURN_TYPES = ("IMAGE", "STRING", "MASK", "STRING", "INT")
    RETURN_NAMES = ("image", "text", "mask", "filename", "index")

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "folder": ("STRING", {"default": ""}),
                "index": ("INT", {"default": 0, "min": 0,
                                  "max": 0xffffffffffffffff,
                                  "control_after_generate": True}),
                "depth": ("INT", {"default": 0, "min": -1, "max": 64}),
            }
        }

    def run(self, folder, index, depth=0):
        files = scan.list_images(folder, depth)
        idx = scan.resolve_index(len(files), index)
        path = files[idx]
        image, mask = load_image_and_mask(path)
        return (image, scan.read_sidecar(path), mask, scan.stem(path), idx)

    @classmethod
    def IS_CHANGED(cls, folder, index, depth=0, **kwargs):
        try:
            files = scan.list_images(folder, depth)
            idx = scan.resolve_index(len(files), index)
            path = files[idx]
            sc = scan.sidecar_path(path)
            parts = [folder, str(depth), str(idx),
                     str(os.path.getmtime(path)),
                     str(os.path.getmtime(sc)) if os.path.isfile(sc) else "0"]
        except Exception as e:  # surface errors as a changed hash, not a crash here
            parts = [folder, str(depth), str(index), f"err:{e}"]
        return hashlib.sha256("|".join(parts).encode()).hexdigest()


NODE_CLASS_MAPPINGS = {"FolderImageLoader": FolderImageLoader}
NODE_DISPLAY_NAME_MAPPINGS = {"FolderImageLoader": "Folder Image Loader"}
