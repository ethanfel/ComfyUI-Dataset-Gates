# tests/test_textgate.py
from gates import textgate

def test_anytype_is_compatible_with_everything():
    assert (textgate.ANY != "IMAGE") is False
    assert (textgate.ANY != "LATENT") is False
    assert isinstance(textgate.ANY, str)
