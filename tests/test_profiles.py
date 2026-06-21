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
