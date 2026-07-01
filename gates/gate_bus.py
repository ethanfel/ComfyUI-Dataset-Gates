"""Blocking choice bus for the Image Gate node. Stdlib only — no comfy/torch."""
import time


class GateCancelled(Exception):
    pass


class GateBus:
    messages = {}     # node_id(str) -> chosen int (1-based)
    masks = {}        # node_id(str) -> PNG bytes
    payloads = {}     # node_id(str) -> arbitrary payload (e.g., edited text)
    cancelled = False

    @classmethod
    def arm(cls, node_id):
        cls.messages.pop(str(node_id), None)
        cls.masks.pop(str(node_id), None)
        cls.payloads.pop(str(node_id), None)
        cls.cancelled = False

    @classmethod
    def put(cls, node_id, message):
        if message == "__cancel__":
            cls.cancelled = True
        else:
            cls.messages[str(node_id)] = int(message)

    @classmethod
    def wait(cls, node_id, period=0.1, should_cancel=None):
        sid = str(node_id)
        while sid not in cls.messages:
            if cls.cancelled or (should_cancel is not None and should_cancel()):
                cls.cancelled = False
                raise GateCancelled()
            time.sleep(period)
        return cls.messages.pop(sid)

    @classmethod
    def put_mask(cls, node_id, data):
        cls.masks[str(node_id)] = data

    @classmethod
    def pop_mask(cls, node_id):
        return cls.masks.pop(str(node_id), None)

    @classmethod
    def put_payload(cls, node_id, value):
        cls.payloads[str(node_id)] = value

    @classmethod
    def wait_payload(cls, node_id, period=0.1, should_cancel=None):
        sid = str(node_id)
        while sid not in cls.payloads:
            if cls.cancelled or (should_cancel is not None and should_cancel()):
                cls.cancelled = False
                raise GateCancelled()
            time.sleep(period)
        return cls.payloads.pop(sid)
