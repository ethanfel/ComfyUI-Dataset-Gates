"""aiohttp routes for the Image Pool node. Imported only inside ComfyUI."""
import json
from aiohttp import web
from server import PromptServer
from . import handlers
from .gates_compat import grid_pool_base

routes = PromptServer.instance.routes


def _base():
    return grid_pool_base()


@routes.post("/grid_pool/add")
async def _add(request):
    reader = await request.multipart()
    pool_id, ts, data = "default", 0, None
    async for part in reader:
        if part.name == "pool_id":
            pool_id = (await part.text())
        elif part.name == "ts":
            ts = int(await part.text())
        elif part.name == "image":
            data = await part.read(decode=False)
    m = handlers.handle_add(_base(), pool_id, data, "png", ts=ts)
    return web.json_response(m)


@routes.post("/grid_pool/remove")
async def _remove(request):
    body = await request.json()
    return web.json_response(handlers.handle_remove(_base(), body["pool_id"], int(body["index"])))


@routes.post("/grid_pool/active")
async def _active(request):
    body = await request.json()
    return web.json_response(handlers.handle_active(_base(), body["pool_id"], int(body["index"])))


@routes.post("/grid_pool/label")
async def _label(request):
    body = await request.json()
    return web.json_response(handlers.handle_label(_base(), body["pool_id"], int(body["index"]), body["label"]))


@routes.post("/grid_pool/set_mask")
async def _set_mask(request):
    reader = await request.multipart()
    pool_id, index, data = "default", 0, None
    async for part in reader:
        if part.name == "pool_id":
            pool_id = (await part.text())
        elif part.name == "index":
            index = int(await part.text())
        elif part.name == "mask":
            data = await part.read(decode=False)
    m = handlers.handle_set_mask(_base(), pool_id, index, data)
    return web.json_response(m)


@routes.get("/grid_pool/list")
async def _list(request):
    pool_id = request.query.get("pool_id", "default")
    return web.json_response(handlers.handle_list(_base(), pool_id))
