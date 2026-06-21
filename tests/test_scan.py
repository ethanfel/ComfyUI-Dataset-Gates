# tests/test_scan.py
from gates import scan

def _touch(p, data=b"x"):
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_bytes(data)

def test_natural_sort_orders_numerically():
    items = ["img10.png", "img2.png", "img1.png"]
    assert sorted(items, key=scan.natural_key) == ["img1.png", "img2.png", "img10.png"]

def test_list_images_top_level_only_default(tmp_path):
    _touch(tmp_path / "a.png"); _touch(tmp_path / "b.jpg"); _touch(tmp_path / "note.txt")
    _touch(tmp_path / "sub" / "c.png")
    got = [p.split("/")[-1] for p in scan.list_images(str(tmp_path))]
    assert got == ["a.png", "b.jpg"]            # depth 0: no sub/, no .txt

def test_list_images_depth_one(tmp_path):
    _touch(tmp_path / "a.png")
    _touch(tmp_path / "sub" / "c.png")
    _touch(tmp_path / "sub" / "deep" / "d.png")
    got = [p.split("/")[-1] for p in scan.list_images(str(tmp_path), depth=1)]
    assert got == ["a.png", "c.png"]            # depth 1: include sub/, not sub/deep/

def test_list_images_unlimited_depth(tmp_path):
    _touch(tmp_path / "a.png"); _touch(tmp_path / "sub" / "deep" / "d.png")
    got = scan.list_images(str(tmp_path), depth=-1)
    assert len(got) == 2

def test_list_images_natural_sort_by_relpath(tmp_path):
    for n in ["img1.png", "img2.png", "img10.png"]:
        _touch(tmp_path / n)
    got = [p.split("/")[-1] for p in scan.list_images(str(tmp_path))]
    assert got == ["img1.png", "img2.png", "img10.png"]

def test_list_images_bad_path_raises(tmp_path):
    import pytest
    with pytest.raises(NotADirectoryError):
        scan.list_images(str(tmp_path / "nope"))

def test_resolve_index_ok():
    assert scan.resolve_index(5, 0) == 0
    assert scan.resolve_index(5, 4) == 4

def test_resolve_index_out_of_range_raises():
    import pytest
    with pytest.raises(IndexError):
        scan.resolve_index(5, 5)
    with pytest.raises(IndexError):
        scan.resolve_index(5, -1)

def test_resolve_index_empty_raises():
    import pytest
    with pytest.raises(FileNotFoundError):
        scan.resolve_index(0, 0)

def test_stem():
    assert scan.stem("/a/b/shot01.png") == "shot01"

def test_sidecar_path():
    assert scan.sidecar_path("/a/b/shot01.png") == "/a/b/shot01.txt"

def test_read_sidecar_present(tmp_path):
    (tmp_path / "x.png").write_bytes(b"i")
    (tmp_path / "x.txt").write_text("a caption\n", encoding="utf-8")
    assert scan.read_sidecar(str(tmp_path / "x.png")) == "a caption"

def test_read_sidecar_missing_returns_empty(tmp_path):
    (tmp_path / "x.png").write_bytes(b"i")
    assert scan.read_sidecar(str(tmp_path / "x.png")) == ""
