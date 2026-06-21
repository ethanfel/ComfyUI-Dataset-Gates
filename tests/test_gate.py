# tests/test_gate.py
from gates import gate

def test_route_tuple_places_image_at_chosen():
    B = object()
    t = gate.route_tuple(2, "IMG", B, max_routes=5)
    assert t == (B, B, "IMG", B, B)

def test_route_tuple_length_is_max():
    B = object()
    assert len(gate.route_tuple(0, "IMG", B, max_routes=10)) == 10
