import json
from pathlib import Path
from gates import pool


def test_empty_manifest_shape():
    m = pool.empty_manifest()
    assert m == {"active": 0, "slots": [], "next_seq": 1}


def test_read_missing_creates_empty(tmp_path):
    m = pool.read_manifest(str(tmp_path), "p1")
    assert m == pool.empty_manifest()


def test_write_then_read_roundtrip(tmp_path):
    m = pool.empty_manifest()
    m["active"] = 2
    pool.write_manifest(str(tmp_path), "p1", m)
    # file lives at <base>/p1/manifest.json
    assert (tmp_path / "p1" / "manifest.json").exists()
    assert pool.read_manifest(str(tmp_path), "p1") == m


def test_write_is_atomic_no_partial_temp_left(tmp_path):
    pool.write_manifest(str(tmp_path), "p1", pool.empty_manifest())
    leftovers = list((tmp_path / "p1").glob("*.tmp"))
    assert leftovers == []
