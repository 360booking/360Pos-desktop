# Fiscal-bridge → Rust/Tauri port — audit + propunere

**Status:** propunere, **fără cod Rust scris încă**. Decizie cerută înainte să trec la implementare.
**Data:** 2026-04-27
**Scop:** binary unic POS desktop care înlocuiește `fiscal-bridge.exe` Python + NSSM, păstrând paritate fiscală cu Datecs DP-25/FP-55 și fără să riscăm fiscalizarea pe tenant-ii live.

---

## 1. Inventar Python (audit fișier-cu-fișier)

Toate căile relative la `fiscal-bridge/bridge/`. Coloană **Port** = ce facem cu fișierul în Rust.

| Fișier | LOC | Ce face | Port |
|---|---|---|---|
| `printers/datecs_fp.py` | 220 | Wire-protocol Datecs FP-55/DP-25 (STX/LEN/SEQ/CMD/DATA/POST/STATUS/BCC/ETX). Encoding nibble+0x20, BCC=sum, CMD=4 nibbles. Fallback FP-700 (0x30 / xor / 1 byte). Read frame cu SYN=busy, NAK=reject. | **OBLIGATORIU** — devine `fiscal::transport::datecs_fp` |
| `printers/datecs_dp25.py` | 227 | Driver DP-25: open_fiscal/register_item/subtotal/payment/close_fiscal, X/Z, status. Mapare TVA→A/B/C/D, mapare metodă plată, truncare descriere 36ch. Comenzi suprareplicabile prin `cmd_codes` din config push de pe server. | **OBLIGATORIU** — devine `fiscal::providers::datecs_dp25` |
| `printers/simulator.py` | 59 | BF-sim-NNNNNN, scrie JSON spool, sleep 250ms. | **OBLIGATORIU** (dev/CI) — `fiscal::providers::simulator` |
| `printers/base.py` | 38 | `FiscalPrinter` ABC + `PrintJob`/`PrintResult` dataclasses. | **OBLIGATORIU** (formă) — devine trait `FiscalPrinterProvider` |
| `printers/registry.py` | 100 | Lookup `model → class`, listă MODELS pentru UI/dropdown. | **OBLIGATORIU** (logică) — `fiscal::providers::build()` factory |
| `probe.py` | 257 | Sweep dialect × baud cu CMD STATUS 0x4A; detecție pattern „NAK pe toate combo-urile = casa neverificată ANAF" (memoria `feedback_fiscal_printer_nak_all_combos`). | **OBLIGATORIU** — `fiscal::diagnostics::probe` |
| `status.py` | 69 | JSON file `status.json` ca IPC între WS-loop și GUI Tk. | **DROP** — în Tauri starea trăiește în Rust și se emite ca event la React |
| `config.py` | 120 | Persistă `BridgeConfig` în `%PROGRAMDATA%\360booking-bridge\config.json`. | **DROP în forma asta** — config trece în store-ul POS desktop (sqlite + tauri.conf) |
| `single_instance.py` | 114 | Named-mutex Win32 ca să nu pornească două bridge-uri (cauza „4000 replaced by new connection"). | **DROP** — `tauri-plugin-single-instance` deja activ în `lib.rs:99` |
| `main.py` | 588 | CLI: --enroll/--install/--run/--gui/--probe-printer/--upgrade/--background. Banner, install scheduled-task / Windows Service via NSSM, fallback non-admin. | **DROP** logica de install/service. **PORT** parțial: enrollment + probe rămân ca tauri commands. |
| `service.py` | 216 | `nssm install/start/stop`, ACL fix pe ProgramData, `relaunch_as_admin` UAC. | **DROP** — Tauri nu rulează ca service; rulează din user session ca app desktop |
| `tray.py` | 208 | `pystray` icon + meniu, balon notificări, „Open settings GUI". | **DROP** — Tauri are tray-ul lui (`tauri-plugin-tray`, dacă-l adăugăm) |
| `gui.py` | 1189 | Tk window cu 4 tab-uri (Dashboard/Setări/Logs/Despre), 3 indicatoare colorate, Test Communication, edit operator/baud. | **DROP** — toată funcția se mută în `features/settings/SettingsScreen.tsx` (deja există schelet) |
| `upgrade.py` | 81 | Download .exe nou de pe GitHub Releases, restart. | **DROP** — Tauri are `tauri-plugin-updater` |
| `deploy.py` | 195 | Copiază .exe în `Program Files`, creează shortcut-uri Start Menu/Desktop. | **DROP** — installer MSI/NSIS al Tauri rezolvă |
| `ws_client.py` | 309 | Conectare WSS la `/api/fiscal-bridge/agent`, hello/heartbeat/job, reconnect cu backoff, exit pe close 4000 (duplicate) sau 401/403 (token revocat), reconfig live la `{"type":"config"}`. | **DECIZIE deschisă** — vezi §6, întrebarea **Q1** |

**Total cod fiscal pur (must-port):** ~870 LOC Python (datecs_fp + datecs_dp25 + simulator + base + registry + probe).
**Total cod scaffold/UI/service (drop):** ~2.500 LOC Python — toate înlocuite de Tauri/React/installer-ul nativ.

---

## 2. Catalog comenzi Datecs DP-25 / FP-55 (paritate cerută)

Sursă: `printers/datecs_dp25.py` + `printers/datecs_fp.py` + override din `backend/src/api/fiscal_bridge.py:_DEFAULT_PROTOCOL_CONFIGS`.

### 2.1 Cadru pe sârmă (FP-55)

```
STX(0x01) | LEN(4 nibbles, +0x20) | SEQ(1 byte 0x20..0x7F) | CMD(4 nibbles, +0x20) | DATA(CP1250, TAB-separat) | POST(0x05) | BCC(4 nibbles SUM, +0x20) | ETX(0x03)
```

Răspuns: același cadru + 6 bytes STATUS între POST și BCC.
Control bytes: ACK 0x06, NAK 0x15 (frame rejected — raise), SYN 0x16 (busy — extinde deadline).

Variantă **FP-700** (suportată ca fallback): nibble offset 0x30, BCC = XOR, CMD = 1 byte raw.

### 2.2 Comenzi implementate

| CMD (hex) | Nume | Format DATA | Folosit în | Răspuns relevant |
|---|---|---|---|---|
| `0x30` | open_fiscal | `<op>\t<pwd>\t<till>` (ASCII) | `_print_receipt` | — |
| `0x31` | register_item | `<name>\tT<group>\t<price>\t<qty>` (CP1250) | `_print_receipt` per linie | — |
| `0x33` | subtotal | `b""` | `_print_receipt` (opțional) | — |
| `0x35` | payment | `<code>\t<amount>` (ASCII; code 0=cash, 2=card, 3=voucher) | `_print_receipt` per plată | — |
| `0x38` | close_fiscal | `b""` | `_print_receipt` final | **DATA = numărul BF** (ASCII) |
| `0x26` | open_nonfiscal | `b""` | `_test_print` | — |
| `0x2A` | print_text | linie CP1250 | `_test_print` per linie | — |
| `0x27` | close_nonfiscal | `b""` | `_test_print` | — |
| `0x45` | x_report / z_report | `b"0"` (X) sau `b"1"` (Z) | rapoarte | — |
| `0x4A` | status | `b""` | `probe.py` + healthcheck | 6-byte STATUS |

### 2.3 Comenzi cerute în plan, **NU implementate** azi

Trebuie clarificat dacă le portăm în Sprint 1 sau le marcăm „later":

- `cancel_receipt()` (storno) — neimplementat în Python; cere Q3.
- `open_drawer()` — neimplementat; nu apare niciun cod în driver. Q4.
- Citirea celor 6 bytes STATUS într-un model semantic (paper out / fiscal memory full / readonly mode etc.) — Python doar le primește în `FrameResponse.status`, nu le interpretează nicăieri. Q5.

### 2.4 Mapare TVA

Driver-ul DP-25 mapează `vat_rate decimal → grup A/B/C/D`:
```
0.19 → A,  0.09 → B,  0.05 → C,  0.00 → D
```
(`datecs_dp25.py:43-48`, override prin `config.vat_map`).

**Atenție:** restul aplicației (vezi `docs/fiscal-flow.md`) folosește decimale, NU enum A-E. Maparea trăiește exclusiv în driver. Asta e deja regula corectă; o păstrăm.

### 2.5 Mapare plată

```
cash, other          → "0"
card, card_pos_manual, stripe, stripe_online → "2"
voucher              → "3"
```
(`datecs_dp25.py:52-60`)

### 2.6 Răspuns bon închis

`reply.data.decode("ascii").strip()` = numărul BF, persistat ca `receipt_number` și `fiscal_number` (același șir azi). Vezi `datecs_dp25.py:206-219`.

### 2.7 Erori mapate

Doar trei clase azi:
- `DatecsFPError("Device NAK")` — frame respins (orice cmd).
- `DatecsFPError("Frame timeout after Ns")` — fără ETX în deadline.
- `DatecsFPError("Short frame: ...")` / `("Malformed reply...")` — parse fail.

**Nu există** mapare la coduri de eroare specifice Datecs (ex. „bon deschis", „memorie fiscală plină", „operator wrong"). Toate ies ca string brut. Q6 — ce vrei să facem?

---

## 3. Wire format job ↔ răspuns (între backend și bridge)

Job (server → bridge), `ws_client.py:181-214`:
```json
{ "type": "job", "kind": "print_receipt|test_print|x_report|z_report",
  "job_id": "<uuid>", "payload": { ... } }
```

Payload `print_receipt` (formă canonică, `bridge_agent.py:_receipt_to_wire`):
```json
{
  "receipt_number": null,
  "currency": "RON",
  "items": [{"name": "...", "quantity": 1, "unit_price": 12.34, "vat_rate": 0.19}],
  "payments": [{"method": "cash|card|voucher|other", "amount": 12.34}],
  "customer_cif": null,
  "customer_name": null,
  "footer_note": null,
  "extra": {}
}
```

Răspuns (bridge → server):
```json
{ "type": "job_result", "job_id": "...", "success": true,
  "data": {"receipt_number": "BF-...", "fiscal_number": "BF-...",
           "printed_at": "...", "printer": "datecs_dp25", "simulated": false},
  "error": null }
```

**Implicație pentru port:** modulul Rust trebuie să accepte exact aceste shape-uri pentru oricare scenariu (vezi §6 Q1). Le îngheț ca DTO Rust.

---

## 4. Ce există deja în `pos-desktop` (nu duplicăm)

Citiri exhaustive — nu re-implementăm.

### 4.1 Tauri/Rust (`src-tauri/src/lib.rs`)
- `tauri-plugin-sql` + 5 migrații SQLite.
- `tauri-plugin-single-instance` activ (înlocuiește `bridge/single_instance.py`).
- `tauri-plugin-shell`, `tauri-plugin-log`.
- Un singur tauri-command fiscal: `fiscal_bridge_status` (verifică doar dacă există un binar sidecar — Sprint 0 stub).
- Feature flag `fiscal-bridge` în `Cargo.toml` (gol azi).

### 4.2 TypeScript adaptere (`src/adapters/`)
- `fiscal/types.ts` — `FiscalDeviceAdapter` cu `status/printReceipt/printZReport/printXReport`. **Aproape identic cu trait-ul cerut de tine** — bună veste, putem păstra contractul TS și-l mapăm 1:1 peste Tauri commands.
- `fiscal/simulator.ts` — simulator JS-side, 90/5/5 success/failed/unknown.
- `payment/types.ts` + `payment/bt-ecr.ts` (azi e stub care aruncă) + `payment/simulator.ts`.
- `printer/types.ts` (KDS/printare bonuri non-fiscale) — separat de fiscal, perfect aliniat cu cerința ta de „nu amesteca".
- `adapters/index.ts` — registry cu `getFiscal()/getPayment()/getPrinter()` selectat din `AppConfig`.

### 4.3 State machine fiscal (`src/core/pos-core/state-machine.ts`)
Tranziții: `paid → fiscal_pending → fiscally_printed → closed`. Cu:
- `OrderFiscalisedError` — items + discount frozen după primul `printed`.
- `FiscalUnknownNoRetryError` — niciun retry automat după unknown; manager trebuie să rezolve manual.

**Toate regulile tale „dacă fiscalizarea eșuează după plată aprobată"** există deja în formă logică. Le confirm + le leg de noul provider Rust fără să le reinventez.

### 4.4 Persistență
SQLite local pos-desktop — există migrații până la `0005_card_recovery.sql` (recovery pentru plăți unknown). Nu am citit toate migrațiile; voi face asta înainte de §11 din planul tău.

---

## 5. Propunere de modul Rust (high-level, fără cod)

Locația: `pos-desktop/src-tauri/src/fiscal/` (modul nou în crate-ul existent, **NU** crate separat — păstrăm un singur binary).

```
src-tauri/src/
├── lib.rs                          # adaugă register fiscal commands
├── fiscal/
│   ├── mod.rs                      # re-exports + commands
│   ├── provider.rs                 # trait FiscalPrinterProvider
│   ├── dto.rs                      # ReceiptRequest, ReceiptResponse, Status, etc.
│   ├── error.rs                    # FiscalError + mapare la coduri
│   ├── transport/
│   │   ├── mod.rs
│   │   └── datecs_fp.rs            # framing FP-55/FP-700 (port 1:1 din datecs_fp.py)
│   ├── providers/
│   │   ├── mod.rs                  # factory build(model, config)
│   │   ├── simulator.rs
│   │   ├── datecs_dp25.rs
│   │   └── datecs_fp.rs            # placeholder pentru DP-150/FP-550 (același transport)
│   ├── mapping/
│   │   ├── vat.rs                  # decimal rate → grup litere (override-able)
│   │   ├── payment.rs
│   │   └── receipt.rs              # FiscalReceiptMapper (DTO → comenzi Datecs)
│   ├── diagnostics/
│   │   ├── probe.rs                # port din probe.py
│   │   └── health.rs               # FiscalPrinterHealthChecker
│   └── commands.rs                 # tauri::command-uri expuse spre React
└── payment/                        # SEPARAT de fiscal — modul propriu
    ├── mod.rs
    ├── provider.rs                 # trait PaymentTerminalProvider
    ├── providers/
    │   ├── stub.rs
    │   └── bt_ecr.rs               # Sprint 9-10
    └── commands.rs
```

### 5.1 Trait

```rust
// pseudo, pentru discuție — NU scris în fișier
pub trait FiscalPrinterProvider: Send + Sync {
    fn test_connection(&self) -> Result<TestResult, FiscalError>;
    fn get_status(&self) -> Result<FiscalStatus, FiscalError>;
    fn print_receipt(&self, req: ReceiptRequest) -> Result<ReceiptResponse, FiscalError>;
    fn cancel_receipt(&self) -> Result<(), FiscalError>;        // dacă suportă
    fn report_x(&self) -> Result<ReportResponse, FiscalError>;
    fn report_z(&self) -> Result<ReportResponse, FiscalError>;  // PROTECTED — vezi §7
    fn open_drawer(&self) -> Result<(), FiscalError>;           // dacă suportă
}
```

DP25 vs FP — diferențele azi sunt doar în `cmd_codes` și encoding-ul cadrului. Le modelăm prin `DatecsConfig { variant: Fp55 | Fp700, codes: CmdCodes, ... }` injectat în provider, **fără branching pe model în logică** (cerința ta `pct.6`). Modul nou per nou model = doar `provider.rs` mic + intrare în factory.

### 5.2 Tauri commands expuse spre React

```
fiscal_test_connection() -> TestResult
fiscal_get_status() -> FiscalStatus
fiscal_print_receipt(request) -> ReceiptResponse
fiscal_print_x_report() -> ReportResponse
fiscal_print_z_report(confirm_token) -> ReportResponse   # token = double-confirm UI
fiscal_probe(port?, baud?) -> ProbeReport                # diagnostic
fiscal_simulator_print(request) -> ReceiptResponse       # dev only
fiscal_raw_command(cmd_hex, data_hex) -> RawResponse     # gated pe DEV build
```

### 5.3 Feature flags / config (cerința ta `pct.5`)

Stocate în SQLite `pos_devices_config` + override din ENV pentru dev:

```
FISCAL_PROVIDER         = simulator | datecs_dp25 | datecs_fp
FISCAL_SERIAL_PORT      = COM3 | /dev/ttyUSB0
FISCAL_BAUD_RATE        = 9600 | 115200 | ...
FISCAL_PROTOCOL_VARIANT = fp55 | fp700
FISCAL_OPERATOR         = "1"
FISCAL_OPERATOR_PASSWORD = "0001"   (păstrat în secure storage Tauri, nu plaintext)
FISCAL_USE_RUST         = true | false   # kill-switch în primele 2 săptămâni de pilot
FISCAL_ENABLE_RAW_LOGS  = true | false
FISCAL_VAT_MAP          = JSON override
FISCAL_CMD_CODES        = JSON override (pentru tweak per casă fără build nou)
```

Default `FISCAL_USE_RUST=false` la deploy. Activăm explicit per stație după validare pe casa reală.

### 5.4 Crate-uri Rust pe care le adăugăm în `Cargo.toml`

- `serialport = "4"` — port serial cross-platform (Windows COM + /dev/tty*).
- `bytes`, `byteorder` — framing.
- `encoding_rs` — CP1250 pentru diacritice românești în `register_item`.
- `tracing` + `tracing-subscriber` — logs structurați (înlocuiește `logging` Python).
- `thiserror` — `FiscalError`.
- (eventual) `tokio-serial` dacă vrem async; pentru simplitate inițială, un thread blocant per provider e mai sigur — Datecs e oricum 1 cmd la rând, fără paralelism.

### 5.5 Persistență fiscalizare (cerința ta „Persistență")

Adăugăm migrare SQLite nouă `0006_fiscal_attempts.sql`:

```sql
CREATE TABLE fiscal_attempts (
  id                TEXT PRIMARY KEY,
  order_local_id    TEXT NOT NULL REFERENCES orders(local_id),
  fiscal_device_id  TEXT NOT NULL,
  provider          TEXT NOT NULL,        -- "simulator" | "datecs_dp25" | ...
  printer_model     TEXT,
  serial_port       TEXT,
  baud              INTEGER,
  status            TEXT NOT NULL,        -- "printed" | "failed" | "unknown"
  receipt_number    TEXT,
  fiscal_date       TEXT,
  raw_request       TEXT,                 -- gated pe FISCAL_ENABLE_RAW_LOGS
  raw_response      TEXT,                 -- idem
  parsed_response   TEXT,
  error_code        TEXT,
  error_message     TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
```

Și separat (deja parțial există în 0005):

```sql
CREATE TABLE payment_attempts (
  id                    TEXT PRIMARY KEY,
  order_local_id        TEXT NOT NULL REFERENCES orders(local_id),
  payment_terminal_id   TEXT NOT NULL,
  provider              TEXT NOT NULL,    -- "bt-ecr" | "smartpay" | "stub"
  amount_cents          INTEGER NOT NULL,
  currency              TEXT NOT NULL,
  status                TEXT NOT NULL,    -- "approved" | "declined" | "cancelled" | "unknown"
  stan                  TEXT,
  rrn                   TEXT,
  authorization_code    TEXT,
  terminal_id           TEXT,
  merchant_id           TEXT,
  response_code         TEXT,
  response_text         TEXT,
  raw_request           TEXT,
  raw_response          TEXT,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL
);
```

Înainte de migrare: `bash /opt/360booking/backup.sh` (memoria `feedback_backup_before_migration`). Asta e POS-desktop SQLite local, **nu** Postgres-ul de prod, dar regula generală rămâne — backup local-store înainte.

---

## 6. Întrebări deschise — am nevoie de decizia ta

### Q1 — Browser POS și fiscalizarea **(legată de clarificarea ta de azi)**

Tu ai zis: *„maparea trebuie sa fie unitate POS de plata, casa de marcat cu un POS fie desktop fie browser"*.

Dacă POS desktop devine *singurul* deținător al casei de marcat (driverul Rust trăiește în Tauri binary), o stație **POS browser** din același restaurant **nu mai poate fiscaliza direct**. Avem trei opțiuni:

- **A. Bridge Python rămâne pentru browser-only.** Desktop POS folosește Rust direct. Browser POS continuă pe ruta WSS prin `fiscal-bridge.exe`. Două căi în paralel la nesfârșit — contrazice „binary unic", dar rezolvă cazul.
- **B. POS desktop expune un mini-server local (HTTP/WSS pe `127.0.0.1`) către browser-ele din rețea.** Browser-ul din restaurant face request la desktop-ul vecin. Decuplezi browser-ul de cloud, dar adaugi tu un service local cu securitate (CORS, token, certificate self-signed pentru WSS).
- **C. Restaurantele cu mai multe stații sunt OBLIGATE să aibă cel puțin un desktop POS.** Browser-ele rulează doar în restaurante 1-stație, unde stația aia e desktop. Cea mai simplă, dar cere o regulă produs.

**Recomandarea mea:** A pe termen scurt (păstrăm Python ca fallback indiferent), C pe termen lung. **Trebuie să confirmi una.**

### Q2 — Mapping `pos_station ↔ fiscal_device ↔ payment_terminal`

Confirmare după clarificarea ta: **strict 1:1:1 per stație** (o stație = o casă + un POS card). Refac modelul de pairing pe asta. **Plan original spunea „eventual mai multe payment_terminal_id"** — îl scoatem? Confirm? Răspuns „da, scoate-l".

### Q3 — `cancel_receipt()` (storno)

Driver-ul Python actual NU implementează storno. Datecs DP-25 are CMD storno (`0x32` în firmware-ul standard, dar variabil). Întrebare:
- (a) Portăm doar paritate (no storno în Sprint 1) și-l facem în Sprint 2.
- (b) Adăugăm acum cu validare pe casa reală cu Ovidiu.

Recomandare: **(a)** — nu adăugăm comenzi pe care nu le-am testat fizic.

### Q4 — `open_drawer()`

Sertarul de bani — fiscal printer vs. printer ESC/POS separat. Pe DP-25 nu există port drawer. Rămâne în trait dar `Err(NotSupported)` pe Datecs? Sau scoatem din trait și-l mutăm pe `ReceiptPrinterAdapter` (deja are stația separată)? Recomandare: **scoatem din trait fiscal**, sertarul aparține printer-ului ESC/POS din `adapters/printer/`.

### Q5 — Interpretare 6-byte STATUS

Datecs returnează 6 bytes care codifică: paper out / cover open / fiscal memory full / no operator / device busy / printer error etc. Python-ul le primește dar nu le interpretează. Vrei să:
- (a) Le persistăm raw + `FiscalStatus { online, paperOk, ready, raw }` cu doar booleeni de bază.
- (b) Scriem un `DatecsStatusDecoder` complet acum cu tabela din manual.
Recomandare: **(a) acum + (b) când ai manual scanat.**

### Q6 — Mapare coduri de eroare Datecs

NAK e un singur bucket azi. Datecs returnează în răspuns coduri text gen `ER:01`/`ER:02`. Vrei un `DatecsErrorMapper` cu lista din manual? Recomandare: **da, dar Sprint 2** — în Sprint 1 păstrăm `error_message: raw` exact ca azi.

### Q7 — Z-report safety gate

Cerința ta: *„Nu trimite comenzi reale de print/raport Z fără confirmare explicită."*
Propunere: `fiscal_print_z_report(confirm_token: String)` unde `confirm_token` = un nonce returnat de un command precedent `fiscal_request_z_confirm()`. UI cere confirmare verbal/click + tastare „Z" în ultimul câmp. Suficient sau vrei challenge mai serios (PIN admin)?

### Q8 — Update mechanism

`tauri-plugin-updater` are propriul cod-semnat update flow. Vrei să-l aducem deja în Sprint 1 (înlocuiește `upgrade.py` direct), sau lăsăm pe MSI manual până e Sprint 10 stabil?

### Q9 — Server-pushed `cmd_codes`

Backend-ul (`api/fiscal_bridge.py:_DEFAULT_PROTOCOL_CONFIGS`) trimite codurile peste WSS la fiecare reconnect. În arhitectura nouă, dacă desktop POS NU mai folosește WSS-bridge-ul, **pierdem capabilitatea de a tweak coduri fără build nou**. Variante:
- (a) Adăugăm un endpoint REST nou `GET /api/pos-desktop/fiscal-config` — desktop-ul îl pollează și face cache local.
- (b) Trimitem codurile prin canalul existent de sync POS desktop ↔ backend.
- (c) Nu mai pushăm de pe server; codurile devin doar config local editabil din `SettingsScreen`.
Recomandare: **(b)** — păstrăm capability fără canal nou.

---

## 7. Reguli de siguranță — confirmare implementare

Toate sunt deja în lista ta; le notez ca să le bifăm la PR-uri:

- [ ] `fiscal_print_z_report` cere `confirm_token` (vezi Q7).
- [ ] `fiscal_raw_command` exists doar cu `#[cfg(feature = "fiscal-dev")]` — disabled în release.
- [ ] `FISCAL_ENABLE_RAW_LOGS=false` default — gate pentru `raw_request/raw_response` în SQLite.
- [ ] State machine refuză `print_receipt` dacă există `fiscal_attempts.status='printed'` pentru order (deja în pos-core).
- [ ] State machine refuză `print_receipt` dacă există `fiscal_attempts.status='unknown'` pentru order (deja în pos-core, vezi `FiscalUnknownNoRetryError`).
- [ ] Persistență fiscal `fiscal_attempts` și payment `payment_attempts` separate, niciodată într-un singur tabel.
- [ ] Plată approved + fiscalizare failed → `order.state='payment_approved_fiscalization_failed'` (nou — adăugat lângă `fiscal_pending`); UI arată buton „Retry fiscalization", NU re-charge.
- [ ] Payment unknown → fiscalizarea **nu pornește** până nu se face statusForRrn (deja regula în `bt-ecr.ts`).

---

## 8. Plan de execuție propus (mapare 1:1 cu lista ta de 15 puncte)

| Pas | Status după acest doc | Sprint țintă |
|---|---|---|
| 1. Audit | **DONE** — acest doc | — |
| 2. Documentare comenzi | **DONE** — §2 | — |
| 3. Propunere modul Rust | **DONE** — §5 | — |
| 4. Simulator Rust | TODO după Q1-Q9 confirmate | S11.0 |
| 5. Datecs command builder/parser | TODO | S11.0 |
| 6. Serial transport Rust | TODO | S11.0 |
| 7. DP-25 provider | TODO | S11.1 |
| 8. FP provider (DP-150/FP-550) | TODO — provider-ul e literalmente DP-25 cu `cmd_codes` overlay | S11.1 |
| 9. Tauri commands | TODO | S11.1 |
| 10. Refactor POS desktop să folosească noul provider | TODO — wrap peste `FiscalDeviceAdapter` TS existent | S11.2 |
| 11. Fallback Python păstrat | DA — cât e `FISCAL_USE_RUST=false` pentru tenant | S11.2-S11.4 |
| 12. Teste | TODO — fixture-uri din wire-traces existente în `tests/` Python | S11.0+ |
| 13. Diagnostic CLI commands | TODO — `fiscal_probe` + `fiscal_simulator_print` ca tauri commands | S11.1 |
| 14. README | TODO — actualizat pe `pos-desktop/README.md` și `fiscal-bridge/README.md` (deprecation notice) | S11.4 |
| 15. Marcare ce nu s-a putut testa fără printer | TODO — listă explicită în PR-uri și `pos-desktop/docs/fiscal-port-status.md` | continuu |

**Estimare brut:** ~3-4 zile dev pentru pașii 4-9 (Rust); +2 zile pentru §10 + UI; +1 zi pentru §12 testing fixture-uri. Plus 1-2 sesiuni pe casa reală cu Ovidiu pentru validare pre-cutover. **Total ~8-10 zile dev, plus calendar ANAF/casa.**

---

## 9. Riscuri pe care le văd

1. **Fără casa reală în lab.** Tot codul fiscal Rust va fi testat pe simulator + capturi de wire-traces. Validarea reală depinde de Ovidiu + casa fiscalizată. Memoria `feedback_fiscal_printer_nak_all_combos` arată că am avut deja o lecție grea — protocolul putea fi corect, casa neautorizată respingea totul. Risc reproductibil.
2. **`serialport` crate pe Windows.** A funcționat în CI Python pentru Ovidiu, dar `serialport-rs` are bug-uri cunoscute pe drivere FTDI/CH340. Plan de mitigare: testăm `serialport` + `serial2-tokio` în primul sprint, ne-decidem.
3. **CP1250 encoding.** Diacriticele românești în descrieri produs trebuie să iasă identic cu Python. `encoding_rs` are CP1250 — verificabil cu fixture.
4. **Pierdem WSS-driven hot-reload de coduri.** Vezi Q9.
5. **Gap funcțional dacă scoatem prematur Python.** Regula `pct.4` din planul tău — Python rămâne. Eu propun deprecation flag explicit `FISCAL_BRIDGE_DEPRECATED_AFTER=2026-XX-XX` pe care-l setăm doar după 2 săptămâni de zero incidente pe pilot.

---

## 10. Ce NU am făcut în acest audit (de bună-credință)

- Nu am citit `printers/__init__.py` (12 LOC, doar exports).
- Nu am citit testele din `fiscal-bridge/tests/` — le folosesc ca fixture când scriu §12, nu acum.
- Nu am citit toate cele 5 migrații SQLite POS desktop — voi citi `0005_card_recovery.sql` înainte să propun `0006_fiscal_attempts.sql` ca să nu intru în coliziune.
- Nu am verificat exact cum arată `FiscalReceiptPayload` dataclass în `backend/src/services/fiscal/base.py` (am inferat shape din `bridge_agent.py:_receipt_to_wire`).
- Nu am pornit Rust toolchain ca să verific că `serialport` compilează în setup-ul tău Tauri 2.x — fac asta înainte de PR-ul §4-9.

---

## 11. Decizii confirmate (2026-04-27)

- **Q1 = C.** Regulă produs: minim un POS desktop/Tauri activ per locație fiscală. Browserul trimite vânzarea la backend, backend-ul o routează la desktop-ul fiscal activ. Python fiscal-bridge rămâne fallback pentru locațiile fără desktop Tauri. **NU** desktop-local-server pentru browser în Sprint 1.
- **Q2 = 1:1:1** strict în UI/flow Sprint 1. Modelul de date lasă loc pentru extensie (FK nullable / index pe `payment_terminal_id`), dar fără routing multi-terminal acum.
- **Q3 = Sprint 2.** Storno NU în Sprint 1.
- **Q4 = Sprint 2.** Cash drawer NU în Sprint 1; doar notat în audit dacă apare în Python.
- **Q5 = minim.** Sprint 1 expune doar: online/offline, paper missing/low (dacă identificabil sigur), fiscal_error, general_error, busy, unknown. Raw 6-byte STATUS salvat la log pentru debug. Decoder semantic complet = Sprint 2.
- **Q6 = mapare minimă curată.** Variante eroare Sprint 1: `CommunicationError`, `PrinterBusy`, `PaperError`, `FiscalMemoryError`, `InvalidCommand`, `NotFiscalized` / `ConfigurationError`, `UnknownFiscalError`. **Unknown NU se tratează ca success.**
- **Q7 = strict.** Z-report nu se expune în UI normală. Dacă-l implementăm, cere confirmare explicită + PIN admin. Raw command + Z-report disabled by default în prod. Diagnostic CLI pentru Z = doar `--confirm-z-report` + PIN. Pentru MVP, Z-report poate rămâne manual pe casă dacă nu e necesar pentru flow-ul principal.
- **Q8 = MSI manual.** NU `tauri-plugin-updater` în Sprint 1.
- **Q9 = config local + sync la startup.** Fără hot-reload real-time. Backend-ul oferă endpoint REST cu `cmd_codes` curent; desktop-ul le pulează la pornire + buton manual refresh în diagnostic. NU păstrăm WSS-bridge doar pentru hot-reload.

**Sprint 1 scope:** simulator + transport Datecs + DP-25 + status minim + print receipt + retry fiscalization + diagnostic probe. Tot în spatele `FISCAL_USE_RUST=false` default. Python rămâne în repo + prod ca fallback până 2 săptămâni de zero incidente pe pilot.

**Sprint 2 scope:** storno, cash drawer, decoder STATUS complet, mapare erori Datecs full, updater, eventual hot-reload.

## 12. Următorul pas

1. Deschid PR cu schelet `pos-desktop/src-tauri/src/fiscal/{mod,provider,dto,error,simulator}.rs` (modul în crate-ul existent, fără cod fiscal real încă).
2. Creez `pos-desktop/docs/fiscal-port-status.md` ca live tracker.
3. PR-uri incrementale per provider/transport, toate gated pe `FISCAL_USE_RUST`.
4. Nu rescriu state machine TS — îl las să cheme noile Tauri commands.
5. Payment module separat de fiscal — fără partajare de cod între ele.
