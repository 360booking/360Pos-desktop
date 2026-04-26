"""
Generate a placeholder 1024x1024 source PNG for the Tauri icon set.

This is a TEMPORARY placeholder so `pnpm tauri build` does not fail with
"icons not found". Replace with a real brand icon before public release.

Run: python3 source-1024.png.gen.py
"""
from PIL import Image, ImageDraw, ImageFont

SIZE = 1024
BG = (15, 23, 42)        # slate-900
FG = (250, 204, 21)      # amber-400
RING = (251, 191, 36)    # amber-400/500

img = Image.new("RGBA", (SIZE, SIZE), BG + (255,))
d = ImageDraw.Draw(img)

# Outer rounded-square ring
pad = 64
d.rounded_rectangle(
    (pad, pad, SIZE - pad, SIZE - pad),
    radius=180,
    outline=RING,
    width=24,
)

# Inner solid block
inner = 220
d.rounded_rectangle(
    (inner, inner, SIZE - inner, SIZE - inner),
    radius=120,
    fill=FG,
)

# "POS" wordmark — fall back to default font if no TTF is available.
text = "POS"
try:
    font = ImageFont.truetype(
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", 320
    )
except OSError:
    font = ImageFont.load_default()

bbox = d.textbbox((0, 0), text, font=font)
tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
d.text(
    ((SIZE - tw) / 2 - bbox[0], (SIZE - th) / 2 - bbox[1] - 20),
    text,
    fill=BG,
    font=font,
)

img.save("source-1024.png", "PNG")
print("wrote source-1024.png")
