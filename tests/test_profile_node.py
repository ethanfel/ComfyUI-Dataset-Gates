# tests/test_profile_node.py
from gates import profile_node as pn

def test_io():
    assert pn.PoolProfile.RETURN_TYPES == ("POOL_PROFILE",)
    assert pn.PoolProfile.RETURN_NAMES == ("profile",)

def test_run_returns_id_or_default():
    assert pn.PoolProfile().run(profile="setA", profile_id="id1") == ("id1",)
    assert pn.PoolProfile().run(profile="", profile_id="") == ("default",)

def test_is_changed_tracks_id():
    assert pn.PoolProfile.IS_CHANGED(profile="x", profile_id="id1") == "id1"
