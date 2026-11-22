#!/usr/bin/env python3
"""Build every app icon in public/ from the 1024px master in assets/app-icon.png.

The master is a full-bleed square (opaque, no rounded corners) generated with
Codex image generation: the 詰 piece on a red background, with the ghost peeking
from behind its right shoulder. Its background must be a single flat color,
because the maskable icons are padded with the color of its top-left pixel.

Outputs:
    public/icons/icon-{192,512}.png           purpose "any": rounded corners
    public/icons/icon-maskable-{192,512}.png  purpose "maskable": full bleed,
                                              art shrunk into the safe zone
    public/icons/apple-touch-icon.png         180px, full bleed (iOS rounds it)
    public/favicon.ico                        16/32/48px

Requires Pillow (pip install pillow).
"""

from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
MASTER = ROOT / "assets" / "app-icon.png"
ICONS = ROOT / "public" / "icons"

# Corner radius of the "any" icons, as a fraction of the size (close to the
# iOS / macOS app icon shape).
CORNER_RATIO = 0.225
# Maskable icons must keep everything inside a circle of radius 40% of the
# size. The art reaches about 43% from the center, so shrink it to fit.
MASKABLE_SCALE = 0.88


def resize(image: Image.Image, size: int) -> Image.Image:
    return image.resize((size, size), Image.LANCZOS)


def rounded(image: Image.Image, size: int) -> Image.Image:
    # Draw the mask at 4x and scale it down so the corners are antialiased.
    big = size * 4
    mask = Image.new("L", (big, big), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        (0, 0, big - 1, big - 1), radius=round(big * CORNER_RATIO), fill=255
    )
    out = resize(image, size).convert("RGBA")
    out.putalpha(mask.resize((size, size), Image.LANCZOS))
    return out


def maskable(image: Image.Image, size: int) -> Image.Image:
    background = image.getpixel((0, 0))
    inner = round(size * MASKABLE_SCALE)
    out = Image.new("RGB", (size, size), background)
    offset = (size - inner) // 2
    out.paste(resize(image, inner), (offset, offset))
    return out


def main() -> None:
    master = Image.open(MASTER).convert("RGB")
    if master.size != (1024, 1024):
        raise SystemExit(f"{MASTER} must be 1024x1024, got {master.size}")

    ICONS.mkdir(parents=True, exist_ok=True)
    for size in (192, 512):
        rounded(master, size).save(ICONS / f"icon-{size}.png", optimize=True)
        maskable(master, size).save(ICONS / f"icon-maskable-{size}.png", optimize=True)
    resize(master, 180).save(ICONS / "apple-touch-icon.png", optimize=True)
    master.save(ROOT / "public" / "favicon.ico", sizes=[(16, 16), (32, 32), (48, 48)])
    print(f"wrote icons from {MASTER.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
