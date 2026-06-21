import io
import numpy as np, torch
from PIL import Image
from gates import node, pool


def _seed_pool(tmp_path, monkeypatch):
    base = str(tmp_path / "grid_pool")
    monkeypatch.setattr(node, "_grid_pool_base", lambda: base)
    return base


def _add_png(base, pid, name_bytes_color, ts):
    # write a real PNG via pool.add_image
    buf = io.BytesIO(); Image.new("RGB", (4, 6), name_bytes_color).save(buf, "PNG")
    return pool.add_image(base, pid, buf.getvalue(), ts=ts)


def test_execute_empty_pool_returns_blank(tmp_path, monkeypatch):
    _seed_pool(tmp_path, monkeypatch)
    n = node.GridImagePool()
    img, mask, idx, count, label = n.run(index=-1, pool_id="p1")
    assert img.shape == (1, 1, 1, 3)
    assert count == 0 and idx == 0 and label == ""


def test_execute_selects_active(tmp_path, monkeypatch):
    base = _seed_pool(tmp_path, monkeypatch)
    _add_png(base, "p1", (255, 0, 0), 1)
    _add_png(base, "p1", (0, 255, 0), 2)
    pool.set_active(base, "p1", 1)
    pool.set_label(base, "p1", 1, "green")
    n = node.GridImagePool()
    img, mask, idx, count, label = n.run(index=-1, pool_id="p1")
    assert img.shape == (1, 6, 4, 3)
    assert idx == 1 and count == 2 and label == "green"
    assert float(img[0, 0, 0, 1]) > 0.99      # green channel
    assert float(mask.max()) == 0.0           # no mask yet


def test_execute_forced_index_clamps(tmp_path, monkeypatch):
    base = _seed_pool(tmp_path, monkeypatch)
    _add_png(base, "p1", (255, 0, 0), 1)
    n = node.GridImagePool()
    _, _, idx, count, _ = n.run(index=9, pool_id="p1")
    assert idx == 0 and count == 1


def test_is_changed_differs_after_active_change(tmp_path, monkeypatch):
    base = _seed_pool(tmp_path, monkeypatch)
    _add_png(base, "p1", (255, 0, 0), 1)
    _add_png(base, "p1", (0, 255, 0), 2)
    h1 = node.GridImagePool.IS_CHANGED(index=-1, pool_id="p1")
    pool.set_active(base, "p1", 1)
    h2 = node.GridImagePool.IS_CHANGED(index=-1, pool_id="p1")
    assert h1 != h2


def test_profile_input_overrides_pool_id(tmp_path, monkeypatch):
    base = str(tmp_path / "grid_pool")
    monkeypatch.setattr(node, "_grid_pool_base", lambda: base)
    import io
    from PIL import Image
    from gates import pool
    buf = io.BytesIO(); Image.new("RGB", (4, 6), (255, 0, 0)).save(buf, "PNG")
    pool.add_image(base, "prof1", buf.getvalue(), ts=1)   # images under the PROFILE id
    n = node.GridImagePool()
    # pool_id is "default" (empty) but profile points at prof1
    img, mask, idx, count, label = n.run(index=-1, pool_id="default", profile="prof1")
    assert count == 1 and idx == 0
