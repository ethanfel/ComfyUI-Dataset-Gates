# tests/test_profiles.py
from gates import profiles as pr

def test_empty_registry():
    assert pr.empty_registry() == {"profiles": []}

def test_read_missing_is_empty(tmp_path):
    assert pr.read_registry(str(tmp_path)) == {"profiles": []}

def test_write_then_read(tmp_path):
    reg = {"profiles": [{"id": "a", "name": "n", "created": 1}]}
    pr.write_registry(str(tmp_path), reg)
    assert (tmp_path / "profiles.json").exists()
    assert pr.read_registry(str(tmp_path)) == reg

def test_read_corrupt_is_empty(tmp_path):
    (tmp_path / "profiles.json").write_text("{ not json")
    assert pr.read_registry(str(tmp_path)) == {"profiles": []}

def test_find_helpers():
    reg = {"profiles": [{"id": "a", "name": "x"}, {"id": "b", "name": "y"}]}
    assert pr.find_by_id(reg, "b")["name"] == "y"
    assert pr.find_by_name(reg, "x")["id"] == "a"
    assert pr.find_by_id(reg, "z") is None

def test_create_profile(tmp_path):
    e = pr.create_profile(str(tmp_path), "setA", "id1", ts=10)
    assert e == {"id": "id1", "name": "setA", "created": 10}
    assert (tmp_path / "id1").is_dir()
    assert pr.find_by_name(pr.read_registry(str(tmp_path)), "setA")["id"] == "id1"

def test_create_duplicate_name_raises(tmp_path):
    import pytest
    pr.create_profile(str(tmp_path), "setA", "id1")
    with pytest.raises(ValueError):
        pr.create_profile(str(tmp_path), "setA", "id2")

def test_rename_profile(tmp_path):
    pr.create_profile(str(tmp_path), "old", "id1")
    e = pr.rename_profile(str(tmp_path), "id1", "new")
    assert e["name"] == "new"
    assert pr.find_by_name(pr.read_registry(str(tmp_path)), "new")["id"] == "id1"

def test_rename_to_existing_name_raises(tmp_path):
    import pytest
    pr.create_profile(str(tmp_path), "a", "id1")
    pr.create_profile(str(tmp_path), "b", "id2")
    with pytest.raises(ValueError):
        pr.rename_profile(str(tmp_path), "id2", "a")

def test_delete_profile_removes_dir_and_entry(tmp_path):
    pr.create_profile(str(tmp_path), "a", "id1")
    (tmp_path / "id1" / "img_0001.png").write_bytes(b"x")
    pr.delete_profile(str(tmp_path), "id1")
    assert not (tmp_path / "id1").exists()
    assert pr.find_by_id(pr.read_registry(str(tmp_path)), "id1") is None

def test_duplicate_copies_images(tmp_path):
    pr.create_profile(str(tmp_path), "src", "id1")
    (tmp_path / "id1" / "img_0001.png").write_bytes(b"abc")
    e = pr.duplicate_profile(str(tmp_path), "id1", "copy", "id2", ts=5)
    assert e == {"id": "id2", "name": "copy", "created": 5}
    assert (tmp_path / "id2" / "img_0001.png").read_bytes() == b"abc"

def test_duplicate_duplicate_name_raises(tmp_path):
    import pytest
    pr.create_profile(str(tmp_path), "src", "id1")
    with pytest.raises(ValueError):
        pr.duplicate_profile(str(tmp_path), "id1", "src", "id2")

def test_export_import_roundtrip(tmp_path):
    src_base = str(tmp_path / "a"); dst_base = str(tmp_path / "b")
    pr.create_profile(src_base, "setA", "id1", ts=1)
    from pathlib import Path
    (Path(src_base) / "id1" / "img_0001.png").write_bytes(b"hello")
    zpath = str(tmp_path / "setA.zip")
    pr.export_profile(src_base, "id1", zpath)
    assert (tmp_path / "setA.zip").exists()
    # import into a different base, fresh id
    e = pr.import_profile(dst_base, zpath, "id99", ts=2)
    assert e["id"] == "id99"
    assert e["name"] == "setA"                       # name carried in zip meta
    assert (Path(dst_base) / "id99" / "img_0001.png").read_bytes() == b"hello"

def test_import_name_collision_suffixes(tmp_path):
    base = str(tmp_path)
    pr.create_profile(base, "setA", "id1")
    from pathlib import Path
    (Path(base) / "id1" / "f.png").write_bytes(b"x")
    z = str(tmp_path / "e.zip"); pr.export_profile(base, "id1", z)
    e = pr.import_profile(base, z, "id2")
    assert e["name"] == "setA (2)"
