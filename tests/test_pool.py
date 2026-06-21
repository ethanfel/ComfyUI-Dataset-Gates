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


def test_next_image_name_uses_next_seq():
    m = pool.empty_manifest()
    assert pool.next_image_name(m) == "img_0001.png"
    m["next_seq"] = 42
    assert pool.next_image_name(m) == "img_0042.png"


def test_add_image_writes_file_and_appends_slot(tmp_path):
    data = b"\x89PNG\r\n\x1a\n" + b"fake"  # bytes are written verbatim
    m = pool.add_image(str(tmp_path), "p1", data, ts=123)
    assert len(m["slots"]) == 1
    slot = m["slots"][0]
    assert slot == {"image": "img_0001.png", "mask": None, "label": "", "added": 123}
    assert m["next_seq"] == 2
    assert (tmp_path / "p1" / "img_0001.png").read_bytes() == data


def test_add_image_monotonic_after_growth(tmp_path):
    pool.add_image(str(tmp_path), "p1", b"a", ts=1)
    m = pool.add_image(str(tmp_path), "p1", b"b", ts=2)
    assert [s["image"] for s in m["slots"]] == ["img_0001.png", "img_0002.png"]
