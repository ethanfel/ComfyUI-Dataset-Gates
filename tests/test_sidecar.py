import pytest

from gates import sidecar


def test_append_spec_builds_chain_without_mutating():
    c1 = sidecar.append_spec(None, "hello", "", ".txt")
    c2 = sidecar.append_spec(c1, "{}", "meta", ".json")
    assert c1 == [{"content": "hello", "name": "", "ext": ".txt"}]
    assert len(c2) == 2
    assert c2[1] == {"content": "{}", "name": "meta", "ext": ".json"}
    assert len(c1) == 1  # original chain untouched


def test_normalize_ext_adds_dot_and_allowlists():
    assert sidecar.normalize_ext("txt") == ".txt"
    assert sidecar.normalize_ext(".json") == ".json"
    with pytest.raises(ValueError):
        sidecar.normalize_ext(".png")
    with pytest.raises(ValueError):
        sidecar.normalize_ext(".exe")


def test_sanitize_name_strips_path_and_space():
    assert sidecar.sanitize_name("  variant_a ") == "variant_a"
    assert sidecar.sanitize_name("../evil") == "evil"
    assert sidecar.sanitize_name("a/b") == "b"
    assert sidecar.sanitize_name("") == ""


def test_build_plan_resolves_suffixes():
    specs = [
        {"content": "cap", "name": "", "ext": ".txt"},
        {"content": "{}", "name": "", "ext": ".json"},
        {"content": "v", "name": "variant_a", "ext": ".txt"},
    ]
    assert sidecar.build_plan(specs) == [
        (".txt", "cap"),
        (".json", "{}"),
        ("variant_a.txt", "v"),
    ]


def test_build_plan_duplicate_empty_names_raises():
    specs = [
        {"content": "a", "name": "", "ext": ".txt"},
        {"content": "b", "name": "", "ext": ".txt"},
    ]
    with pytest.raises(ValueError):
        sidecar.build_plan(specs)


def test_build_plan_empty_txt_and_json_do_not_collide():
    specs = [
        {"content": "a", "name": "", "ext": ".txt"},
        {"content": "b", "name": "", "ext": ".json"},
    ]
    assert len(sidecar.build_plan(specs)) == 2


def test_build_plan_bad_extension_raises():
    with pytest.raises(ValueError):
        sidecar.build_plan([{"content": "x", "name": "", "ext": ".png"}])


def test_build_plan_none_is_empty():
    assert sidecar.build_plan(None) == []
