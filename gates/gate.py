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
