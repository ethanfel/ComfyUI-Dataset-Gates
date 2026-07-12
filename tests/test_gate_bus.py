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

def test_wait_should_cancel_raises():
    # image gate: ComfyUI Interrupt (should_cancel) must abort the wait too
    gb.GateBus.arm("7")
    with pytest.raises(gb.GateCancelled):
        gb.GateBus.wait("7", should_cancel=lambda: True)
    assert gb.GateBus.cancelled is False


def test_token_payload_roundtrip_and_context():
    token = gb.GateBus.arm_token("chooser", context=4)
    assert gb.GateBus.token_context("chooser", token) == 4
    assert gb.GateBus.put_token_payload("chooser", token, (0, 3)) is True
    assert gb.GateBus.wait_token_payload("chooser", token) == (0, 3)
    gb.GateBus.disarm_token("chooser", token)
    assert gb.GateBus.token_context("chooser", token) is None


def test_stale_token_cannot_answer_or_cancel_new_run():
    old_token = gb.GateBus.arm_token("chooser", context=2)
    new_token = gb.GateBus.arm_token("chooser", context=5)

    assert gb.GateBus.put_token_payload("chooser", old_token, [0]) is False
    assert gb.GateBus.cancel_token("chooser", old_token) is False
    assert gb.GateBus.token_context("chooser", new_token) == 5
    with pytest.raises(gb.GateCancelled):
        gb.GateBus.wait_token_payload("chooser", old_token)
    gb.GateBus.disarm_token("chooser", new_token)


def test_token_cancel_only_cancels_matching_waiter():
    token = gb.GateBus.arm_token("chooser", context=1)
    assert gb.GateBus.cancel_token("chooser", token) is True
    with pytest.raises(gb.GateCancelled):
        gb.GateBus.wait_token_payload("chooser", token)
    gb.GateBus.disarm_token("chooser", token)
