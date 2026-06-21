# gates/gate.py
import io
import math

import numpy as np
import torch
from PIL import Image

from . import gate_bus

MAX_ROUTES = 10


def route_tuple(chosen, image, blocker, max_routes=MAX_ROUTES):
    return tuple(image if i == chosen else blocker for i in range(max_routes))


def mask_from_stash(data, image):
    b, h, w = image.shape[0], image.shape[1], image.shape[2]
    if not data:
        return torch.zeros((b, h, w), dtype=torch.float32)
    m = Image.open(io.BytesIO(data)).convert("L")
    arr = np.array(m, dtype=np.float32) / 255.0
    return torch.from_numpy(arr).unsqueeze(0)


class ImageGate:
    CATEGORY = "Datasete Gates"
    FUNCTION = "run"
    RETURN_TYPES = ("MASK",) + ("IMAGE",) * MAX_ROUTES
    RETURN_NAMES = ("mask",) + tuple(f"route_{i + 1}" for i in range(MAX_ROUTES))

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image": ("IMAGE",),
                "routes": ("INT", {"default": 2, "min": 1, "max": MAX_ROUTES}),
            },
            "hidden": {"unique_id": "UNIQUE_ID"},
        }

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        return float("nan")            # always pause; never cached

    def run(self, image, routes, unique_id):
        from comfy_execution.graph_utils import ExecutionBlocker
        from . import gate_server

        gate_bus.GateBus.arm(unique_id)
        gate_server.send_preview(unique_id, image, routes)
        try:
            chosen_1 = gate_bus.GateBus.wait(unique_id)
        except gate_bus.GateCancelled:
            import comfy.model_management as mm
            raise mm.InterruptProcessingException()

        mask = mask_from_stash(gate_bus.GateBus.pop_mask(unique_id), image)
        chosen = max(0, min(chosen_1 - 1, routes - 1))
        blocker = ExecutionBlocker(None)
        return (mask,) + route_tuple(chosen, image, blocker, MAX_ROUTES)


NODE_CLASS_MAPPINGS = {"ImageGate": ImageGate}
NODE_DISPLAY_NAME_MAPPINGS = {"ImageGate": "Image Gate (Manual Router)"}
