"""Manual gate that selects a subset from an IMAGE batch.

The selection helpers and thumbnail encoder intentionally avoid importing
ComfyUI so this module remains straightforward to unit-test.
"""
import base64
import io
import json

import numpy as np
from PIL import Image

from . import gate_bus


PREVIEW_MAX_SIDE = 256
PREVIEW_JPEG_QUALITY = 82


def normalize_selection(selection, batch_size):
    """Return validated, unique indices in their original batch order."""
    if isinstance(selection, str):
        try:
            selection = json.loads(selection)
        except json.JSONDecodeError as exc:
            raise ValueError("Selection must be a JSON array of image indices") from exc

    if not isinstance(selection, (list, tuple)):
        raise ValueError("Selection must be a list of image indices")
    if not selection:
        raise ValueError("Select at least one image")

    unique = set()
    for index in selection:
        if isinstance(index, bool) or not isinstance(index, int):
            raise ValueError("Every selected image index must be an integer")
        if index < 0 or index >= batch_size:
            raise ValueError(
                f"Selected image index {index} is outside batch size {batch_size}"
            )
        unique.add(index)

    # Batch order is deterministic and does not depend on click order.
    return tuple(sorted(unique))


def select_batch(images, selection):
    """Select one or more images while preserving the IMAGE batch dimension."""
    batch_size = int(images.shape[0])
    indices = normalize_selection(selection, batch_size)
    return images[list(indices)]


def encode_previews(images, max_side=PREVIEW_MAX_SIDE,
                    jpeg_quality=PREVIEW_JPEG_QUALITY):
    """Encode small JPEG previews without modifying the original tensor."""
    previews = []
    for index, image in enumerate(images):
        array = (image.detach().cpu().float().numpy() * 255.0).clip(0, 255).astype(
            np.uint8
        )
        pil = Image.fromarray(array)
        if pil.mode != "RGB":
            pil = pil.convert("RGB")
        source_width, source_height = pil.size
        pil.thumbnail((max_side, max_side), Image.Resampling.LANCZOS)

        buffer = io.BytesIO()
        pil.save(buffer, "JPEG", quality=jpeg_quality)
        previews.append({
            "index": index,
            "image": base64.b64encode(buffer.getvalue()).decode("ascii"),
            "width": source_width,
            "height": source_height,
        })
    return previews


class ImageChooserGate:
    CATEGORY = "Dataset Gates"
    FUNCTION = "run"
    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("images",)

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {"images": ("IMAGE",)},
            "hidden": {"unique_id": "UNIQUE_ID"},
        }

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        return float("nan")

    def run(self, images, unique_id):
        batch_size = int(images.shape[0])
        if batch_size < 1:
            raise ValueError("Image Chooser Gate requires a non-empty image batch")

        from . import gate_server
        import comfy.model_management as mm

        token = gate_bus.GateBus.arm_token(unique_id, context=batch_size)
        try:
            gate_server.send_image_choices(unique_id, token, images)
            selection = gate_bus.GateBus.wait_token_payload(
                unique_id, token, should_cancel=mm.processing_interrupted
            )
        except gate_bus.GateCancelled:
            raise mm.InterruptProcessingException()
        finally:
            gate_bus.GateBus.disarm_token(unique_id, token)

        return (select_batch(images, selection),)


NODE_CLASS_MAPPINGS = {"ImageChooserGate": ImageChooserGate}
NODE_DISPLAY_NAME_MAPPINGS = {
    "ImageChooserGate": "Image Chooser Gate (Batch)",
}
