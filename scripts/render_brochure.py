#!/usr/bin/env python3
"""Render docs/brochure/brochure.html to brochure.png (2048 x 3072 px).

    pip install playwright && python -m playwright install chromium
    python scripts/render_brochure.py

The brochure's screenshots in docs/brochure/img/ are taken from the app; edit the HTML for the
text and numbers, then render again.
"""
import pathlib

from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parents[1]
PAGE = ROOT / "docs/brochure/brochure.html"
OUT = ROOT / "brochure.png"


def main():
    with sync_playwright() as p:
        page = p.chromium.launch().new_page(viewport={"width": 1024, "height": 1536}, device_scale_factor=2)
        page.goto(PAGE.as_uri())
        page.wait_for_load_state("networkidle")
        page.screenshot(path=str(OUT), full_page=False)
    print(f"{OUT.relative_to(ROOT)} written")


if __name__ == "__main__":
    main()
