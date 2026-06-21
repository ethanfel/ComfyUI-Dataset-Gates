"""Pure request handlers — no aiohttp. Each returns the updated manifest dict."""
from . import pool


def handle_add(base, pool_id, data, ext, ts=0):
    return pool.add_image(base, pool_id, data, ts=ts)


def handle_remove(base, pool_id, index):
    return pool.remove_slot(base, pool_id, index)


def handle_active(base, pool_id, index):
    return pool.set_active(base, pool_id, index)


def handle_label(base, pool_id, index, label):
    return pool.set_label(base, pool_id, index, label)


def handle_list(base, pool_id):
    return pool.read_manifest(base, pool_id)


def handle_set_mask(base, pool_id, index, mask_png_bytes):
    return pool.set_mask(base, pool_id, index, mask_png_bytes)  # Task 12
