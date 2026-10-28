#!/usr/bin/env python3
"""Realistic tree and car cut-outs for the street view (data/street/sprites/).

    python scripts/make_sprites.py                # everything
    python scripts/make_sprites.py tree-medium-1  # one of them

The open model Qwen-Image-Edit-2511 (Apache 2.0, loaded as in centre_view.py) paints each
object alone on a plain magenta canvas; the magenta is keyed out to transparency. sprites.json
records, per cut-out, the ground point (bottom centre, in pixels) and pixels per metre, so
street.js can draw it at the right size for its distance. Sizes are the tree presets of
config/model.json and typical car dimensions.
"""
import argparse
import json
import pathlib
import sys
import time

import numpy as np
import torch
from PIL import Image, ImageFilter

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from centre_view import MODEL, load_pipeline  # noqa: E402

ROOT = pathlib.Path(__file__).resolve().parents[1]
OUT = ROOT / "data/street/sprites"
RAW = OUT / "raw"   # model output before keying, not committed
KEY = (255, 0, 255)
LIGHT = ("Soft, even light of an overcast autumn day, no harsh shadows. Realistic photo, sharp, natural colours. The object stands "
         "alone in the middle of the picture, completely visible, on a perfectly flat, uniform, pure magenta (#FF00FF) background "
         "with nothing else: no ground, no floor, no shadow, no other objects, no text.")
NEGATIVE = "cartoon, illustration, drawing, painting, 3d render, cut off, cropped, multiple objects, ground, grass, floor, shadow, text"
TREE = {
    "small": "a young street tree, about 6 metres tall, with a thin straight trunk staked to a wooden post and a small, round crown",
    "medium": "a street tree, about 12 metres tall, with a straight trunk, a clear stem up to about 3 metres and a broad, dense crown",
    "large": "a large mature street tree, about 18 metres tall, with a thick trunk and a wide, dense crown",
}
SPECIES = ["a lime tree (linden)", "a plane tree"]
CAR_COLOURS = ["dark grey", "silver", "white"]
CAR_VIEW = {"rear": "seen straight from behind, at eye level", "front": "seen straight from the front, at eye level",
            "side": "seen exactly from the left side, at eye level, the front pointing to the right"}


def jobs():
    for preset, desc in TREE.items():
        for i, species in enumerate(SPECIES, 1):
            yield {"id": f"tree-{preset}-{i}", "kind": "tree", "preset": preset, "size": (768, 1024),
                   "prompt": f"A photo of {desc}, {species}, in green summer leaf with the first yellow leaves. {LIGHT}"}
    for side, view in CAR_VIEW.items():
        for i, colour in enumerate(CAR_COLOURS, 1):
            yield {"id": f"car-{side}-{i}", "kind": "car", "side": side, "size": (1024, 768),
                   "prompt": f"A photo of a {colour} modern compact family car (hatchback), {view}. {LIGHT}"}


def cut_out(img):
    """RGBA from an image on magenta. Alpha from the distance to the key colour; edge pixels are
    un-mixed from the magenta (I = a*F + (1-a)*K) and the edge is trimmed by a pixel."""
    a = np.asarray(img.convert("RGB"), np.float32)
    r, g, b = a[..., 0], a[..., 1], a[..., 2]
    keyness = np.clip((np.minimum(r, b) - g) / 120, 0, 1)        # 1 on pure magenta, 0 on anything green or grey
    alpha = 1 - np.clip((keyness - 0.25) / 0.5, 0, 1)
    alpha = np.asarray(Image.fromarray(np.uint8(alpha * 255)).filter(ImageFilter.MedianFilter(3))
                       .filter(ImageFilter.MinFilter(3)).filter(ImageFilter.GaussianBlur(0.6)), np.float32) / 255
    k = np.array(KEY, np.float32)
    fg = (a - (1 - alpha[..., None]) * k) / np.maximum(alpha[..., None], 0.15)
    spill = np.clip(np.minimum(fg[..., 0], fg[..., 2]) - fg[..., 1], 0, None)   # magenta tint left in windows and shadows
    fg[..., 0] -= spill
    fg[..., 2] -= spill
    out = Image.fromarray(np.uint8(np.clip(fg, 0, 255))).convert("RGBA")
    out.putalpha(Image.fromarray(np.uint8(alpha * 255)))
    return out.crop(out.getchannel("A").point(lambda v: 255 if v > 40 else 0).getbbox())


def ground(sprite, job, model):
    """Ground point (bottom centre of trunk or wheels) and pixels per metre."""
    alpha = np.asarray(sprite.getchannel("A")) > 40
    h, w = alpha.shape
    rows = np.where(alpha.any(axis=1))[0]
    bottom = rows[-1]
    base = np.where(alpha[max(0, bottom - max(4, h // 40)):bottom + 1].any(axis=0))[0]
    gx = float((base[0] + base[-1]) / 2) if job["kind"] == "tree" else w / 2
    if job["kind"] == "tree":
        px_per_m = (bottom + 1 - rows[0]) / model["presets"][job["preset"]]["height_m"]
    else:
        px_per_m = w / (4.4 if job["side"] == "side" else 1.8)
    return [round(gx, 1), int(bottom)], round(float(px_per_m), 2)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("ids", nargs="*")
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--model", default=MODEL)
    ap.add_argument("--rekey", action="store_true", help="cut out the saved raw images again, without the model")
    a = ap.parse_args()
    model = json.loads((ROOT / "config/model.json").read_text())
    todo = [j for j in jobs() if not a.ids or j["id"] in a.ids]
    OUT.mkdir(parents=True, exist_ok=True)
    index_path = OUT / "sprites.json"
    index = json.loads(index_path.read_text()) if index_path.exists() else {}

    RAW.mkdir(parents=True, exist_ok=True)
    pipe = None if a.rekey else load_pipeline(a.model)
    for job in todo:
        t = time.time()
        w, h = job["size"]
        if a.rekey:
            raw = Image.open(RAW / f"{job['id']}.png")
        else:
            canvas = Image.new("RGB", (w, h), KEY)
            raw = pipe(image=[canvas], prompt=job["prompt"], negative_prompt=NEGATIVE, true_cfg_scale=4.0, num_inference_steps=40,
                       width=w, height=h, generator=torch.Generator("cuda").manual_seed(a.seed)).images[0]
            raw.save(RAW / f"{job['id']}.png")
        sprite = cut_out(raw)
        sprite.save(OUT / f"{job['id']}.png", optimize=True)
        anchor, ppm = ground(sprite, job, model)
        index[job["id"]] = {k: job[k] for k in ("kind", "preset", "side") if k in job} | {
            "image": f"data/street/sprites/{job['id']}.png", "ground": anchor, "px_per_m": ppm}
        print(f"{job['id']}: {sprite.size[0]}x{sprite.size[1]} px in {time.time() - t:.0f} s", flush=True)
    index_path.write_text(json.dumps(dict(sorted(index.items())), indent=1) + "\n")


if __name__ == "__main__":
    main()
