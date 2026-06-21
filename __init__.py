"""ComfyUI-Datasete-Gates — custom nodes."""

WEB_DIRECTORY = "./web"

# ComfyUI loads this directory as a package, so __package__ is set and the
# relative imports below resolve. pytest, however, collects the repo root as a
# Package and imports this file standalone (no parent package) during test
# setup — in that case the relative imports would raise. Guard on __package__
# so the test suite can import `gates.*` without dragging in aiohttp/comfy.
if __package__:
    from .gates.node import NODE_CLASS_MAPPINGS, NODE_DISPLAY_NAME_MAPPINGS
    from .gates import routes  # noqa: F401  (registers aiohttp routes on import)
else:  # pragma: no cover - exercised only under pytest collection
    NODE_CLASS_MAPPINGS = {}
    NODE_DISPLAY_NAME_MAPPINGS = {}

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
