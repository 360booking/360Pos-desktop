# Fiscal port — Sprint status tracker

Live tracker for the Python → Rust/Tauri fiscal-bridge port. Decisions live in `fiscal-port-audit.md`. Update this file as PRs land.

## Sprint 1 — paritate minimă (in progress)

| Item | Status | Notes |
|---|---|---|
| Audit Python | done | `fiscal-port-audit.md` |
| Decizii Q1-Q9 | done | §11 din audit |
| Schelet `src-tauri/src/fiscal/` | done | trait + DTO + error + simulator + commands wired into `lib.rs` |
| `FISCAL_PROVIDER` / `FISCAL_USE_RUST` env switches | done | read in `commands.rs`; TS `RustFiscalAdapter` promoted via `enableRustFiscalIfAllowed()` |
| TS `FiscalDeviceAdapter` → Tauri commands | done | `src/adapters/fiscal/rust.ts`; `useDeviceStatusBootstrap` upgrades on mount |
| Datecs FP-55/FP-700 transport | done | `transport/datecs_fp.rs` cu unit tests pe encoding + BCC sum/xor |
| Datecs DP-25 provider | done | `providers/datecs_dp25.rs` cu unit tests pentru open_fiscal/register_item/payment formats |
| Diagnostic `fiscal_probe` | done | port complet `probe.py` — sweep dialect × baud + detecție all-NAK |
| Status decoder — minim | done | `mapping/status.rs` (Sprint 2 = decoder semantic complet) |
| Error mapper Sprint 1 set | done | 8 variants în `error.rs` |
| WSS bridge_client (port `ws_client.py`) | done | `bridge_client/{ws,claim,state}.rs`; reconnect, exit on close 4000, hello/heartbeat/job/job_result |
| UI Settings → Casă de marcat | done | `FiscalDiagnosticPanel` + `FiscalBridgePanel` în tab-ul `fiscal` |
| SQLite migration `0006_fiscal_attempts.sql` | done | include `fiscal_attempts` + `payment_attempts` + `station_pairings`; wired în `lib.rs` migration v6; ResetSection updated |
| **B9** auto-persist `fiscal_attempts` din `fiscal_print_receipt` | done | `fiscal/persist.rs` (rusqlite + bundled); UPSERT pe `mutation_id`; raw payload gated pe `FISCAL_ENABLE_RAW_LOGS` |
| **B9** Tauri `fiscal_record_payment_attempt` | done | TS-driven; aceeași semantică UPSERT; așteaptă BT-ECR provider Sprint 2 |
| **B9** Tauri `fiscal_list_attempts` / `fiscal_list_payment_attempts` | done | folosit de B10 + viitoare flow-uri retry |
| **B10** hidratare `Order.fiscalAttempts` la `loadOrderFromRemote` | done | `loadFiscalAttempts(exec, orderLocalId)` în `src/lib/sync/resumeOrder.ts`; mapează `provider` → `adapterId`, `created_at` → `startedAt` |
| **C12** backend `GET /api/fiscal-bridge/config` + Rust pull | done | token-auth (acelaşi model ca `/agent` WS), returnează `{bridge_id, tenant_id, printer_model, protocol}` rezolvat. Rust `fiscal/config.rs` cu in-memory + disk cache (`fiscal-config.json`). Tauri commands: `fiscal_pull_config`, `fiscal_get_cached_config`. UI: `FiscalBridgePanel` pull post-claim + buton „Pull again". |
| **C13** agent_type discriminator pe `fiscal_bridges` + claim/hello | done | Alembic `fbagent0427`, model + `_Connection` + `BridgeStatus` + `ClaimRequest`; Rust claim trimite `agent_type="pos_desktop_tauri"`, hello la fel pe reconnect; admin UI afișează badge agent. Routing job-uri = neschimbat (un singur agent per tenant via WSS). |
| **B11** `station_pairings` persist + UI pairing | done | Rust `read_station_pairing/upsert_station_pairing/clear_station_pairing` + UPSERT cu COALESCE pe partial pair. Auto-pair la `fiscal_bridge_claim` (stamp bridge_id ca fiscal_device_id, provider). 3 commands Tauri + facadă TS `adapters/fiscal/pairing.ts` + secțiune UI „Pairing stație" în `FiscalBridgePanel`. |
| Test pe casă reală | blocked | așteaptă acces fizic |

## Sprint 3 — hardware config UI (in progress)

Scopul: scoatem dependența de FISCAL_* env vars pentru cutover pe casă fizică.
Operatorul configurează totul din Settings → Casă de marcat → „Configurare hardware".

| Item | Status | Notes |
|---|---|---|
| Migrare `0007_fiscal_runtime_config.sql` | done | single-row table cu provider/port/baud/operator/use_rust + raw_logs |
| Rust `fiscal/runtime_config.rs` | done | `read/write` rusqlite + `effective_*` helperi (DB > env > default); 6 unit tests |
| Refactor `commands.rs` + `providers/mod.rs` | done | `provider_name()`/`use_rust_enabled()`/`raw_logging_enabled()` eliminate; commands cheamă `runtime_config::effective_*`; `providers::build` primește `&RuntimeConfig` în loc să citească env |
| Tauri commands `fiscal_get_runtime_config` / `fiscal_set_runtime_config` | done | round-trip cu `RuntimeConfig` JSON; auto-promovează RustFiscalAdapter post-save |
| TS facadă `adapters/fiscal/runtime-config.ts` | done | wrap minim peste invoke; 3 vitest |
| UI `FiscalHardwareConfigPanel` | done | dropdown provider + port (refresh + manual override) + baud + variantă FP55/FP700 + operator + masked password + use_rust + raw_logs; buton „Salvează" + „Salvează + Test now" care înlănțuie `fiscal_test_connection` + `fiscal_get_status` |
| Wired în `SettingsScreen` deasupra diagnosticului | done | tab `fiscal` afișează: hardware config → diagnostic → bridge claim |
| Test pe casă reală | blocked | așteaptă acces fizic pe PC-ul lui Ovidiu |

### Cum testez (după Sprint 3)

1. CI workflow `pos-desktop-windows-tenant` produce MSI cu codul curent. Tester instalează.
2. Login → Settings → tab „Casă de marcat" → secțiunea „Configurare hardware":
   - Provider: „Datecs DP-25 (FP-55)"
   - Port serial: „Refresh" → alege COM-ul fizic; sau scrie manual ex. „COM3"
   - Baud: 9600 (default Datecs)
   - Variantă protocol: „FP-55 (default DP-25)"
   - Operator: „1", parolă: „0000" (sau ce e pe casă)
   - Bifă „Activează adapterul Rust" — obligatoriu pentru hardware real
   - Click „Salvează + Test now" → vezi `online: true` + status decoded.
3. Dacă „Test now" pică cu NAK pe toate — vezi memoria
   `feedback_fiscal_printer_nak_all_combos` (casa neautorizată ANAF). Nu mai
   debug protocol până nu confirmă tehnicianul.
4. Dacă „Test now" trece → secțiunea „Diagnostic" → buton „Print test receipt"
   pentru bon real (1 RON, TVA 19%, cash). Verifică pe hârtie BF emis.
5. Pentru WSS end-to-end (browser POS fiscalizează prin Tauri): secțiunea
   „Bridge backend" — paste enrollment code din admin → „Claim + start WSS".

## Sprint 2 — extensii

| Item | Status | Notes |
|---|---|---|
| **Storno (Q3)** | done (cod) | `cancel_receipt` în trait + simulator + DP-25 (cmd 0x32, ISO→DD-MM-YY date) + Tauri `fiscal_cancel_receipt` cu auto-persist + TS adapter `cancelReceipt`. **Wire format așteaptă validare hardware** (FP-55 §3.5 are variante de firmware). |
| Cash drawer (Q4) | scoped out | Nu există port drawer pe DP-25; aparține `ReceiptPrinterAdapter` (ESC/POS), NU trait fiscal. Fără cod în Sprint 2. |
| **Decoder STATUS complet (Q5)** | done | `mapping/status.rs::decode_full` + `FullStatus { flags: Vec<StatusFlag> }` + `Severity`. Bit-table per FP-55 §4.2 cu mesaje RO. 5 unit tests. Real-byte-table încă neverificată pe DP-25 fizic. |
| **Mapare erori Datecs full (Q6)** | done | `mapping/datecs_errors.rs` cu 25+ ER:NN coduri → `FiscalError` variant + RO message. Cuplat în DP-25 `print_receipt` + `cancel_receipt` la close_fiscal. 5 unit tests. |
| **`tauri-plugin-updater` (Q8)** | scaffold | Plugin în Cargo.toml + `tauri.conf.json` cu endpoint `/api/pos-desktop-updates/...` + pubkey placeholder. Backend stub în `pos_desktop_updates.py` (204 = no update). **Real release pipeline = deploy concern** (signing key + manifest generator). |
| Hot-reload `cmd_codes` (Q9) | scoped out | Per Q9 final = pull la startup (deja livrat în C12), fără hot-reload WSS. |
| **Z-report cu safety gate (Q7)** | done | `fiscal_request_z_confirm` issue 30s nonce + `fiscal_print_z_report(token)` single-use; provider trait `print_z_report` cu DP-25 (`Z\t1` payload pe cmd 0x45) + simulator. TS `printZReport` lănțuie nonce → print. UI prompt admin = follow-up. |

## C13 — model agent + routing fiscal end-to-end (Sprint 1)

### Decizia

- **Refolosim** `fiscal_bridges` + WSS `/api/fiscal-bridge/agent` în loc să creăm `pos_desktop_stations` + `/api/pos-desktop/agent`. Sprint 1 nu duplică infrastructură.
- Adăugăm un singur câmp discriminator pe schemă: `fiscal_bridges.agent_type`.
- Valori valide acum: `python_fiscal_bridge` (default, pentru rândurile existente) | `pos_desktop_tauri` (Rust port).
- Restul stack-ului (enrollment cod 10 min → claim → device_token → WSS hello/heartbeat/job/job_result, manager.send_job_sync) rămâne neschimbat.

### Cum se marchează un bridge ca `pos_desktop_tauri`

1. La claim — pos-desktop Rust (`fiscal/bridge_client/claim.rs`) trimite `agent_type: "pos_desktop_tauri"` în payload-ul POST. Backend-ul stampilează `target.agent_type = body.agent_type` la commit-ul claim-ului (`backend/src/api/fiscal_bridge.py::claim`).
2. La fiecare reconnect (hello) — Rust (`fiscal/bridge_client/ws.rs`) include același flag în mesajul WSS hello. Backend-ul îl persistă atunci când vine în `msg["agent_type"]` (path-ul „rândul există dar runtime-ul s-a schimbat" — ex: tenant a dezinstalat Python service și a reutilizat același cod pe pos-desktop).
3. Fallback — dacă hello nu trimite `agent_type`, backend păstrează valoarea persistată în coloană (sau `python_fiscal_bridge` dacă coloana e NULL).

Rezultatul: `GET /api/fiscal-bridge/status` returnează `agent_type` în payload, iar admin UI (`frontend/src/components/admin/restaurant/FiscalBridgePanel.tsx`) afișează badge: `POS desktop (Tauri)` sau `fiscal-bridge (Python)`.

### Routing browser POS → backend → desktop activ

```
[Browser POS / Admin UI]
        │  HTTP cerere fiscalizare (POST /api/restaurant/orders/{id}/fiscalize sau test-print)
        ▼
[Backend FastAPI]
        │  resolve tenant_id din auth
        │  mgr.send_job_sync(tenant_id, kind="print_receipt", payload=…)
        ▼
[fiscal_bridge_manager._registry[tenant_id]]   ← un singur _Connection per tenant
        │  message {"type":"job", "job_id", "kind", "payload"}
        ▼
[WSS /api/fiscal-bridge/agent]   ← același endpoint, indiferent de agent_type
        │
        ├── (a) python fiscal-bridge.exe → driver Datecs Python
        │
        └── (b) pos-desktop Tauri (Rust)
                  │  bridge_client/ws.rs::cmd_handler
                  ▼
              fiscal::providers::build("datecs_dp25" | "simulator")
                  │  print_receipt(req) → ReceiptResponse
                  ▼
              persist::record_fiscal_attempt(...)   ← B9 (numai pe path-ul TS-driven, nu WSS)
                  │
                  ▼
              "type":"job_result" → backend → resolve future → răspuns HTTP la browser
```

Browser-ul **nu** vorbește direct cu casa de marcat. Fiscalizarea trece mereu prin backend → WSS → agent activ. Identitatea stației = `device_token` (per stație, asignat la claim).

### Limitări Sprint 1

- **Un singur agent activ per tenant.** Două stații pos-desktop pe același tenant ar bate-o pe alta (registry-ul keys by tenant_id, nu by station). Pentru multi-stație: vezi „Migrare viitoare".
- **Fără autoritate de routing pe printer_model.** Dacă tenant-ul are *atât* Python bridge cât și pos-desktop conectate concomitent, ultimul care face `register` câștigă (vezi flap-detection log în `fiscal_bridge_manager.register`). În practică tenant-ul migrează discret de la unul la celălalt.
- **Audit Q2 = 1:1:1 (station ↔ fiscal_device ↔ payment_terminal)** rămâne enforced doar UI-side (Sprint 1). Schema permite multi prin nullable FK în `station_pairings` (`pos-desktop/src/sql/migrations/0006_fiscal_attempts.sql`).
- **Persistența `fiscal_attempts` se face NUMAI pe path-ul TS-driven** (`fiscal_print_receipt` Tauri command). Job-urile WSS-driven (test-print din admin) NU scriu în SQLite — backend-ul deja log-uiește server-side. Vezi comentariul din `commands.rs`.

### Migrare viitoare (out of scope Sprint 1)

Două căi simetrice; ambele se rezolvă cu `agent_type` ca pivot, fără rewrite mare:

1. **Rename + abstractizare** — `fiscal_bridges` devine `local_agents`. View-uri compatibile pe nume vechi pentru migrare graceful. WSS rămâne identic (același device_token, doar URL-ul se redenumește).
2. **Split discret** — adăugăm tabela `pos_desktop_stations` și endpoint-ul `/api/pos-desktop/agent` separat. Migrarea = `INSERT … FROM fiscal_bridges WHERE agent_type='pos_desktop_tauri'`, mutăm doar Tauri agents acolo, păstrăm `fiscal_bridges` pentru Python. Routing-ul devine: backend caută întâi în `pos_desktop_stations`, fallback la `fiscal_bridges`.

Tipic recomandăm (1) — simplitate, fără cod duplicat. Decizia se ia când avem *date reale* despre cum diverg cele două runtime-uri (azi diferă doar prin runtime, nu prin protocol).

## Cum testez end-to-end (fără casă reală)

1. Build pos-desktop pe Windows (toolchain Rust nu există pe serverul ăsta — `cargo` nu rulează aici).
2. Pornește cu env vars:
   ```
   FISCAL_USE_RUST=true
   FISCAL_PROVIDER=simulator
   ```
   Pentru Datecs fizic, în plus:
   ```
   FISCAL_PROVIDER=datecs_dp25
   FISCAL_SERIAL_PORT=COM3
   FISCAL_BAUD_RATE=9600
   FISCAL_OPERATOR=1
   FISCAL_OPERATOR_PASSWORD=0001
   FISCAL_PROTOCOL_VARIANT=fp55          # sau fp700 dacă probe-ul recomandă
   ```
3. Deschide aplicația → Settings → tab „Casă de marcat".
4. Secțiunea **Diagnostic Sprint 1**:
   - „Verifică gate" — confirmă că adapterul activ e `fiscal-rust`.
   - „Test connection" — apelează `fiscal_test_connection`.
   - „Get status" — apelează `fiscal_get_status`.
   - „Print test receipt" — comandă sintetică (1 RON, TVA 19%, cash). Răspunsul trebuie să aibă `status: 'printed'` (simulator) sau echivalent pentru DP-25.
5. Secțiunea **Bridge backend**:
   - Lipește un cod de enrollment ABCD-1234 emis din admin → Restaurant → Casă de marcat → Activează.
   - Click „Claim + start WSS" → token primit + loop pornit. Status devine CONECTAT.
   - Trimite un job din admin („Test print") → vine prin WSS, se rezolvă local prin Rust provider, răspunsul ajunge înapoi.

## Cum comut între Python bridge și Rust simulator

- `FISCAL_USE_RUST=false` (sau ne-set) → fallback simulator JS, pos-desktop nu cheamă Rust deloc.
- Python `fiscal-bridge.exe` rămâne instalat ca serviciu separat în paralel — backend-ul îl preferă pe acela pentru tenant-ii care au stația încă pe Python.
- Cutover-ul se face per-stație prin setarea env var-ului + restart pos-desktop. Backend nu trebuie modificat.

## Ce rămâne pentru Datecs real

Tot codul e scris cu paritate față de Python pe baza fixture-urilor existente. Pe casa fizică trebuie:
1. Confirmat că probe-ul găsește combinația corectă (dialect × baud) și o salvăm în config local.
2. Verificat CP1250 pe diacritice românești (ășțîâ în descrieri produs).
3. Confirmat că răspunsul `close_fiscal` întoarce numărul BF în formatul așteptat.
4. Validat că state-ul Datecs (6 bytes STATUS) nu sunt non-zero în mod normal — altfel actualizăm `mapping/status.rs`.
5. Capturat câteva wire-traces reale (cu `RUST_LOG=debug`) ca să le adăugăm ca fixture-uri în `transport/datecs_fp.rs#tests`.

## Ce NU s-a putut testa fără casa reală

- Frame-uri pe wire — fixture-urile pleacă din Python tests, dar canon e wire-ul de la DP-25 fizică.
- Comportament real al `0x4A` STATUS și interpretarea celor 6 bytes.
- Pattern-ul „NAK pe toate combo-urile = casă neverificată ANAF" (vezi memoria `feedback_fiscal_printer_nak_all_combos`).
- CP1250 round-trip pentru diacritice.
- Reaction la close 4000 / 4001 reale de la backend (unit-tested logic-only).

## Compile status

- TS — verde (`tsc --noEmit` curat).
- Rust — necompilat aici (nu există toolchain pe serverul ăsta). Build-ul real se face pe Windows-ul lui Ovidiu sau în CI.
