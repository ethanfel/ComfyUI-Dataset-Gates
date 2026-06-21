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
