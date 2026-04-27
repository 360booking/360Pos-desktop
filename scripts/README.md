# Scripts

## `cleanup.ps1`

Curățare completă a 360booking POS desktop pe Windows.

### Rulare directă din GitHub (one-liner)

PowerShell normal (curăță doar datele, fără dezinstalare MSI):
```powershell
irm https://raw.githubusercontent.com/360booking/360Pos-desktop/main/scripts/cleanup.ps1 | iex
```

PowerShell ca **Administrator** (curăță TOT, inclusiv pachete MSI + HKLM):
```powershell
Start-Process powershell -Verb RunAs -ArgumentList "-NoExit -Command irm https://raw.githubusercontent.com/360booking/360Pos-desktop/main/scripts/cleanup.ps1 | iex"
```

### Rulare local

Descarcă scriptul și rulează:
```powershell
# Curățare cu prompt de confirmare
.\cleanup.ps1

# Fără confirmare (pentru automatizare / suport)
.\cleanup.ps1 -Force

# Păstrează baza SQLite, șterge doar config + auth (util pentru reset login)
.\cleanup.ps1 -KeepDb
```

### Ce face

1. Oprește toate procesele cu nume care conțin `360booking` / `pos-desktop`
2. Dezinstalează MSI-urile cu același pattern (DOAR ca Admin)
3. Șterge folderele de date:
   - `%APPDATA%\com.x360booking.pos\` (calea curentă, Tauri bundle identifier)
   - `%LOCALAPPDATA%\com.x360booking.pos\`
   - `%APPDATA%\360booking-pos\` (calea veche, dacă a rămas din versiuni anterioare)
   - `%LOCALAPPDATA%\360booking-pos\`
4. Curăță registry (HKCU\Software\360booking + variantele bundle)
5. Verifică că totul a fost șters

### Cazuri în care îl rulezi

- Înainte de o instalare curată (Sprint 11 pilot)
- După un crash sau coruption SQLite
- Când schimbi de la profil demo la tenant (sau invers)
- La cererea echipei de suport pentru a reproduce un bug pe stare curată
