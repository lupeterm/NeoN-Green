#!/usr/bin/env python3
"""Green redesign visualisations of the street in config/street.json ("redesigns").

    python scripts/redesign_street.py              # every redesign
    python scripts/redesign_street.py north        # one of them
    python scripts/redesign_street.py --seed 7     # another take, if one is not convincing

Each redesign gives the open model Qwen-Image-Edit-2511 (Apache 2.0) the street's photos
(data/street/*.jpg, taken from the pavement) and asks for a new picture of the same street from
the centre of the road, a few metres up, after a green redesign: tree rows, planted strips,
cycle lanes, one car lane per direction, people. It is an AI visualisation in the style of a
planning office's, not a planned design: the buildings are recognisable, details are invented.

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
SIZE = (1536, 1024)  # landscape, like a planning visualisation
NEGATIVE = ("cartoon, illustration, painting, drawing, flat colours, blurry, distorted, deformed, text, watermark, "
            "fisheye, collage, split image")
VIEWPOINT = ("The pictures show the same street ({street}) photographed from its pavement. Create a new landscape photo of this "
             "street seen from the centre of the road, about 3 metres above the ground, looking straight along the street "
             "{looking}, with the street vanishing in the middle of the picture and the buildings of picture 1 on both sides. ")
DESIGN = ("Show the street after a green redesign, like an architectural visualisation by a city planning office, on a sunny "
          "summer day with blue sky. In the middle: two grey asphalt car lanes, one per direction, with white dashed lane markings "
          "and a few cars. On each side of the car lanes: a red-coloured cycle lane, about 2 metres wide, separated by a white "
          "line, with a few cyclists. Beyond each cycle lane: a planted green strip with grass and shrubs and a row of tall, "
          "mature, lush deciduous street trees giving shade, then a wide pavement with people walking. Photorealistic, natural "
          "light and leaf shadows.")


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
    ap.add_argument("redesigns", nargs="*", help="redesign ids (default: all)")
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--steps", type=int, default=40)
    ap.add_argument("--model", default=MODEL, help="Hugging Face id or local copy (much faster to load from a local disk)")
    a = ap.parse_args()

    cfg = json.loads((ROOT / "config/street.json").read_text())
    views = {v["id"]: v for v in cfg["views"]}
    todo = [r for r in cfg.get("redesigns", []) if not a.redesigns or r["id"] in a.redesigns]

    t0 = time.time()
    pipe = load_pipeline(a.model)
    print(f"model loaded in {time.time() - t0:.0f} s", flush=True)
    for r in todo:
        t = time.time()
        photos = [Image.open(ROOT / views[v]["image"]).convert("RGB") for v in r["photos"]]
        prompt = VIEWPOINT.format(street=cfg["street"], looking=r["looking"]) + DESIGN
        out = pipe(image=photos, prompt=prompt, negative_prompt=NEGATIVE, true_cfg_scale=4.0, num_inference_steps=a.steps,
                   width=SIZE[0], height=SIZE[1], generator=torch.Generator("cuda").manual_seed(a.seed)).images[0]
        dest = ROOT / r["image"]
        dest.parent.mkdir(parents=True, exist_ok=True)
        out.save(dest, quality=90)
        print(f"{r['id']}: {dest.relative_to(ROOT)} in {time.time() - t:.0f} s", flush=True)


if __name__ == "__main__":
    main()
