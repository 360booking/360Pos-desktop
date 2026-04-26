# Tauri icons — placeholder set

> **TEMPORARY.** These icons exist only so `pnpm tauri build` does not abort
> with "icon not found". They are a generic dark-blue square with a yellow
> "POS" wordmark — **not** the 360booking brand. Replace before any public
> release / store listing / signed installer.

## Files

The three paths referenced by `src-tauri/tauri.conf.json` (`bundle.icon`):

- `32x32.png`     — taskbar / small UI icon
- `128x128.png`   — installer / Start Menu
- `icon.ico`      — Windows multi-resolution icon (used by MSI / NSIS / .exe)

The remaining files (`64x64.png`, `128x128@2x.png`, `Square*Logo.png`,
`StoreLogo.png`, `icon.png`) are produced by the Tauri icon generator and
kept for completeness — Tauri will pick them up if `bundle.icon` is later
broadened, and they make a future swap-to-real-icon a one-step replace.

## Regenerating

```bash
# 1. Drop a 1024×1024 source PNG (RGBA) at src-tauri/icons/source-1024.png
#    (the included source-1024.png.gen.py produces the current placeholder)

# 2. Let Tauri generate the full set
cd /opt/360booking/pos-desktop
npx @tauri-apps/cli icon src-tauri/icons/source-1024.png

# 3. Drop iOS/Android/icon.icns artifacts — POS is Windows-only
rm -rf src-tauri/icons/{android,ios,icon.icns}
```

## Replacement checklist (before public release — Sprint 10/11)

- [ ] Final brand artwork approved (1024×1024, RGBA, transparent background OK).
- [ ] Generated via the steps above so all sizes match the source.
- [ ] Verify the .ico contains 16, 32, 48, 256 px frames (`file icon.ico`).
- [ ] Verify the publisher / signing certificate matches `tauri.conf.json`.
- [ ] Update this README to drop the "TEMPORARY" warning.
- [ ] Delete `source-1024.png.gen.py` once a real source is in place.

## License note

The placeholder uses DejaVu Sans Bold (free / public domain–equivalent license)
to render the "POS" text. No commercial fonts or third-party brand assets are
bundled here.
