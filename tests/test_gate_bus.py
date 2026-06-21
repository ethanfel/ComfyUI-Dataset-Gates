# tests/test_gate_bus.py
import pytest
from gates import gate_bus as gb

def test_put_and_wait_returns_choice():
    gb.GateBus.arm("7")
    gb.GateBus.put("7", "3")
    assert gb.GateBus.wait("7") == 3

def test_wait_consumes_message():
    gb.GateBus.arm("7")
    gb.GateBus.put("7", "2")
    gb.GateBus.wait("7")
    assert "7" not in gb.GateBus.messages

def test_cancel_raises_and_resets():
    gb.GateBus.arm("7")
    gb.GateBus.put("7", "__cancel__")
    with pytest.raises(gb.GateCancelled):
        gb.GateBus.wait("7")
    assert gb.GateBus.cancelled is False      # reset after raising

def test_arm_clears_stale_state():
    gb.GateBus.put("1", "5")
    gb.GateBus.cancelled = True
    gb.GateBus.arm("1")
    assert "1" not in gb.GateBus.messages
    assert gb.GateBus.cancelled is False

def test_mask_stash_roundtrip():
    gb.GateBus.put_mask("9", b"PNGDATA")
    assert gb.GateBus.pop_mask("9") == b"PNGDATA"
    assert gb.GateBus.pop_mask("9") is None   # popped

def test_arm_clears_mask():
    gb.GateBus.put_mask("9", b"x")
    gb.GateBus.arm("9")
    assert gb.GateBus.pop_mask("9") is None

def test_payload_roundtrip():
    gb.GateBus.arm("p")
    gb.GateBus.put_payload("p", "hello edited")
    assert gb.GateBus.wait_payload("p") == "hello edited"

def test_payload_consumed():
    gb.GateBus.arm("p")
    gb.GateBus.put_payload("p", "x")
    gb.GateBus.wait_payload("p")
    assert "p" not in gb.GateBus.payloads

def test_arm_clears_payload():
    gb.GateBus.put_payload("p", "stale")
    gb.GateBus.arm("p")
    assert "p" not in gb.GateBus.payloads

def test_wait_payload_cancel_flag_raises():
    import pytest
    gb.GateBus.arm("p")
    gb.GateBus.cancelled = True
    with pytest.raises(gb.GateCancelled):
        gb.GateBus.wait_payload("p")

def test_wait_payload_should_cancel_raises():
    import pytest
    gb.GateBus.arm("p")
    with pytest.raises(gb.GateCancelled):
        gb.GateBus.wait_payload("p", should_cancel=lambda: True)
