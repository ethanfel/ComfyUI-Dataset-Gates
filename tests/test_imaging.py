import numpy as np, torch
from PIL import Image
from gates import imaging


def _png(tmp_path, name, color, size=(4, 6)):  # size = (w, h)
    p = tmp_path / name
    Image.new("RGB", size, color).save(p)
    return str(p)


def test_load_image_tensor_shape_and_range(tmp_path):
    t = imaging.load_image_tensor(_png(tmp_path, "a.png", (255, 0, 0)))
    assert t.shape == (1, 6, 4, 3)         # [B,H,W,C]
    assert t.dtype == torch.float32
    assert 0.0 <= float(t.min()) and float(t.max()) <= 1.0
    assert float(t[0, 0, 0, 0]) > 0.99     # red channel


def test_load_mask_none_is_zeros():
    m = imaging.load_mask_tensor(None, h=6, w=4)
    assert m.shape == (1, 6, 4)
    assert float(m.max()) == 0.0


def test_load_mask_from_file(tmp_path):
    p = tmp_path / "m.png"
    Image.new("L", (4, 6), 255).save(p)
    m = imaging.load_mask_tensor(str(p), h=6, w=4)
    assert m.shape == (1, 6, 4)
    assert float(m.min()) > 0.99


def test_empty_image_is_1x1_black():
    img, mask = imaging.empty_outputs()
    assert img.shape == (1, 1, 1, 3) and float(img.max()) == 0.0
    assert mask.shape == (1, 1, 1)


def test_change_hash_changes_with_mtime():
    h1 = imaging.change_hash("p", 0, [1000.0])
    h2 = imaging.change_hash("p", 0, [1001.0])
    assert h1 != h2
