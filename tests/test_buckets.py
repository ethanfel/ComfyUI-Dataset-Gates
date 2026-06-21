from gates import buckets

# (iw, ih) -> expected (W, H) from KLEIN_BUCKET_SIZES.md, budget 1280, ÷64
CASES = [
    (1000, 1000, 1280, 1280),   # square
    (1000, 2000, 896, 1792),    # a=0.50 portrait
    (1000, 1730, 960, 1664),    # a≈0.58
    (1000, 1100, 1216, 1344),   # a≈0.90 -> portrait-leaning
    (2000, 1000, 1792, 896),    # a=2.00 landscape
    (1500, 1000, 1536, 1024),   # a=1.50
]


def test_pick_bucket_matches_table():
    for iw, ih, W, H in CASES:
        assert buckets.pick_bucket(iw, ih, 1280, 64) == (W, H)


def test_buckets_are_on_grid_and_within_budget():
    for iw, ih, *_ in CASES:
        W, H = buckets.pick_bucket(iw, ih, 1280, 64)
        assert W % 64 == 0 and H % 64 == 0
        assert W * H <= 1280 * 1280


def test_square_is_exactly_1280():
    assert buckets.pick_bucket(512, 512, 1280, 64) == (1280, 1280)


def test_cover_crop_exact_aspect_no_crop():
    # a=2.0 image onto 1792x896 bucket -> scale 0.896, no crop
    new_w, new_h, left, top, scale = buckets.cover_crop_params(2000, 1000, 1792, 896)
    assert (new_w, new_h) == (1792, 896)
    assert (left, top) == (0, 0)
    assert round(scale, 3) == 0.896


def test_cover_crop_square_into_landscape_crops_height():
    new_w, new_h, left, top, scale = buckets.cover_crop_params(1000, 1000, 1792, 896)
    assert new_w == 1792 and new_h >= 896
    assert left == 0 and top == (new_h - 896) // 2     # centered vertical crop
    assert scale > 1.0                                  # upscaled to cover width


def test_cover_crop_upscale_square():
    *_, scale = buckets.cover_crop_params(1000, 1000, 1280, 1280)
    assert round(scale, 2) == 1.28
