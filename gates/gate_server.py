# gates/gate_server.py
import base64
import io

import numpy as np
from aiohttp import web
from PIL import Image
from server import PromptServer

from .gate_bus import GateBus
from .image_chooser import encode_previews, normalize_selection

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


def send_image_choices(node_id, token, images):
    """Show a lightweight preview of every image to the queuing client."""
    server = PromptServer.instance
    server.send_sync(
        "datasete-image-chooser-show",
        {
            "id": str(node_id),
            "display_id": str(getattr(server, "last_node_id", None) or node_id),
            "token": token,
            "images": encode_previews(images),
            "count": int(images.shape[0]),
        },
        getattr(server, "client_id", None),
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


@routes.post("/datasete_image_chooser/select")
async def _image_chooser_select(request):
    post = await request.post()
    node_id = post.get("id")
    token = post.get("token")
    if node_id is None or token is None:
        return web.json_response({"error": "missing node id or token"}, status=400)

    batch_size = GateBus.token_context(node_id, token)
    if batch_size is None:
        return web.json_response({"error": "chooser run is no longer active"}, status=409)

    if post.get("action") == "cancel":
        accepted = GateBus.cancel_token(node_id, token)
    else:
        selection = post.get("selection")
        if selection is None:
            return web.json_response({"error": "missing selection"}, status=400)
        try:
            selection = normalize_selection(selection, batch_size)
        except ValueError as exc:
            return web.json_response({"error": str(exc)}, status=400)
        accepted = GateBus.put_token_payload(node_id, token, selection)

    if not accepted:
        return web.json_response({"error": "chooser run is no longer active"}, status=409)
    return web.json_response({})


def send_text(node_id, text):
    PromptServer.instance.send_sync(
        "datasete-textgate-show", {"id": str(node_id), "text": text or ""}
    )


@routes.post("/datasete_text_gate/pass")
async def _text_pass(request):
    post = await request.post()
    GateBus.put_payload(post.get("id"), post.get("text", ""))
    return web.json_response({})
