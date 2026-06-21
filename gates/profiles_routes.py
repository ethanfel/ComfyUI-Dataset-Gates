# gates/profiles_routes.py
import os
import tempfile
import uuid

from aiohttp import web
from server import PromptServer

from . import profiles
from .gates_compat import grid_pool_base

routes = PromptServer.instance.routes


def _base():
    return grid_pool_base()


@routes.get("/grid_pool/profiles/list")
async def _list(request):
    return web.json_response(profiles.read_registry(_base()))


@routes.post("/grid_pool/profiles/create")
async def _create(request):
    body = await request.json()
    e = profiles.create_profile(_base(), body["name"], uuid.uuid4().hex)
    return web.json_response(e)


@routes.post("/grid_pool/profiles/rename")
async def _rename(request):
    body = await request.json()
    return web.json_response(profiles.rename_profile(_base(), body["id"], body["name"]))


@routes.post("/grid_pool/profiles/delete")
async def _delete(request):
    body = await request.json()
    return web.json_response(profiles.delete_profile(_base(), body["id"]))


@routes.post("/grid_pool/profiles/duplicate")
async def _duplicate(request):
    body = await request.json()
    e = profiles.duplicate_profile(_base(), body["id"], body["name"], uuid.uuid4().hex)
    return web.json_response(e)


@routes.post("/grid_pool/profiles/seed")
async def _seed(request):
    body = await request.json()
    n = profiles.seed_profile(_base(), body["from"], body["id"])
    return web.json_response({"copied": n})


@routes.get("/grid_pool/profiles/export")
async def _export(request):
    pid = request.query["id"]
    reg = profiles.read_registry(_base())
    entry = profiles.find_by_id(reg, pid)
    fname = (entry["name"] if entry else pid) + ".zip"
    tmp = os.path.join(tempfile.gettempdir(), f"profile_{pid}.zip")
    profiles.export_profile(_base(), pid, tmp)
    return web.FileResponse(tmp, headers={"Content-Disposition": f'attachment; filename="{fname}"'})


@routes.post("/grid_pool/profiles/import")
async def _import(request):
    reader = await request.multipart()
    tmp = os.path.join(tempfile.gettempdir(), f"import_{uuid.uuid4().hex}.zip")
    async for part in reader:
        if part.name == "file":
            with open(tmp, "wb") as f:
                while True:
                    chunk = await part.read_chunk()
                    if not chunk:
                        break
                    f.write(chunk)
    e = profiles.import_profile(_base(), tmp, uuid.uuid4().hex)
    return web.json_response(e)
