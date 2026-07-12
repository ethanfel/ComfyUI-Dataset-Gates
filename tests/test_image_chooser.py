import base64
import io
import math
import sys
import types

import pytest
import torch
from PIL import Image

import gates
from gates import image_chooser


def test_normalize_selection_deduplicates_and_preserves_batch_order():
    assert image_chooser.normalize_selection("[3, 1, 3]", 4) == (1, 3)


@pytest.mark.parametrize(
    "selection",
    [
        [],
        "[]",
        "not json",
        "1",
        [True],
        [1.0],
        ["1"],
        [-1],
        [3],
    ],
)
def test_normalize_selection_rejects_invalid_choices(selection):
    with pytest.raises(ValueError):
        image_chooser.normalize_selection(selection, 3)


def test_select_batch_keeps_batch_dimension_and_original_pixels():
    images = torch.arange(4 * 2 * 3 * 3, dtype=torch.float32).reshape(4, 2, 3, 3)

    one = image_chooser.select_batch(images, [2])
    many = image_chooser.select_batch(images, [3, 0, 3])

    assert one.shape == (1, 2, 3, 3)
    assert torch.equal(one[0], images[2])
    assert many.shape == (2, 2, 3, 3)
    assert torch.equal(many, images[[0, 3]])
    assert many.dtype == images.dtype


def test_encode_previews_returns_small_jpegs_and_source_dimensions():
    images = torch.zeros((2, 80, 40, 3), dtype=torch.float32)
    images[1] = 1.0

    previews = image_chooser.encode_previews(images, max_side=32)

    assert [preview["index"] for preview in previews] == [0, 1]
    assert [(preview["width"], preview["height"]) for preview in previews] == [
        (40, 80),
        (40, 80),
    ]
    decoded = [
        Image.open(io.BytesIO(base64.b64decode(preview["image"])))
        for preview in previews
    ]
    assert all(image.format == "JPEG" and image.mode == "RGB" for image in decoded)
    assert [image.size for image in decoded] == [(16, 32), (16, 32)]


def test_encode_previews_accepts_bfloat16_images():
    images = torch.zeros((1, 8, 8, 3), dtype=torch.bfloat16)
    assert len(image_chooser.encode_previews(images)) == 1


def test_run_waits_for_token_scoped_selection(monkeypatch):
    fake_server = types.ModuleType("gates.gate_server")

    def send_image_choices(node_id, token, images):
        assert images.shape[0] == 3
        assert image_chooser.gate_bus.GateBus.put_token_payload(
            node_id, token, [2, 0]
        )

    fake_server.send_image_choices = send_image_choices
    monkeypatch.setitem(sys.modules, "gates.gate_server", fake_server)
    monkeypatch.setattr(gates, "gate_server", fake_server, raising=False)

    class InterruptProcessingException(Exception):
        pass

    fake_mm = types.ModuleType("comfy.model_management")
    fake_mm.processing_interrupted = lambda: False
    fake_mm.InterruptProcessingException = InterruptProcessingException
    fake_comfy = types.ModuleType("comfy")
    fake_comfy.model_management = fake_mm
    monkeypatch.setitem(sys.modules, "comfy", fake_comfy)
    monkeypatch.setitem(sys.modules, "comfy.model_management", fake_mm)

    images = torch.arange(3, dtype=torch.float32).reshape(3, 1, 1, 1)
    selected, = image_chooser.ImageChooserGate().run(images, unique_id="12")

    assert torch.equal(selected.flatten(), torch.tensor([0.0, 2.0]))
    assert "12" not in image_chooser.gate_bus.GateBus.active_tokens


def test_image_chooser_node_contract():
    inputs = image_chooser.ImageChooserGate.INPUT_TYPES()

    assert inputs["required"] == {"images": ("IMAGE",)}
    assert inputs["hidden"] == {"unique_id": "UNIQUE_ID"}
    assert image_chooser.ImageChooserGate.RETURN_TYPES == ("IMAGE",)
    assert image_chooser.ImageChooserGate.RETURN_NAMES == ("images",)
    assert image_chooser.ImageChooserGate.FUNCTION == "run"
    assert image_chooser.ImageChooserGate.CATEGORY == "Dataset Gates"
    assert math.isnan(image_chooser.ImageChooserGate.IS_CHANGED(images=None))
    assert image_chooser.NODE_CLASS_MAPPINGS["ImageChooserGate"] \
        is image_chooser.ImageChooserGate
