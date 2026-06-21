"""Pure bucket math for KLEIN_BUCKET_SIZES.md. Stdlib only."""
import math


def pick_bucket(iw, ih, resolution=1280, divisible=64):
    """Choose the on-grid bucket (W,H), area <= resolution^2, nearest to the
    image aspect (log distance; tie-break larger area)."""
    budget = resolution * resolution
    target = iw / ih
    best = None
    w = divisible
    w_max = budget // divisible
    while w <= w_max:
        h = (budget // w // divisible) * divisible      # largest on-grid h within budget
        if h >= divisible:
            err = abs(math.log(w / h) - math.log(target))
            cand = (err, -(w * h), w, h)                 # min err, then max area
            if best is None or cand < best:
                best = cand
        w += divisible
    return best[2], best[3]


def cover_crop_params(iw, ih, W, H):
    """Cover-scale + centered crop to land (iw,ih) exactly on (W,H)."""
    scale = max(W / iw, H / ih)
    new_w = max(W, round(iw * scale))
    new_h = max(H, round(ih * scale))
    left = (new_w - W) // 2
    top = (new_h - H) // 2
    return new_w, new_h, left, top, scale
