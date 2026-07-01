# gates/profile_node.py
NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}


class PoolProfile:
    CATEGORY = "Dataset Gates"
    FUNCTION = "run"
    RETURN_TYPES = ("POOL_PROFILE",)
    RETURN_NAMES = ("profile",)

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "profile": ("STRING", {"default": ""}),      # name; JS renders a dropdown
                "profile_id": ("STRING", {"default": ""}),    # hidden, JS-owned id
            },
        }

    def run(self, profile, profile_id=""):
        return (profile_id or "default",)

    @classmethod
    def IS_CHANGED(cls, profile, profile_id="", **kwargs):
        return profile_id


NODE_CLASS_MAPPINGS = {"PoolProfile": PoolProfile}
NODE_DISPLAY_NAME_MAPPINGS = {"PoolProfile": "Pool Profile"}
