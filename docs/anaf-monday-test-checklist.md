# ANAF e-Factura — Monday test checklist

**Scope:** ANAF e-Factura integration only. **NO POS / Datecs fiscal printing — those are different stacks.** Datecs talks to a thermal printer for the bon fiscal at point-of-sale. ANAF e-Factura is the digital invoice (XML CIUS-RO) submitted to the government portal AFTER the fiscal receipt is closed. The two never share runtime; they share business logic only at the `RestaurantOrder` level.

> **Hard rule for Monday:** **DO NOT live-submit to `api.anaf.ro/prod` without explicit confirmation from Ovidiu.** The default `ANAF_ENVIRONMENT` should remain `test` until the first end-to-end pilot is reviewed and approved.

## Stack location

| Component | Path |
|---|---|
| OAuth wizard + token mgmt | `backend/src/api/anaf.py` |
| e-Factura inbox + outbound | `backend/src/api/anaf_efactura.py` |
| ANAF service (HTTP + UBL) | `backend/src/services/anaf_efactura_service.py` |
| Outbound UBL builder | `backend/src/services/anaf_ubl_builder.py` |
| Push worker (poll status) | `backend/src/services/anaf_push_worker.py` |
| Cron host scripts | `/opt/360booking/anaf-{pull,push,refresh-tokens}.sh` |
| Test env URL | `https://api.anaf.ro/test/FCTEL/rest` |
| Prod env URL | `https://api.anaf.ro/prod/FCTEL/rest` |
| Switch | `ANAF_ENVIRONMENT` env var (`test` default) — `services/anaf_efactura_service.py:53` |

## 0. Prerequisites

- [ ] Token + refresh_token stored on tenant `tenants.anaf_access_token` / `tenants.anaf_refresh_token` (per-tenant, not global).
- [ ] Digital certificate uploaded to ANAF on the test environment for the pilot CIF.
- [ ] `ANAF_ENVIRONMENT=test` confirmed (not prod): `docker compose exec backend python -c "import os; print(os.getenv('ANAF_ENVIRONMENT', 'test'))"`.
- [ ] Cron jobs visible: `crontab -l | grep anaf` shows refresh-tokens daily 04:45 UTC + pull every 6h + push every 15 min.

## 1. Token health

- [ ] Visit `https://360booking.ro/admin/integrations/anaf` as the tenant admin.
- [ ] Status badge: `Connected — expires <date>`.
- [ ] If `needs_reauth`: complete OAuth wizard before continuing. Do NOT test inbound/outbound while in `needs_reauth`.

## 2. Inbound dry run (test env)

- [ ] Trigger a manual pull: `POST /api/cron/anaf-pull` (curl with CRON_SECRET, or run `bash /opt/360booking/anaf-pull.sh`).
- [ ] Verify: backend logs show `anaf-pull: enqueued tenant <id>` then `anaf-pull: drained 0 message(s)` (or N if there's a test invoice in the SPV mailbox).
- [ ] Open `https://360booking.ro/admin/invoices/incoming`. Verify any pulled invoice has `status='new'` and is parseable.
- [ ] Pick one invoice, walk through line review. **STOP before "Recepționează în stoc"** — that creates `InventoryMovement` rows. We do that only after you confirm the AI mapping is sane.

## 3. Outbound dry run (test env)

- [ ] Pick a non-fiscal restaurant order with `customer_cif` set + at least one line item.
- [ ] On `/admin/invoices`, locate the order and tap `Trimite`.
- [ ] Backend creates `AnafOutboundUpload` row with `status='queued'`.
- [ ] Within 15 min (next push cron tick), worker uploads the UBL and flips status to `pending_validation`.
- [ ] Within 5 polling cycles (`stareMesaj` 60s throttle), status flips to `accepted` or `rejected`.
- [ ] If `rejected`: read `error_message` (CIUS-RO validation often complains about missing TaxSubtotal aggregation or county code mapping). Fix in `anaf_ubl_builder.py`, redeploy backend, retry.

## 4. Logging & forensics

- [ ] `/var/log/360booking-anaf-pull.log` — pull cron output.
- [ ] `/var/log/360booking-anaf-push.log` — push cron output.
- [ ] `/var/log/360booking-anaf-refresh.log` — refresh-token cron output.
- [ ] `anaf_outbound_uploads` table has all submissions with `payload_xml`, `response_json`, `error_code`, `error_message`.
- [ ] `anaf_sync_runs` table has the pull-side runs with the same forensic detail.

## 5. Error handling

| Scenario | Expected |
|---|---|
| Refresh token expired | `tenants.anaf_status='needs_reauth'` set by refresh cron; admin gets a yellow banner on `/admin/integrations/anaf`. |
| Push 4xx (validation) | `AnafOutboundUpload.status='rejected'`, `error_message` populated. UI lets admin retry from `/admin/invoices`. |
| Push 5xx | `AnafOutboundUpload.status='error'`, retried up to 20 times with backoff. After 20: `status='dead'`. |
| Pull 4xx | `AnafSyncRun.status='failed'`, `error_message` populated. Run not retried automatically. |

## 6. Live cutover gate (DO NOT cross until Ovidiu confirms)

When Ovidiu green-lights the cutover:

```bash
# 1. Backup DB
bash /opt/360booking/backup.sh

# 2. Switch env
# Edit /opt/360booking/.env and set:
#   ANAF_ENVIRONMENT=prod

# 3. Restart backend
cd /opt/360booking && docker compose up -d backend

# 4. Verify URL the service uses
docker compose exec backend python -c "
from src.services.anaf_efactura_service import _api_base
print(_api_base('prod'))
"
# Expect: https://api.anaf.ro/prod/FCTEL/rest
```

After cutover, run section 2 + 3 again on the **prod** environment with a real low-stakes invoice (e.g., 1 RON to a friendly business). Validate it appears in the supplier's SPV mailbox before scaling.

## 7. Rollback

If something goes wrong on prod:

```bash
# 1. Revert env to test
# Edit .env: ANAF_ENVIRONMENT=test
docker compose up -d backend

# 2. Mark in-flight uploads as failed manually
docker compose exec postgres psql -U booking360 -d booking360 -c "
  UPDATE anaf_outbound_uploads
     SET status='error', error_message='manual rollback'
   WHERE status IN ('queued','pending_validation') AND created_at > now()-interval '6 hours'
"

# 3. (Optional) Restore DB if data corruption suspected:
gunzip -c /opt/360booking/backups/<latest>.sql.gz | \
  docker compose exec -T postgres psql -U booking360 -d booking360
```

## 8. Out of scope for Monday

- Datecs thermal printer fiscalization (separate stack).
- BT POS card payment integration (separate stack).
- Per-tenant `ANAF_ENVIRONMENT` override (currently global env var; flagged as Sprint 4 follow-up in `project_anaf_efactura_integration.md`).
- Inventory-impacting actions: do **NOT** click "Recepționează în stoc" on any pulled invoice; that creates `InventoryMovement` rows. Smoke ends at the line review.

## 9. Sprint 9.5 readiness polish

### What we explicitly test on Monday (dry-run only)

1. **Token + cert health** (section 1).
2. **Manual pull** triggered (`POST /api/cron/anaf-pull`) — observe behaviour, do **not** receive into stock.
3. **Outbound submit on `api.anaf.ro/test`** ONLY — pick one demo order with `customer_cif` set, click `Trimite`, watch the worker flip statuses through `pending_validation → accepted/rejected`. If `rejected`, capture the `error_message` for fix.
4. **Logs** (section 4) reviewed for the day's operations.

### What we explicitly do NOT test on Monday

- ❌ NO live submit to `api.anaf.ro/prod`. Default `ANAF_ENVIRONMENT=test` stays untouched.
- ❌ NO pulling and receiving stock. Inbound is read-only on Monday.
- ❌ NO bulk operations. One outbound, one inbound, that's the cap.
- ❌ NO Datecs/BT POS/Card payment stuff — different stacks, different sessions.

### Token / certificate prep before the session

- [ ] `tenants.anaf_access_token` populated (visible in `/admin/integrations/anaf` as Connected).
- [ ] `tenants.anaf_refresh_token` populated and `anaf_refresh_expires_at` is in the future.
- [ ] If `needs_reauth`: complete OAuth wizard FIRST. Don't start any test if status is `needs_reauth`.
- [ ] Digital cert uploaded on `https://logincert.anaf.ro/` for the test environment for the pilot CIF. Verify ANAF web UI shows it Active.

### Who confirms live submit

- Live submit to prod requires **explicit text confirmation from Ovidiu** in the session. Without that confirmation, the cutover steps in section 6 are **read-only documentation**, never run.

### Where logs live (for Monday triage)

| Source | Path |
|---|---|
| Pull cron output | `/var/log/360booking-anaf-pull.log` |
| Push cron output | `/var/log/360booking-anaf-push.log` |
| Refresh-token cron | `/var/log/360booking-anaf-refresh.log` |
| Per-tenant audit (DB) | `anaf_outbound_uploads` + `anaf_sync_runs` |
| Backend container | `docker compose logs backend --since 30m \| grep -i anaf` |

### How to disable / pause ANAF without redeploy

```bash
# 1. Stop the cron jobs (host)
crontab -e   # comment out the three anaf-* lines

# 2. Stop in-flight outbound by marking queued items as cancelled
docker compose exec postgres psql -U booking360 -d booking360 -c "
  UPDATE anaf_outbound_uploads
     SET status='cancelled', error_message='manual pause for incident'
   WHERE status IN ('queued','pending_validation')
"

# 3. The desktop POS does NOT call ANAF endpoints, so no client-side
#    flag is needed.
```

### What we do if the token is expired in the middle of testing

1. Backend's refresh-token cron runs daily at 04:45 UTC; if the token is freshly expired, manually invoke:
   ```bash
   bash /opt/360booking/anaf-refresh-tokens.sh
   tail -50 /var/log/360booking-anaf-refresh.log
   ```
2. If refresh also fails: `tenants.anaf_status` flips to `needs_reauth`. Walk through the OAuth wizard at `/admin/integrations/anaf` to re-issue both tokens. Resume tests after that.
3. Never patch tokens directly in the DB during the session — go through the wizard so audit/logging stays consistent.

### Test data we use

- **Tenant:** Ovidiu's pilot CIF on the ANAF test environment.
- **Outbound test invoice:** one previously-issued POS order with a `customer_cif` set on a small amount (<10 RON ideal). Captured ahead of the session, paths recorded below.
- **Inbound test invoice:** if the SPV mailbox has a fixture invoice waiting, use it; otherwise the section is "no message" — that's the expected behaviour, not a failure.
