"""BucketResize node: cover-crop an image (and optional mask) onto a Klein
training bucket. Pure compute (torch + PIL); no comfy imports in run()."""
import numpy as np
import torch
from PIL import Image

from . import buckets

NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}


def _resize_crop_pil(pil, new_w, new_h, left, top, W, H):
    pil = pil.resize((new_w, new_h), Image.LANCZOS)
    return pil.crop((left, top, left + W, top + H))


def fit_image(image, W, H):
    """image [B,H,W,3] -> [B,H,W,3] at (W,H) using the first image's geometry."""
    b, ih, iw = image.shape[0], image.shape[1], image.shape[2]
    new_w, new_h, left, top, scale = buckets.cover_crop_params(iw, ih, W, H)
    out = []
    for i in range(b):
        arr = (image[i].cpu().numpy() * 255.0).clip(0, 255).astype("uint8")
        pil = _resize_crop_pil(Image.fromarray(arr), new_w, new_h, left, top, W, H)
        out.append(torch.from_numpy(np.array(pil, dtype=np.float32) / 255.0))
    return torch.stack(out, 0), scale


def fit_mask(mask, W, H):
    b, ih, iw = mask.shape[0], mask.shape[1], mask.shape[2]
    new_w, new_h, left, top, _ = buckets.cover_crop_params(iw, ih, W, H)
    out = []
    for i in range(b):
        arr = (mask[i].cpu().numpy() * 255.0).clip(0, 255).astype("uint8")
        pil = _resize_crop_pil(Image.fromarray(arr), new_w, new_h, left, top, W, H)
        out.append(torch.from_numpy(np.array(pil, dtype=np.float32) / 255.0))
    return torch.stack(out, 0)


class BucketResize:
    CATEGORY = "Dataset Gates"
    FUNCTION = "run"
    RETURN_TYPES = ("IMAGE", "MASK", "INT", "INT", "STRING")
    RETURN_NAMES = ("image", "mask", "width", "height", "label")

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image": ("IMAGE",),
                "resolution": ("INT", {"default": 1280, "min": 64, "max": 8192}),
                "divisible": ("INT", {"default": 64, "min": 8, "max": 256}),
                "max_upscale": ("FLOAT", {"default": 1.5, "min": 1.0, "max": 8.0, "step": 0.1}),
            },
            "optional": {"mask": ("MASK",)},
        }

    def run(self, image, resolution=1280, divisible=64, max_upscale=1.5, mask=None):
        ih, iw = int(image.shape[1]), int(image.shape[2])
        W, H = buckets.pick_bucket(iw, ih, resolution, divisible)
        out_img, scale = fit_image(image, W, H)
        if scale > max_upscale:
            print(f"[BucketResize] cover scale {scale:.2f}x exceeds max_upscale "
                  f"{max_upscale} for {iw}x{ih} -> {W}x{H}")
        out_mask = fit_mask(mask, W, H) if mask is not None \
            else torch.zeros((out_img.shape[0], H, W), dtype=torch.float32)
        return (out_img, out_mask, W, H, f"{W}x{H}")


NODE_CLASS_MAPPINGS = {"BucketResize": BucketResize}
NODE_DISPLAY_NAME_MAPPINGS = {"BucketResize": "Bucket Resize (Klein 9B)"}
