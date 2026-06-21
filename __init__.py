"""ComfyUI-Datasete-Gates — custom nodes."""
from .gates.node import NODE_CLASS_MAPPINGS, NODE_DISPLAY_NAME_MAPPINGS
from .gates import routes  # noqa: F401  (registers aiohttp routes on import)

WEB_DIRECTORY = "./web"

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
