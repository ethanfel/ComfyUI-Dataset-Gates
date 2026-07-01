# gates/textgate.py
from . import gate_bus

NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}


class AnyType(str):
    """Type that compares equal to any other type (ComfyUI wildcard convention)."""
    def __ne__(self, other):
        return False


ANY = AnyType("*")


class TextGate:
    CATEGORY = "Dataset Gates"
    FUNCTION = "run"
    RETURN_TYPES = ("STRING", ANY)
    RETURN_NAMES = ("text", "signal")

    @classmethod
    def INPUT_TYPES(cls):
        # `text` is optional so the node can run standalone in protected mode.
        # `protected` + `stored_text` are serializing widgets carrying the
        # authored text-node state (stored_text is hidden by the frontend).
        return {
            "optional": {
                "text": ("STRING", {"forceInput": True}),
                "signal": (ANY, {}),
                "protected": ("BOOLEAN", {"default": False}),
                # single-line so the frontend can fully hide it (the DOM editor
                # is the real text box); the value still holds arbitrary text.
                "stored_text": ("STRING", {"default": ""}),
            },
            "hidden": {"unique_id": "UNIQUE_ID"},
        }

    @classmethod
    def IS_CHANGED(cls, protected=False, stored_text="", **kwargs):
        # Protected = plain text node: cache on the authored text so downstream
        # only re-runs when it changes. Otherwise never cache (always pause).
        return stored_text if protected else float("nan")

    def run(self, unique_id=None, text=None, signal=None,
            protected=False, stored_text=""):
        if protected:
            # Standalone text node: emit the authored text, ignore upstream, no
            # pause. Returns before importing comfy, so it stays import-safe.
            return (stored_text, signal)

        from . import gate_server
        import comfy.model_management as mm

        gate_bus.GateBus.arm(unique_id)
        gate_server.send_text(unique_id, text or "")
        try:
            edited = gate_bus.GateBus.wait_payload(
                unique_id, should_cancel=mm.processing_interrupted)
        except gate_bus.GateCancelled:
            raise mm.InterruptProcessingException()
        return (edited, signal)


NODE_CLASS_MAPPINGS = {"TextGate": TextGate}
NODE_DISPLAY_NAME_MAPPINGS = {"TextGate": "Text Gate (Manual Pass)"}
