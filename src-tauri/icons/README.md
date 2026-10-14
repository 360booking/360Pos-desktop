# Tauri icons — 360restaurants

Iconul aplicației POS de Windows: semnul 360restaurants (tacâmuri + clădire,
albastru) între cele două săgeți portocalii din logo, pe o placă albă cu
colțuri rotunjite — se vede la fel pe bara de activități deschisă și închisă.

## Files

The three paths referenced by `src-tauri/tauri.conf.json` (`bundle.icon`):

- `32x32.png`     — taskbar / small UI icon
- `128x128.png`   — installer / Start Menu
- `icon.ico`      — Windows multi-resolution icon (16, 24, 32, 48, 64, 128, 256)

The rest (`64x64.png`, `128x128@2x.png`, `Square*Logo.png`, `StoreLogo.png`,
`icon.png`) are kept for completeness.

Sub 48px săgețile portocalii dispar și rămâne doar semnul, mai mare: la 16–32px
săgețile deveneau o linie subțire care încurca desenul.

## Regenerating

`source-1024.png` e varianta mare. Fișierele au fost generate cu Pillow din
logo-ul curățat (`restaurants360.png`), cadru cu cadru, ca mărimile mici să
nu fie doar o micșorare a celei mari. Dacă se schimbă logo-ul, se pot
regenera și cu `npx @tauri-apps/cli icon src-tauri/icons/source-1024.png`
(atunci și mărimile mici vor avea săgețile).
