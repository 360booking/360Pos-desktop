<#
.SYNOPSIS
  Curățare completă a 360booking POS desktop pe Windows.

.DESCRIPTION
  Oprește aplicația, dezinstalează MSI-urile cu nume care conțin
  "360booking" sau "POS desktop", șterge folderele de date locale
  (config + SQLite + WAL + log-uri) și curăță registry-ul.

  Util când:
    - reinstalezi de la zero pentru pilot
    - vrei să resetezi aplicația după un crash sau coruption SQLite
    - schimbi de la profil demo la tenant (sau invers)
    - operațiunea de suport cere cache curat înainte de repro

.NOTES
  Bundle identifier folosit de Tauri: com.x360booking.pos
  Path implicit pe Windows: %APPDATA%\com.x360booking.pos\

.EXAMPLE
  # Rulare directă din GitHub (one-liner):
  irm https://raw.githubusercontent.com/360booking/360Pos-desktop/main/scripts/cleanup.ps1 | iex

  # Sau descărcat local:
  .\cleanup.ps1
  .\cleanup.ps1 -Force      # fără prompt de confirmare
  .\cleanup.ps1 -KeepDb     # păstrează SQLite (doar config + auth resetate)
#>

[CmdletBinding()]
param(
    [switch]$Force,
    [switch]$KeepDb
)

$ErrorActionPreference = 'Stop'

function Write-Step {
    param([string]$Message, [string]$Color = 'Cyan')
    Write-Host "[$(Get-Date -Format 'HH:mm:ss')] $Message" -ForegroundColor $Color
}

function Write-Ok    { param($m) Write-Host "  OK  $m" -ForegroundColor Green }
function Write-Warn  { param($m) Write-Host "  !!  $m" -ForegroundColor Yellow }
function Write-Skip  { param($m) Write-Host "  --  $m" -ForegroundColor DarkGray }

$BUNDLE = 'com.x360booking.pos'
$APP_NAME_REGEX = '360booking|360Pos|360 Pos|POS desktop'

Write-Host ""
Write-Host "===============================================" -ForegroundColor Magenta
Write-Host "  360booking POS desktop — cleanup" -ForegroundColor Magenta
Write-Host "===============================================" -ForegroundColor Magenta
Write-Host ""
Write-Host "Bundle identifier: $BUNDLE"
Write-Host "User profile     : $env:USERNAME"
Write-Host "APPDATA          : $env:APPDATA"
Write-Host "LOCALAPPDATA     : $env:LOCALAPPDATA"
Write-Host ""

if (-not $Force) {
    $confirm = Read-Host "Continui cu curățarea completă? Tastează 'da' pentru confirmare"
    if ($confirm -ne 'da') {
        Write-Host "Anulat." -ForegroundColor Yellow
        return
    }
}

# ─── 1. Oprește aplicația ────────────────────────────────────────────────
Write-Step "1/5  Opresc procesele aplicației..."
$procs = Get-Process -ErrorAction SilentlyContinue | Where-Object {
    $_.ProcessName -match $APP_NAME_REGEX
}
if ($procs) {
    foreach ($p in $procs) {
        try {
            Stop-Process -Id $p.Id -Force -ErrorAction Stop
            Write-Ok "Stop $($p.ProcessName) ($($p.Id))"
        } catch {
            Write-Warn "Nu pot opri $($p.ProcessName) ($($p.Id)): $($_.Exception.Message)"
        }
    }
    Start-Sleep -Seconds 2
} else {
    Write-Skip "Niciun proces activ"
}

# ─── 2. Dezinstalează MSI-urile (DOAR dacă rulează ca administrator) ────
Write-Step "2/5  Caut pachete MSI instalate..."
$isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator
)
if (-not $isAdmin) {
    Write-Warn "Nu rulezi ca administrator — sar peste dezinstalare MSI."
    Write-Warn "Dacă vrei și dezinstalare, redeschide PowerShell ca Admin și re-rulează."
} else {
    try {
        $apps = Get-WmiObject -Class Win32_Product -ErrorAction Stop | Where-Object {
            $_.Name -match $APP_NAME_REGEX
        }
        if ($apps) {
            foreach ($a in $apps) {
                Write-Host "    Dezinstalez: $($a.Name) v$($a.Version)" -ForegroundColor Yellow
                $r = $a.Uninstall()
                if ($r.ReturnValue -eq 0) {
                    Write-Ok "Dezinstalat $($a.Name)"
                } else {
                    Write-Warn "Cod de retur $($r.ReturnValue) la dezinstalarea $($a.Name)"
                }
            }
        } else {
            Write-Skip "Niciun MSI instalat"
        }
    } catch {
        Write-Warn "Eroare la enumerare MSI: $($_.Exception.Message)"
    }
}

# ─── 3. Șterge folderele de date ─────────────────────────────────────────
Write-Step "3/5  Șterg folderele de date locale..."
$paths = @(
    "$env:APPDATA\$BUNDLE",
    "$env:LOCALAPPDATA\$BUNDLE",
    # Path vechi (eroare în label din Settings UI înainte de Sprint 11.3) — ștergem și acolo
    "$env:APPDATA\360booking-pos",
    "$env:LOCALAPPDATA\360booking-pos"
)
foreach ($p in $paths) {
    if (Test-Path $p) {
        if ($KeepDb) {
            $cfg = Join-Path $p 'config.json'
            if (Test-Path $cfg) {
                Remove-Item -Force $cfg -ErrorAction SilentlyContinue
                Write-Ok "Șters config.json din $p"
            }
            # NU ștergem pos-desktop.db în mod KeepDb
            Write-Skip "Păstrat SQLite (mod -KeepDb)"
        } else {
            try {
                Remove-Item -Recurse -Force $p -ErrorAction Stop
                Write-Ok "Șters $p"
            } catch {
                Write-Warn "Nu pot șterge $p — fișier blocat? $($_.Exception.Message)"
                Write-Warn "Așteaptă 5s și reîncearcă..."
                Start-Sleep 5
                try {
                    Remove-Item -Recurse -Force $p -ErrorAction Stop
                    Write-Ok "Șters $p (a doua încercare)"
                } catch {
                    Write-Warn "Tot blocat: $($_.Exception.Message)"
                }
            }
        }
    } else {
        Write-Skip "Nu există: $p"
    }
}

# ─── 4. Curăță registry ──────────────────────────────────────────────────
Write-Step "4/5  Curăț registry..."
$regKeys = @(
    "HKCU:\Software\360booking",
    "HKCU:\Software\$BUNDLE",
    "HKCU:\Software\com.360booking.pos"
)
if ($isAdmin) {
    $regKeys += @(
        "HKLM:\Software\360booking",
        "HKLM:\Software\$BUNDLE",
        "HKLM:\Software\com.360booking.pos"
    )
}
foreach ($k in $regKeys) {
    if (Test-Path $k) {
        try {
            Remove-Item -Recurse -Force $k -ErrorAction Stop
            Write-Ok "Șters $k"
        } catch {
            Write-Warn "Nu pot șterge $k`: $($_.Exception.Message)"
        }
    } else {
        Write-Skip "Nu există: $k"
    }
}

# ─── 5. Verificare finală ────────────────────────────────────────────────
Write-Step "5/5  Verificare finală..." 'Cyan'

$failures = 0

# Procese
$leftProcs = Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -match $APP_NAME_REGEX }
if ($leftProcs) {
    Write-Warn "Încă rulează: $($leftProcs.ProcessName -join ', ')"
    $failures += 1
} else {
    Write-Ok "Niciun proces activ"
}

# Foldere
foreach ($p in $paths) {
    if (Test-Path $p) {
        if ($KeepDb -and (Test-Path (Join-Path $p 'pos-desktop.db'))) {
            Write-Skip "Păstrat SQLite în $p (mod -KeepDb)"
        } else {
            Write-Warn "Încă există: $p"
            $failures += 1
        }
    } else {
        Write-Ok "Lipsă: $p"
    }
}

Write-Host ""
if ($failures -eq 0) {
    Write-Host "✓ CURATARE COMPLETA." -ForegroundColor Green
    if (-not $KeepDb) {
        Write-Host "  Poți instala MSI-ul nou; aplicația pornește de la zero." -ForegroundColor Green
    }
} else {
    Write-Host "! CURATARE PARTIALA — $failures elemente nu au fost rezolvate." -ForegroundColor Yellow
    Write-Host "  Verifică mesajele de mai sus. Poate ai nevoie de:" -ForegroundColor Yellow
    Write-Host "    - PowerShell ca Administrator (pentru dezinstalare MSI + HKLM)" -ForegroundColor Yellow
    Write-Host "    - Reboot (dacă fișierele sunt blocate de antivirus)" -ForegroundColor Yellow
}
Write-Host ""
