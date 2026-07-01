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


def test_textgate_text_input_is_optional():
    it = textgate.TextGate.INPUT_TYPES()
    assert "text" in it["optional"]
    assert "protected" in it["optional"]
    assert "stored_text" in it["optional"]


def test_textgate_protected_returns_stored_text_without_pause():
    # protected mode must return the stored text directly — no GateBus, no comfy
    out = textgate.TextGate().run(
        unique_id="1", text="from upstream", signal="sig",
        protected=True, stored_text="my authored text",
    )
    assert out == ("my authored text", "sig")


def test_textgate_is_changed_protected_returns_stored_text():
    v = textgate.TextGate.IS_CHANGED(
        unique_id="1", protected=True, stored_text="frozen")
    assert v == "frozen"


def test_textgate_is_changed_not_protected_is_nan():
    v = textgate.TextGate.IS_CHANGED(
        unique_id="1", protected=False, stored_text="ignored")
    assert math.isnan(v)
