#!/usr/bin/env python3
"""Views of the street from the centre of the road, made from the photos (config/street.json, "centre_views").

    python scripts/centre_view.py              # every view
    python scripts/centre_view.py north        # one of them
    python scripts/centre_view.py --seed 7     # another take, if one is not convincing

The photos in data/street/ were taken from the pavement. For each view the open model
Qwen-Image-Edit-2511 (Apache 2.0) gets the street's photos and is asked for the same street,
as it is today, seen from the centre line of the road: same buildings, trees, bus stop, markings
and light, nothing added. The model reconstructs a viewpoint nobody photographed, so it is an
AI image: the street is recognisable, small details are invented.

Needs a CUDA GPU with about 60 GB and `pip install torch torchvision diffusers transformers
accelerate pillow`. On a GH200 (ARM), load the model from a local disk (`--model /local/copy`).
"""
import argparse
import glob
import json
import pathlib
import time

import safetensors.torch
import torch
from diffusers import QwenImageEditPlusPipeline, QwenImageTransformer2DModel
from huggingface_hub import snapshot_download
from PIL import Image
from transformers import AutoConfig, Qwen2_5_VLForConditionalGeneration

ROOT = pathlib.Path(__file__).resolve().parents[1]
MODEL = "Qwen/Qwen-Image-Edit-2511"
SIZE = (1536, 1024)  # landscape
NEGATIVE = ("cartoon, illustration, painting, drawing, blurry, distorted, deformed, watermark, fisheye, collage, split image, "
            "sunny, blue sky, summer, cycle lane, red asphalt, bicycle symbol, new trees, planted strips, crowd, "
            "architectural rendering")
VIEWPOINT = ("The pictures show the same street ({street}) today, photographed from its pavement on an overcast autumn morning. "
             "Create a new landscape photo of exactly this street as it is today, seen from the centre of the road, standing on "
             "the centre line between the two directions, about 2 metres above the ground, looking straight along the street "
             "{looking}, with the street vanishing in the middle of the picture. ")
TODAY = ("Show only what is in the photos: the same buildings, the same existing trees with their autumn leaves, the bus stop with "
         "its shelter, the lane markings, the kerbs, pavements, street lamps, signs, poles and the parked cars. Same overcast grey "
         "sky, same light and colours, same wet asphalt. Do not add anything that is not in the photos: no new trees, no cycle "
         "lanes, no planted strips, no people, no extra cars. A realistic photo, not a visualisation.")


def load_pipeline(model):
    """The pipeline on the GPU. Weight files are read whole instead of memory-mapped: on the
    GH200 (ARM) moving memory-mapped tensors to the GPU runs at ~20 MB/s, reading at GB/s."""
    path = pathlib.Path(model) if pathlib.Path(model).exists() else pathlib.Path(snapshot_download(model))
    sd = {}
    for f in sorted(glob.glob(str(path / "text_encoder/*.safetensors"))):
        sd.update(safetensors.torch.load(pathlib.Path(f).read_bytes()))
    text_encoder = Qwen2_5_VLForConditionalGeneration.from_pretrained(
        None, config=AutoConfig.from_pretrained(path / "text_encoder"), state_dict=sd, dtype=torch.bfloat16)
    del sd
    transformer = QwenImageTransformer2DModel.from_pretrained(path / "transformer", dtype=torch.bfloat16, disable_mmap=True)
    pipe = QwenImageEditPlusPipeline.from_pretrained(path, text_encoder=text_encoder, transformer=transformer, dtype=torch.bfloat16)
    return pipe.to("cuda")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("views", nargs="*", help="view ids (default: all)")
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--steps", type=int, default=40)
    ap.add_argument("--model", default=MODEL, help="Hugging Face id or local copy (much faster to load from a local disk)")
    a = ap.parse_args()

    cfg = json.loads((ROOT / "config/street.json").read_text())
    views = {v["id"]: v for v in cfg["views"]}
    todo = [r for r in cfg.get("centre_views", []) if not a.views or r["id"] in a.views]

    t0 = time.time()
    pipe = load_pipeline(a.model)
    print(f"model loaded in {time.time() - t0:.0f} s", flush=True)
    for r in todo:
        t = time.time()
        photos = [Image.open(ROOT / views[v]["image"]).convert("RGB") for v in r["photos"]]
        prompt = VIEWPOINT.format(street=cfg["street"], looking=r["looking"]) + TODAY
        out = pipe(image=photos, prompt=prompt, negative_prompt=NEGATIVE, true_cfg_scale=4.0, num_inference_steps=a.steps,
                   width=SIZE[0], height=SIZE[1], generator=torch.Generator("cuda").manual_seed(a.seed)).images[0]
        dest = ROOT / r["image"]
        dest.parent.mkdir(parents=True, exist_ok=True)
        out.save(dest, quality=90)
        print(f"{r['id']}: {dest.relative_to(ROOT)} in {time.time() - t:.0f} s", flush=True)


if __name__ == "__main__":
    main()
