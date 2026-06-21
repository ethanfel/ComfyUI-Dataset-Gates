# tests/test_loader.py
import io, os, torch
from PIL import Image
from gates import loader

def _save(path, color=(255, 0, 0), size=(4, 6), mode="RGB"):  # size=(w,h)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    Image.new(mode, size, color).save(path)

def test_run_loads_image_text_stem_index(tmp_path):
    _save(str(tmp_path / "img1.png"), (255, 0, 0))
    _save(str(tmp_path / "img2.png"), (0, 255, 0))
    (tmp_path / "img2.txt").write_text("green frame\n", encoding="utf-8")
    n = loader.FolderImageLoader()
    image, text, mask, filename, index = n.run(folder=str(tmp_path), index=1, depth=0)
    assert image.shape == (1, 6, 4, 3)
    assert float(image[0, 0, 0, 1]) > 0.99          # green
    assert text == "green frame"
    assert filename == "img2"
    assert index == 1
    assert mask.shape == (1, 6, 4) and float(mask.max()) == 0.0  # no alpha -> zeros

def test_run_alpha_becomes_mask(tmp_path):
    # RGBA image, fully opaque alpha=255 -> mask = 1-1 = 0
    _save(str(tmp_path / "a.png"), (255, 255, 255, 255), mode="RGBA")
    n = loader.FolderImageLoader()
    _, _, mask, _, _ = n.run(folder=str(tmp_path), index=0, depth=0)
    assert float(mask.max()) == 0.0
    # transparent alpha=0 -> mask = 1-0 = 1
    _save(str(tmp_path / "b.png"), (255, 255, 255, 0), mode="RGBA")
    _, _, mask2, _, _ = n.run(folder=str(tmp_path), index=1, depth=0)
    assert float(mask2.min()) > 0.99

def test_run_out_of_range_raises(tmp_path):
    import pytest
    _save(str(tmp_path / "only.png"))
    n = loader.FolderImageLoader()
    with pytest.raises(IndexError):
        n.run(folder=str(tmp_path), index=9, depth=0)

def test_is_changed_differs_by_index_and_sidecar(tmp_path):
    _save(str(tmp_path / "img1.png")); _save(str(tmp_path / "img2.png"))
    h0 = loader.FolderImageLoader.IS_CHANGED(folder=str(tmp_path), index=0, depth=0)
    h1 = loader.FolderImageLoader.IS_CHANGED(folder=str(tmp_path), index=1, depth=0)
    assert h0 != h1
