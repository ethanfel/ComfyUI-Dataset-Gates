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
    CATEGORY = "Datasete Gates"
    FUNCTION = "run"
    RETURN_TYPES = ("STRING", ANY)
    RETURN_NAMES = ("text", "signal")

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "text": ("STRING", {"forceInput": True}),
            },
            "optional": {
                "signal": (ANY, {}),
            },
            "hidden": {"unique_id": "UNIQUE_ID"},
        }

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        return float("nan")

    def run(self, text, unique_id, signal=None):
        from . import gate_server
        import comfy.model_management as mm

        gate_bus.GateBus.arm(unique_id)
        gate_server.send_text(unique_id, text)
        try:
            edited = gate_bus.GateBus.wait_payload(
                unique_id, should_cancel=mm.processing_interrupted)
        except gate_bus.GateCancelled:
            raise mm.InterruptProcessingException()
        return (edited, signal)


NODE_CLASS_MAPPINGS = {"TextGate": TextGate}
NODE_DISPLAY_NAME_MAPPINGS = {"TextGate": "Text Gate (Manual Pass)"}
