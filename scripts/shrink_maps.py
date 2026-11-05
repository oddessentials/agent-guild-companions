"""Shrinks the models' textures for a small character on a desktop, keeping each file's name.

    python -I scripts/shrink_maps.py <maps folder> <largest edge in pixels>

Colour stays lossy WebP at high quality. Run from npm run vendor, with Pillow installed.
"""
import pathlib
import sys

from PIL import Image

folder, edge = pathlib.Path(sys.argv[1]), int(sys.argv[2])
for path in sorted(folder.glob('*.webp')):
    with Image.open(path) as image:
        if max(image.size) <= edge:
            continue
        small = image.resize((edge, edge), Image.LANCZOS)
    small.save(path, 'WEBP', quality=88, method=6)
