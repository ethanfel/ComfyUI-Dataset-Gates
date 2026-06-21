"""GridImagePool — the Image Pool (Grid) ComfyUI node."""
import os
from .gates_compat import grid_pool_base as _grid_pool_base
from . import pool, imaging

NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}


class GridImagePool:
    CATEGORY = "Datasete Gates"
    FUNCTION = "run"
    RETURN_TYPES = ("IMAGE", "MASK", "INT", "INT", "STRING")
    RETURN_NAMES = ("image", "mask", "index", "count", "label")

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "index": ("INT", {"default": -1, "min": -1, "max": 9999}),
            },
            "hidden": {"pool_id": "POOL_ID"},
        }

    @staticmethod
    def _resolve(index, pool_id):
        base = _grid_pool_base()
        m = pool.read_manifest(base, pool_id)
        idx = pool.resolve_slot(m, index)
        return base, m, idx

    def run(self, index, pool_id="default"):
        base, m, idx = self._resolve(index, pool_id)
        if idx < 0:
            img, mask = imaging.empty_outputs()
            return (img, mask, 0, 0, "")
        slot = m["slots"][idx]
        d = pool.pool_dir(base, pool_id)
        img = imaging.load_image_tensor(str(d / slot["image"]))
        h, w = int(img.shape[1]), int(img.shape[2])
        mask_name = slot.get("mask")
        mask = imaging.load_mask_tensor(str(d / mask_name) if mask_name else None, h, w)
        return (img, mask, idx, len(m["slots"]), slot.get("label", ""))

    @classmethod
    def IS_CHANGED(cls, index, pool_id="default", **kwargs):
        base, m, idx = cls._resolve(index, pool_id)
        if idx < 0:
            return imaging.change_hash(pool_id, -1, [])
        slot = m["slots"][idx]
        d = pool.pool_dir(base, pool_id)
        mtimes = []
        for key in ("image", "mask"):
            name = slot.get(key)
            p = d / name if name else None
            mtimes.append(os.path.getmtime(p) if p and p.exists() else 0.0)
        # include active so manual selection changes invalidate cache
        return imaging.change_hash(pool_id, f"{idx}:{m.get('active')}", mtimes)


NODE_CLASS_MAPPINGS = {"GridImagePool": GridImagePool}
NODE_DISPLAY_NAME_MAPPINGS = {"GridImagePool": "Image Pool (Grid)"}
