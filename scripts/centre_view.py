#!/usr/bin/env python3
"""Views of the street from the centre of the road, made from the photos (config/street.json, "centre_views").

    python scripts/centre_view.py              # every view
    python scripts/centre_view.py north        # one of them
    python scripts/centre_view.py --seed 7     # another take, if one is not convincing
    python scripts/centre_view.py south --edit-only --seeds 3   # redo only the lane edit, 3 takes

A view may have an "edit" (here: the lane layout of the south view): the model removes road
lettering by instruction, only that area is kept, then the script paints new road lettering onto
the ground in perspective, into a quadrilateral given in image pixels. The image before the edit is kept.

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

import cv2
import numpy as np

import safetensors.torch
import torch
from diffusers import QwenImageEditPlusPipeline, QwenImageTransformer2DModel
from huggingface_hub import snapshot_download
from PIL import Image, ImageDraw, ImageFilter, ImageFont
from transformers import AutoConfig, Qwen2_5_VLForConditionalGeneration

ROOT = pathlib.Path(__file__).resolve().parents[1]
MODEL = "Qwen/Qwen-Image-Edit-2511"
SIZE = (1536, 1024)  # landscape
FONT = "DejaVuSans-Bold.ttf"  # road lettering (Pillow finds it in the system font folders)
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


def edit(pipe, image, e, seed, steps):
    """A view's "edit": the model follows "instruction" on the whole view, but only the area around the
    bright marking pixels inside "remove" (not near "keep_line") is taken from its result; then "text"
    is painted onto the road in perspective."""
    a = np.asarray(image.convert("L"))
    x0, y0, x1, y1 = e["remove"]["box"]
    m = np.zeros(a.shape, np.uint8)
    m[y0:y1, x0:x1] = a[y0:y1, x0:x1] > e["remove"].get("brightness", 150)
    cv2.line(m, *[tuple(q) for q in e["remove"]["keep_line"]], 0, e["remove"]["keep_width"])
    mask = Image.fromarray(cv2.dilate(m * 255, np.ones((25, 25), np.uint8))).filter(ImageFilter.GaussianBlur(6))
    out = pipe(image=[image], prompt=e["instruction"], negative_prompt=NEGATIVE, true_cfg_scale=4.0, num_inference_steps=steps,
               width=image.width, height=image.height, generator=torch.Generator("cuda").manual_seed(seed)).images[0]
    out = Image.composite(out.resize(image.size), image, mask)
    return paint_text(out, e["text"]) if "text" in e else out


def paint_text(image, t):
    """Road lettering: t["text"] painted into t["quad"] (image pixels: far left, far right, near right,
    near left on the road), letter bottoms towards the camera, stretched along the road as road
    lettering is, as worn white paint."""
    font = ImageFont.truetype(FONT, 200)
    box = ImageDraw.Draw(Image.new("L", (1, 1))).textbbox((0, 0), t["text"], font=font)
    tile = Image.new("L", (box[2] - box[0], box[3] - box[1]), 0)
    ImageDraw.Draw(tile).text((-box[0], -box[1]), t["text"], font=font, fill=255)
    w, h = tile.size
    M = cv2.getPerspectiveTransform(np.float32([[0, 0], [w, 0], [w, h], [0, h]]), np.float32(t["quad"]))
    alpha = cv2.warpPerspective(np.asarray(tile, np.float32) / 255, M, image.size, flags=cv2.INTER_AREA)
    wear = cv2.GaussianBlur(np.random.default_rng(1).random(alpha.shape).astype(np.float32), (0, 0), 1.0)
    alpha *= np.clip(0.55 + 0.6 * wear, 0.4, 0.92)
    base = np.asarray(image, np.float32)
    paint = np.float32(t.get("colour", [222, 224, 220])) * (0.8 + 0.2 * base / 255)   # keeps a little of the wet sheen
    return Image.fromarray(np.uint8(np.clip(base + (paint - base) * alpha[..., None], 0, 255)))


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("views", nargs="*", help="view ids (default: all)")
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--steps", type=int, default=40)
    ap.add_argument("--model", default=MODEL, help="Hugging Face id or local copy (much faster to load from a local disk)")
    ap.add_argument("--edit-only", action="store_true",
                    help="only redo a view's 'edit' (repaint part of it), starting from its image before the edit")
    ap.add_argument("--seeds", type=int, default=1, help="with --edit-only: try this many seeds, saved next to the image")
    a = ap.parse_args()

    cfg = json.loads((ROOT / "config/street.json").read_text())
    views = {v["id"]: v for v in cfg["views"]}
    todo = [r for r in cfg.get("centre_views", []) if not a.views or r["id"] in a.views]

    t0 = time.time()
    pipe = load_pipeline(a.model)
    print(f"model loaded in {time.time() - t0:.0f} s", flush=True)
    for r in todo:
        t = time.time()
        dest = ROOT / r["image"]
        before = dest.with_name(dest.stem + "_before_edit.jpg")  # kept, so an edit can be redone
        if a.edit_only:
            if "edit" not in r:
                continue
            base = Image.open(before if before.exists() else dest).convert("RGB")
            if not before.exists():
                base.save(before, quality=90)
            # one take: the edit's chosen seed; several: seeds from --seed on, to choose from
            for seed in range(a.seed, a.seed + a.seeds) if a.seeds > 1 else [r["edit"].get("seed", a.seed)]:
                out = edit(pipe, base, r["edit"], seed, a.steps)
                target = dest if a.seeds == 1 else dest.with_name(f"{dest.stem}_seed{seed}.jpg")
                out.save(target, quality=90)
                print(f"{r['id']}: edit, seed {seed} -> {target.relative_to(ROOT)} in {time.time() - t:.0f} s", flush=True)
            continue
        photos = [Image.open(ROOT / views[v]["image"]).convert("RGB") for v in r["photos"]]
        prompt = VIEWPOINT.format(street=cfg["street"], looking=r["looking"]) + TODAY
        out = pipe(image=photos, prompt=prompt, negative_prompt=NEGATIVE, true_cfg_scale=4.0, num_inference_steps=a.steps,
                   width=SIZE[0], height=SIZE[1], generator=torch.Generator("cuda").manual_seed(a.seed)).images[0]
        dest.parent.mkdir(parents=True, exist_ok=True)
        if "edit" in r:
            out.save(before, quality=90)
            out = edit(pipe, out, r["edit"], r["edit"].get("seed", a.seed), a.steps)
        out.save(dest, quality=90)
        print(f"{r['id']}: {dest.relative_to(ROOT)} in {time.time() - t:.0f} s", flush=True)


if __name__ == "__main__":
    main()
