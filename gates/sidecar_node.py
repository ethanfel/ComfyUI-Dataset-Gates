"""Save Image + chainable sidecar text/JSON files.

`Sidecar` nodes chain a list of {content, name, ext} specs (SIDECAR type);
`SaveImageSidecars` saves the image and writes each sidecar next to it sharing
the image's base name. Heavy deps (torch/PIL/folder_paths) are imported lazily
inside save() so this module imports without comfy for unit tests."""
from . import sidecar as sc

NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}


class Sidecar:
    CATEGORY = "Datasete Gates"
    FUNCTION = "run"
    RETURN_TYPES = ("SIDECAR",)
    RETURN_NAMES = ("sidecar",)

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "content": ("STRING", {"forceInput": True}),
                "name": ("STRING", {"default": ""}),
                "extension": ("STRING", {"default": ".txt"}),
            },
            "optional": {
                "sidecar": ("SIDECAR",),   # chain-in from a previous Sidecar
            },
        }

    def run(self, content, name, extension, sidecar=None):
        return (sc.append_spec(sidecar, content, name, extension),)


class SaveImageSidecars:
    CATEGORY = "Datasete Gates"
    FUNCTION = "save"
    RETURN_TYPES = ()
    OUTPUT_NODE = True

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "images": ("IMAGE",),
                "filename_prefix": ("STRING", {"default": "ComfyUI"}),
                "output_folder": ("STRING", {"default": "output"}),
            },
            "optional": {
                "sidecar": ("SIDECAR",),
            },
            "hidden": {"prompt": "PROMPT", "extra_pnginfo": "EXTRA_PNGINFO"},
        }

    @staticmethod
    def _safe_path(folder, filename):
        import os
        path = os.path.join(folder, filename)
        root = os.path.abspath(folder)
        if os.path.commonpath((root, os.path.abspath(path))) != root:
            raise ValueError(f"Refusing to write outside the target folder: {path}")
        return path

    def save(self, images, filename_prefix, output_folder, sidecar=None,
             prompt=None, extra_pnginfo=None):
        import json
        import os

        import numpy as np
        from PIL import Image
        from PIL.PngImagePlugin import PngInfo

        import folder_paths
        from comfy.cli_args import args

        # Validate the entire sidecar plan BEFORE writing anything, so a bad
        # chain (duplicate name, disallowed extension) writes no files at all.
        plan = sc.build_plan(sidecar)

        h, w = int(images[0].shape[0]), int(images[0].shape[1])
        if os.path.isabs(output_folder):
            os.makedirs(output_folder, exist_ok=True)
            output_dir = output_folder
        else:
            output_dir = folder_paths.get_output_directory()
        full_output_folder, filename, counter, subfolder, filename_prefix = \
            folder_paths.get_save_image_path(filename_prefix, output_dir, w, h)

        results = []
        for batch_number, image in enumerate(images):
            arr = (255.0 * image.cpu().numpy()).clip(0, 255).astype(np.uint8)
            img = Image.fromarray(arr)

            metadata = None
            if not args.disable_metadata:
                metadata = PngInfo()
                if prompt is not None:
                    metadata.add_text("prompt", json.dumps(prompt))
                if extra_pnginfo is not None:
                    for k in extra_pnginfo:
                        metadata.add_text(k, json.dumps(extra_pnginfo[k]))

            base = f"{filename.replace('%batch_num%', str(batch_number))}_{counter:05}_"
            img.save(self._safe_path(full_output_folder, base + ".png"),
                     pnginfo=metadata, compress_level=4)
            for suffix, content in plan:
                with open(self._safe_path(full_output_folder, base + suffix),
                          "w", encoding="utf-8") as f:
                    f.write(content if content is not None else "")

            results.append({"filename": base + ".png",
                            "subfolder": subfolder, "type": "output"})
            counter += 1

        return {"ui": {"images": results}}


NODE_CLASS_MAPPINGS = {
    "Sidecar": Sidecar,
    "SaveImageSidecars": SaveImageSidecars,
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "Sidecar": "Sidecar (text/json)",
    "SaveImageSidecars": "Save Image (Sidecars)",
}
