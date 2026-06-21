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
