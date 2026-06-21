# gates/gate_server.py
import base64
import io

import numpy as np
from aiohttp import web
from PIL import Image
from server import PromptServer

from .gate_bus import GateBus

routes = PromptServer.instance.routes


def send_preview(node_id, image, n_routes):
    arr = (image[0].cpu().numpy() * 255.0).clip(0, 255).astype("uint8")
    buf = io.BytesIO()
    Image.fromarray(arr).save(buf, "PNG")
    b64 = base64.b64encode(buf.getvalue()).decode()
    PromptServer.instance.send_sync(
        "datasete-gate-show",
        {"id": str(node_id), "image": b64, "routes": int(n_routes)},
    )


@routes.post("/datasete_gate/choice")
async def _choice(request):
    post = await request.post()
    GateBus.put(post.get("id"), post.get("message"))
    return web.json_response({})


@routes.post("/datasete_gate/mask")
async def _mask(request):
    reader = await request.multipart()
    node_id, data = None, None
    async for part in reader:
        if part.name == "id":
            node_id = await part.text()
        elif part.name == "mask":
            data = await part.read(decode=False)
    if node_id is not None:
        GateBus.put_mask(node_id, data)
    return web.json_response({})
