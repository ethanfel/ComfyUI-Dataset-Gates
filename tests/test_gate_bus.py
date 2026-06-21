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
