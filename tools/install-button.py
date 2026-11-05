"""Writes the README's INSTALL NOW button as two SVGs (GitHub light and dark themes), in the Grove's look.

python tools/install-button.py .github/assets

Text is converted to outlines from the Grove skin's font (Fraunces, SIL OFL) because images in a README
cannot load web fonts. The bird is the app's icon, embedded for the same reason. Needs agent-guild checked out
beside this repo, for the font, and fontTools, brotli and Pillow.
"""
import base64
import io
import math
import os
import sys

from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
FONT = os.path.join(HERE, "..", "..", "agent-guild", "web", "skins", "grove", "fonts", "fraunces.woff2")
BIRD = os.path.join(HERE, "..", "src-tauri", "icons", "128x128@2x.png")

W, H = 760, 212
PX, PY, PW, PH = 46, 42, 668, 128
CUT = 24
CY = PY + PH / 2
EMBLEM_X = PX + 86

# Simple Icons' marks, on a 24 x 24 grid.
WINDOWS = "M0 3.449L9.75 2.1v9.451H0m10.949-9.602L24 0v11.4H10.949M0 12.6h9.75v9.451L0 20.699M10.949 12.6H24V24l-12.9-1.801"
APPLE = ("M12.152 6.896c-.948 0-2.415-1.078-3.96-1.04-2.04.027-3.91 1.183-4.961 3.014-2.117 3.675-.546 9.103 1.519 12.09 "
         "1.013 1.454 2.208 3.09 3.792 3.039 1.52-.065 2.09-.987 3.935-.987 1.831 0 2.35.987 3.96.948 1.637-.026 2.676-1.48 "
         "3.676-2.948 1.156-1.688 1.636-3.325 1.662-3.415-.039-.013-3.182-1.221-3.22-4.857-.026-3.04 2.48-4.494 2.597-4.559"
         "-1.429-2.09-3.623-2.324-4.39-2.376-2-.156-3.675 1.09-4.61 1.09zM15.53 3.83c.843-1.012 1.4-2.427 1.245-3.83-1.207.052"
         "-2.662.805-3.532 1.818-.78.896-1.454 2.338-1.273 3.714 1.338.104 2.715-.688 3.559-1.701")


def font(weight):
    f = TTFont(FONT)
    if "fvar" in f:
        axes = {axis.axisTag: axis.defaultValue for axis in f["fvar"].axes}
        axes["wght"] = weight
        f = instancer.instantiateVariableFont(f, axes)
    return f


def outline(f, text, size, tracking):
    """Path data for `text` at `size`, baseline at y=0, and its advance width."""
    glyphs = f.getGlyphSet()
    cmap = f.getBestCmap()
    scale = size / f["head"].unitsPerEm
    pen = SVGPathPen(glyphs)
    x = 0.0
    for i, ch in enumerate(text):
        name = cmap[ord(ch)]
        glyphs[name].draw(TransformPen(pen, (scale, 0, 0, -scale, x, 0)))
        x += glyphs[name].width * scale
        if i < len(text) - 1:
            x += size * tracking
    return pen.getCommands(), x


def chamfer(x, y, w, h, c):
    return f"M{x + c},{y} H{x + w - c} L{x + w},{y + c} V{y + h - c} L{x + w - c},{y + h} H{x + c} L{x},{y + h - c} V{y + c} Z"


def bird():
    image = Image.open(BIRD).convert("RGBA").resize((156, 156), Image.LANCZOS)
    out = io.BytesIO()
    image.save(out, "WEBP", quality=82, method=6)
    return "data:image/webp;base64," + base64.b64encode(out.getvalue()).decode()


def fireflies():
    # Seeded by hand: scattered round the plate's right end and behind the emblem, none over the words.
    spots = [(72, 66, 1.7), (92, 148, 1.3), (176, 62, 1.4), (190, 152, 1.2), (640, 62, 1.5), (664, 74, 1.9), (690, 92, 1.3),
             (672, 134, 1.7), (646, 152, 1.3), (696, 126, 1.2), (612, 150, 1.1), (624, 58, 1.1)]
    return "".join(
        f'<circle class="fly" style="animation-delay:{i * .37:.2f}s" cx="{x}" cy="{y}" r="{r}" fill="#e4ff6e" filter="url(#fly)"/>'
        for i, (x, y, r) in enumerate(spots))


def svg(theme):
    heavy = font(700)
    light = font(500)
    title, title_w = outline(heavy, "INSTALL NOW", 50, 0.075)
    sub, sub_w = outline(light, "AGENT GUILD: GROVE COMPANION", 12.5, 0.2)

    logo = 14
    logos_w = logo * 2 + 11
    gap = 16
    text_l = PX + 178
    text_r = PX + PW - 66
    middle = (text_l + text_r) / 2
    title_x = middle - title_w / 2
    row_w = sub_w + gap + logos_w
    sub_x = middle - row_w / 2
    title_y = CY + 11
    sub_y = CY + 40
    logos_x = sub_x + sub_w + gap
    logos_y = sub_y - logo + 2

    frame = chamfer(PX, PY, PW, PH, CUT)
    plate = chamfer(PX + 3, PY + 3, PW - 6, PH - 6, CUT - 1.2)
    inner = chamfer(PX + 9, PY + 9, PW - 18, PH - 18, CUT - 3.7)
    if theme == "dark":
        halo = f'<path d="{frame}" fill="url(#grove)" opacity=".5" filter="url(#halo)"/>'
        drop = f'<path d="{frame}" fill="#000" opacity=".6" transform="translate(0 8)" filter="url(#drop)"/>'
    else:
        halo = f'<path d="{frame}" fill="url(#grove)" opacity=".32" filter="url(#halo)"/>'
        drop = f'<path d="{frame}" fill="#10210f" opacity=".35" transform="translate(0 10)" filter="url(#drop)"/>'

    chevrons = "".join(f'<path class="chev c{i}" d="M{PX + PW - 58 + i * 12},{CY - 9} l8,9 l-8,9" />' for i in range(3))
    orbit_x = EMBLEM_X + 46 * math.cos(math.radians(-24))
    orbit_y = CY + 21 * math.sin(math.radians(-24))

    return f"""<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}" role="img" aria-labelledby="t">
<title id="t">Install Agent Guild: Grove Companion for Windows or macOS</title>
<defs>
  <linearGradient id="gold" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#fff3cf"/><stop offset=".28" stop-color="#f1dc9a"/>
    <stop offset=".55" stop-color="#d8c07a"/><stop offset=".78" stop-color="#a5863e"/>
    <stop offset="1" stop-color="#e6cf8a"/>
  </linearGradient>
  <linearGradient id="goldText" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#fff8e0"/><stop offset=".42" stop-color="#f0dc9c"/>
    <stop offset=".62" stop-color="#cdb06a"/><stop offset="1" stop-color="#9a7d3a"/>
  </linearGradient>
  <linearGradient id="frameSheen" x1="0" y1="0" x2="1" y2="0">
    <stop offset="0" stop-color="#6a5420"/><stop offset=".18" stop-color="#f1dc9a"/>
    <stop offset=".5" stop-color="#a5863e"/><stop offset=".82" stop-color="#f1dc9a"/>
    <stop offset="1" stop-color="#6a5420"/>
  </linearGradient>
  <linearGradient id="grove" x1="0" y1="0" x2="1" y2="0">
    <stop offset="0" stop-color="#7fd0c4"/><stop offset=".5" stop-color="#6fae72"/><stop offset="1" stop-color="#d7ee6e"/>
  </linearGradient>
  <linearGradient id="plate" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#16261b"/><stop offset=".5" stop-color="#0d1a12"/><stop offset="1" stop-color="#081109"/>
  </linearGradient>
  <linearGradient id="moss" x1="0" y1="0" x2="1" y2="0">
    <stop offset="0" stop-color="#3b7550" stop-opacity=".62"/><stop offset=".3" stop-color="#3b7550" stop-opacity=".1"/>
    <stop offset=".8" stop-color="#3b7550" stop-opacity="0"/><stop offset="1" stop-color="#7b9a3a" stop-opacity=".34"/>
  </linearGradient>
  <linearGradient id="sweep" x1="0" y1="0" x2="1" y2="0">
    <stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset=".5" stop-color="#fff6d0" stop-opacity=".2"/>
    <stop offset="1" stop-color="#fff" stop-opacity="0"/>
  </linearGradient>
  <linearGradient id="hair" x1="0" y1="{CY - 46}" x2="0" y2="{CY + 46}" gradientUnits="userSpaceOnUse">
    <stop offset="0" stop-color="#d8c07a" stop-opacity="0"/><stop offset=".5" stop-color="#d8c07a" stop-opacity=".75"/>
    <stop offset="1" stop-color="#d8c07a" stop-opacity="0"/>
  </linearGradient>
  <radialGradient id="well" cx=".5" cy=".42" r=".62">
    <stop offset="0" stop-color="#3a6a48"/><stop offset="1" stop-color="#0e1c13"/>
  </radialGradient>
  <filter id="halo" x="-20%" y="-60%" width="140%" height="220%"><feGaussianBlur stdDeviation="11"/></filter>
  <filter id="drop" x="-20%" y="-60%" width="140%" height="220%"><feGaussianBlur stdDeviation="9"/></filter>
  <filter id="glow" x="-60%" y="-60%" width="220%" height="220%"><feGaussianBlur stdDeviation="9"/></filter>
  <filter id="fly" x="-300%" y="-300%" width="700%" height="700%"><feGaussianBlur stdDeviation=".7"/></filter>
  <filter id="engrave" x="-5%" y="-30%" width="110%" height="160%"><feDropShadow dx="0" dy="1.6" stdDeviation=".8" flood-color="#000" flood-opacity=".8"/></filter>
  <clipPath id="inside"><path d="{plate}"/></clipPath>
  <clipPath id="well-clip"><circle cx="{EMBLEM_X}" cy="{CY}" r="31"/></clipPath>
</defs>
<style>
  .sweep {{ animation: sweep 5.5s cubic-bezier(.45,0,.25,1) infinite; }}
  .pulse {{ animation: pulse 2.8s ease-in-out infinite; transform-origin: {EMBLEM_X}px {CY}px; }}
  .orbit {{ animation: spin 14s linear infinite; transform-origin: {EMBLEM_X}px {CY}px; }}
  .fly {{ opacity: .2; animation: fly 3.4s ease-in-out infinite; }}
  .chev {{ fill: none; stroke: #e4d48c; stroke-width: 2.4; stroke-linecap: round; stroke-linejoin: round; opacity: .4; animation: chev 1.8s ease-in-out infinite; }}
  .c1 {{ animation-delay: .18s; }} .c2 {{ animation-delay: .36s; }}
  @keyframes sweep {{ 0% {{ transform: translateX(-260px) skewX(-22deg); }} 55%, 100% {{ transform: translateX({PW + 260}px) skewX(-22deg); }} }}
  @keyframes pulse {{ 0%, 100% {{ opacity: .45; transform: scale(.94); }} 50% {{ opacity: .9; transform: scale(1.06); }} }}
  @keyframes spin {{ to {{ transform: rotate(360deg); }} }}
  @keyframes chev {{ 0%, 100% {{ opacity: .35; }} 40% {{ opacity: 1; }} }}
  @keyframes fly {{ 0%, 100% {{ opacity: .12; }} 50% {{ opacity: 1; }} }}
  @media (prefers-reduced-motion: reduce) {{
    .sweep {{ display: none; }} .pulse, .orbit, .chev, .fly {{ animation: none; }} .chev, .fly {{ opacity: .7; }}
  }}
</style>
{drop}
{halo}
<path d="{frame}" fill="url(#frameSheen)"/>
<path d="{plate}" fill="url(#plate)"/>
<g clip-path="url(#inside)">
  <rect x="{PX}" y="{PY}" width="{PW}" height="{PH}" fill="url(#moss)"/>
  <rect class="sweep" x="{PX}" y="{PY}" width="150" height="{PH}" fill="url(#sweep)"/>
  <path d="M{PX},{PY + 3.6} H{PX + PW}" stroke="#f1dc9a" stroke-opacity=".35" stroke-width="1"/>
  {fireflies()}
</g>
<path d="{inner}" fill="none" stroke="#d8c07a" stroke-opacity=".22" stroke-width="1"/>
<g class="pulse"><circle cx="{EMBLEM_X}" cy="{CY}" r="38" fill="#6fae72" opacity=".8" filter="url(#glow)"/></g>
<g class="orbit">
  <ellipse cx="{EMBLEM_X}" cy="{CY}" rx="46" ry="21" fill="none" stroke="#d8c07a" stroke-opacity=".6" stroke-width="1.1" transform="rotate(-24 {EMBLEM_X} {CY})"/>
  <circle cx="{orbit_x:.2f}" cy="{orbit_y:.2f}" r="2.6" fill="#e4ff6e"/>
</g>
<circle cx="{EMBLEM_X}" cy="{CY}" r="34" fill="url(#gold)"/>
<circle cx="{EMBLEM_X}" cy="{CY}" r="31" fill="url(#well)"/>
<image clip-path="url(#well-clip)" href="{bird()}" x="{EMBLEM_X - 30}" y="{CY - 29}" width="60" height="60"/>
<path d="M{PX + 160},{CY - 46} V{CY + 46}" stroke="url(#hair)" stroke-width="1"/>
<path d="M{PX + 160},{CY - 3.4} l3.4,3.4 l-3.4,3.4 l-3.4,-3.4 z" fill="#f1dc9a"/>
<path transform="translate({title_x:.2f} {title_y:.2f})" d="{title}" fill="url(#goldText)" filter="url(#engrave)"/>
<path transform="translate({sub_x:.2f} {sub_y:.2f})" d="{sub}" fill="#c8d6c0"/>
<g fill="#dfe8d8" aria-hidden="true">
  <path transform="translate({logos_x:.2f} {logos_y:.2f}) scale({logo / 24})" d="{WINDOWS}"/>
  <path transform="translate({logos_x + logo + 11:.2f} {logos_y:.2f}) scale({logo / 24})" d="{APPLE}"/>
</g>
{chevrons}
</svg>
"""


def main():
    out = sys.argv[1]
    os.makedirs(out, exist_ok=True)
    for theme in ("dark", "light"):
        path = os.path.join(out, f"install-now-{theme}.svg")
        with open(path, "w", encoding="utf-8", newline="\n") as f:
            f.write(svg(theme))
        print(path, os.path.getsize(path))


main()
