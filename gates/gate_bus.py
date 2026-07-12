"""Blocking coordination for manual gate nodes. Stdlib only — no comfy/torch."""
import threading
import time
import uuid


class GateCancelled(Exception):
    pass


class GateBus:
    messages = {}     # node_id(str) -> chosen int (1-based)
    masks = {}        # node_id(str) -> PNG bytes
    payloads = {}     # node_id(str) -> arbitrary payload (e.g., edited text)
    cancelled = False
    active_tokens = {}   # node_id(str) -> per-run token for scoped waiters
    token_payloads = {}  # (node_id, token) -> arbitrary payload
    token_cancelled = set()
    token_contexts = {}  # (node_id, token) -> waiter-specific validation data
    token_lock = threading.Lock()

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

    @classmethod
    def arm_token(cls, node_id, context=None):
        """Open a run-scoped channel and invalidate any older run for the node."""
        sid = str(node_id)
        with cls.token_lock:
            old_token = cls.active_tokens.get(sid)
            if old_token is not None:
                old_key = (sid, old_token)
                cls.token_payloads.pop(old_key, None)
                cls.token_cancelled.discard(old_key)
                cls.token_contexts.pop(old_key, None)

            token = uuid.uuid4().hex
            key = (sid, token)
            cls.active_tokens[sid] = token
            cls.token_contexts[key] = context
        return token

    @classmethod
    def token_context(cls, node_id, token):
        sid = str(node_id)
        with cls.token_lock:
            if cls.active_tokens.get(sid) != token:
                return None
            return cls.token_contexts.get((sid, token))

    @classmethod
    def put_token_payload(cls, node_id, token, value):
        sid = str(node_id)
        with cls.token_lock:
            if cls.active_tokens.get(sid) != token:
                return False
            cls.token_payloads[(sid, token)] = value
            return True

    @classmethod
    def cancel_token(cls, node_id, token):
        sid = str(node_id)
        with cls.token_lock:
            if cls.active_tokens.get(sid) != token:
                return False
            cls.token_cancelled.add((sid, token))
            return True

    @classmethod
    def wait_token_payload(cls, node_id, token, period=0.1, should_cancel=None):
        sid = str(node_id)
        key = (sid, token)
        while True:
            with cls.token_lock:
                superseded = cls.active_tokens.get(sid) != token
                cancelled = key in cls.token_cancelled
                if superseded or cancelled:
                    cls.token_cancelled.discard(key)
                    raise GateCancelled()
                if key in cls.token_payloads:
                    return cls.token_payloads.pop(key)

            if should_cancel is not None and should_cancel():
                with cls.token_lock:
                    cls.token_cancelled.discard(key)
                raise GateCancelled()
            time.sleep(period)

    @classmethod
    def disarm_token(cls, node_id, token):
        sid = str(node_id)
        key = (sid, token)
        with cls.token_lock:
            if cls.active_tokens.get(sid) == token:
                cls.active_tokens.pop(sid, None)
            cls.token_payloads.pop(key, None)
            cls.token_cancelled.discard(key)
            cls.token_contexts.pop(key, None)
