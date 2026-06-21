# tests/test_gate.py
import io
import math

import torch
from PIL import Image

from gates import gate

def test_route_tuple_places_image_at_chosen():
    B = object()
    t = gate.route_tuple(2, "IMG", B, max_routes=5)
    assert t == (B, B, "IMG", B, B)

def test_route_tuple_length_is_max():
    B = object()
    assert len(gate.route_tuple(0, "IMG", B, max_routes=10)) == 10

def test_mask_from_stash_none_is_zeros():
    img = torch.zeros((1, 6, 4, 3))
    m = gate.mask_from_stash(None, img)
    assert m.shape == (1, 6, 4) and float(m.max()) == 0.0

def test_mask_from_stash_decodes_png():
    buf = io.BytesIO(); Image.new("L", (4, 6), 255).save(buf, "PNG")
    img = torch.zeros((1, 6, 4, 3))
    m = gate.mask_from_stash(buf.getvalue(), img)
    assert m.shape == (1, 6, 4) and float(m.min()) > 0.99

def test_is_changed_always_nan():
    v = gate.ImageGate.IS_CHANGED(image=None, routes=2, unique_id="1")
    assert math.isnan(v)

def test_return_types_shape():
    assert gate.ImageGate.RETURN_TYPES[0] == "MASK"
    assert len(gate.ImageGate.RETURN_TYPES) == gate.MAX_ROUTES + 1
    assert all(t == "IMAGE" for t in gate.ImageGate.RETURN_TYPES[1:])
