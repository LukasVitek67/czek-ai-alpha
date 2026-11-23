# Obrázek, který přenosné czek-ai.exe ukáže hned po dvojkliku, než se aplikace (~0,7 GB) rozbalí do %TEMP%
# (Windows, 22.–23. 11.: 21–23 s bez jakékoli odezvy → student klikne znovu). electron-builder portable.splashImage
# chce .bmp. Barvy z src/renderer/splash.html (světlý motiv). Spuštění: python tools/make-portable-splash.py
from PIL import Image, ImageDraw, ImageFont
import os
W, H = 480, 260
BG, TEXT, MUTED, ACCENT, RULE = '#f7f6f3', '#1d1d1b', '#6d6b65', '#2f6f4f', '#dfddd6'
root = os.path.join(os.path.dirname(__file__), '..')
im = Image.new('RGB', (W, H), BG)
d = ImageDraw.Draw(im)
d.rectangle([0, 0, W - 1, H - 1], outline=RULE)
icon = Image.open(os.path.join(root, 'build', 'icon.png')).convert('RGBA').resize((72, 72), Image.LANCZOS)
im.paste(icon, (40, 54), icon)
def font(size, bold=False):
    for f in (['segoeuib.ttf', 'arialbd.ttf'] if bold else ['segoeui.ttf', 'arial.ttf']):
        try: return ImageFont.truetype(f, size)
        except OSError: pass
    return ImageFont.load_default()
d.text((132, 58), 'czek-ai', fill=TEXT, font=font(30, True))
d.text((132, 100), 'Spouštím se…', fill=ACCENT, font=font(17, True))
d.text((40, 160), 'Rozbaluji aplikaci, trvá to asi 20 s.', fill=TEXT, font=font(15))
d.text((40, 184), 'Neklikej znovu, okno se otevře samo.', fill=MUTED, font=font(15))
out = os.path.join(root, 'build', 'portable-splash.bmp')
im.save(out, 'BMP')
print(out, im.size)
