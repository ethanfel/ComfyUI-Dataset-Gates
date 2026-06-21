import torch
from gates import bucket_node as bn


def test_square_to_1280():
    out, m, w, h, label = bn.BucketResize().run(image=torch.rand((1, 1000, 1000, 3)))
    assert (w, h) == (1280, 1280)
    assert out.shape == (1, 1280, 1280, 3)
    assert m.shape == (1, 1280, 1280) and float(m.max()) == 0.0   # no mask -> zeros
    assert label == "1280x1280"


def test_landscape_bucket_shapes():
    # tensor [B,H,W,3] with H=1000,W=2000 -> aspect 2.0 -> 1792x896
    out, m, w, h, label = bn.BucketResize().run(image=torch.rand((1, 1000, 2000, 3)))
    assert (w, h) == (1792, 896)
    assert out.shape == (1, 896, 1792, 3)
    assert label == "1792x896"


def test_mask_resized_and_aligned():
    out, m, w, h, _ = bn.BucketResize().run(
        image=torch.rand((1, 1000, 1000, 3)), mask=torch.ones((1, 1000, 1000)))
    assert m.shape == (1, 1280, 1280) and float(m.min()) > 0.9


def test_outputs_are_on_grid():
    out, m, w, h, _ = bn.BucketResize().run(
        image=torch.rand((1, 777, 1333, 3)), resolution=1280, divisible=64)
    assert w % 64 == 0 and h % 64 == 0
    assert out.shape[1] == h and out.shape[2] == w
