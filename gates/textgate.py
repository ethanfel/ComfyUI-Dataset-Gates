# gates/textgate.py
from . import gate_bus

NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}


class AnyType(str):
    """Type that compares equal to any other type (ComfyUI wildcard convention)."""
    def __ne__(self, other):
        return False


ANY = AnyType("*")
