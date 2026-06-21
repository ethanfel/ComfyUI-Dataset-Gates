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
