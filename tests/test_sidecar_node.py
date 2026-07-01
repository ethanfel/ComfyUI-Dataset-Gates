from gates import sidecar_node as sn


def test_sidecar_run_builds_chain():
    node = sn.Sidecar()
    (chain,) = node.run(content="hello", name="", extension=".txt", sidecar=None)
    assert chain == [{"content": "hello", "name": "", "ext": ".txt"}]
    (chain2,) = node.run(content="{}", name="meta", extension=".json", sidecar=chain)
    assert len(chain2) == 2
    assert chain2[1] == {"content": "{}", "name": "meta", "ext": ".json"}


def test_sidecar_io_shape():
    assert sn.Sidecar.RETURN_TYPES == ("SIDECAR",)
    it = sn.Sidecar.INPUT_TYPES()
    assert "content" in it["required"]
    assert "name" in it["required"]
    assert "extension" in it["required"]
    assert "sidecar" in it["optional"]


def test_save_node_io_shape():
    assert sn.SaveImageSidecars.OUTPUT_NODE is True
    assert sn.SaveImageSidecars.RETURN_TYPES == ()
    it = sn.SaveImageSidecars.INPUT_TYPES()
    for k in ("images", "filename_prefix", "output_folder"):
        assert k in it["required"]
    assert "sidecar" in it["optional"]


def test_mappings_present():
    assert "Sidecar" in sn.NODE_CLASS_MAPPINGS
    assert "SaveImageSidecars" in sn.NODE_CLASS_MAPPINGS
    assert sn.NODE_DISPLAY_NAME_MAPPINGS["SaveImageSidecars"]
