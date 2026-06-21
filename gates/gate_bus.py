"""Blocking choice bus for the Image Gate node. Stdlib only — no comfy/torch."""
import time


class GateCancelled(Exception):
    pass


class GateBus:
    messages = {}     # node_id(str) -> chosen int (1-based)
    masks = {}        # node_id(str) -> PNG bytes
    cancelled = False

    @classmethod
    def arm(cls, node_id):
        cls.messages.pop(str(node_id), None)
        cls.masks.pop(str(node_id), None)
        cls.cancelled = False

    @classmethod
    def put(cls, node_id, message):
        if message == "__cancel__":
            cls.cancelled = True
        else:
            cls.messages[str(node_id)] = int(message)

    @classmethod
    def wait(cls, node_id, period=0.1):
        sid = str(node_id)
        while sid not in cls.messages:
            if cls.cancelled:
                cls.cancelled = False
                raise GateCancelled()
            time.sleep(period)
        return cls.messages.pop(sid)
