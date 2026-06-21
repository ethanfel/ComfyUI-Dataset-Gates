import io
from PIL import Image
from gates import handlers


def _png_bytes(color=(1, 2, 3)):
    b = io.BytesIO(); Image.new("RGB", (4, 4), color).save(b, "PNG"); return b.getvalue()


def test_handle_add_then_list(tmp_path):
    base = str(tmp_path)
    m = handlers.handle_add(base, "p1", _png_bytes(), "png", ts=5)
    assert len(m["slots"]) == 1
    assert handlers.handle_list(base, "p1")["slots"][0]["image"] == "img_0001.png"


def test_handle_active_label_remove(tmp_path):
    base = str(tmp_path)
    handlers.handle_add(base, "p1", _png_bytes(), "png", ts=1)
    handlers.handle_add(base, "p1", _png_bytes(), "png", ts=2)
    assert handlers.handle_active(base, "p1", 1)["active"] == 1
    assert handlers.handle_label(base, "p1", 0, "hi")["slots"][0]["label"] == "hi"
    assert len(handlers.handle_remove(base, "p1", 0)["slots"]) == 1
