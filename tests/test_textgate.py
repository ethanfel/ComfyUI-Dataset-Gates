# tests/test_textgate.py
import math

from gates import textgate

def test_anytype_is_compatible_with_everything():
    assert (textgate.ANY != "IMAGE") is False
    assert (textgate.ANY != "LATENT") is False
    assert isinstance(textgate.ANY, str)

def test_textgate_io_shape():
    assert textgate.TextGate.RETURN_NAMES == ("text", "signal")
    assert textgate.TextGate.RETURN_TYPES[0] == "STRING"
    assert textgate.TextGate.RETURN_TYPES[1] == textgate.ANY

def test_textgate_is_changed_nan():
    v = textgate.TextGate.IS_CHANGED(text="hi", unique_id="1")
    assert math.isnan(v)
