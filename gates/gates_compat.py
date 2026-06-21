"""Isolates the ComfyUI dependency so node.py stays unit-testable.

node.py imports ``grid_pool_base`` from here; tests monkeypatch
``node._grid_pool_base`` so ``folder_paths`` is never needed.
"""
import os


def grid_pool_base():
    import folder_paths  # imported lazily; only available inside ComfyUI
    return os.path.join(folder_paths.get_input_directory(), "grid_pool")
