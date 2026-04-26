# Production deploy runbook (POS backend)

> **Hard rule:** every deploy starts with `bash /opt/360booking/backup.sh`. Never skip the backup, even for a no-op upgrade.

## Topology

| Component | Where | How |
|---|---|---|
| Server | this host (`/opt/360booking`) | Docker Compose stack |
| Public TLS | host Caddy (PID watching `:443`) | `/etc/caddy/Caddyfile` reverse-proxies `/api/*` to `localhost:8000` (backend container) |
| Backend image | `360booking-backend:latest` | rebuilt by `bash /opt/360booking/build-backend.sh` |
| Postgres | container `360booking-postgres-1` | volume `pgdata` |
| Backups | `/opt/360booking/backups/*.sql.gz` + S3 mirror `s3://360booking-backups/postgres/` | hourly cron + `bash backup.sh` for ad-hoc |

## Standard deploy sequence

```bash
# 1. Backup (always)
bash /opt/360booking/backup.sh
ls -lht /opt/360booking/backups/ | head -3   # verify a fresh dump exists

# 2. Pull the new code
cd /opt/360booking/backend && git pull

# 3. Rebuild the backend image (canonical path)
bash /opt/360booking/build-backend.sh

# 4. Recreate the container
cd /opt/360booking
docker compose up -d backend
docker compose ps backend                    # expect: Up X (healthy)

# 5. Migrations — ALWAYS run, even when expected to be no-op
docker compose exec backend alembic current  # before
docker compose exec backend alembic upgrade head
docker compose exec backend alembic current  # after

# 6. Smoke
curl -sS http://127.0.0.1:8000/api/pos/health
# Verify pos_api_version matches what was just deployed.

curl -sS https://360booking.ro/api/pos/health
# Same check via Caddy.

# 7. Logs scan
docker compose logs backend --tail=200 | grep -iE "error|exception|alembic|critical|fatal" || echo "clean"
```

## Why `docker compose build backend` is a no-op

`docker-compose.yml` declares the service as:

```yaml
backend:
  image: 360booking-backend:latest
  # NO `build:` directive
```

Without a `build:` directive, `docker compose build backend` returns:

```
time=… level=warning msg="No services to build"
```

…and the image stays at whatever was tagged earlier. **`bash /opt/360booking/build-backend.sh` is the canonical rebuild path.** The script wraps the equivalent of:

```bash
cd /opt/360booking/backend
docker build -t 360booking-backend:latest -f Dockerfile .
```

Sprint 9 added the wrapper; do **not** edit `docker-compose.yml` to add a `build:` directive without coordinating, since that changes the deploy semantics for everyone (rebuild on every `up -d`).

## Rollback

```bash
# DB-level rollback to a known migration:
docker compose exec backend alembic downgrade <prev-revision>
# Example: docker compose exec backend alembic downgrade stockcat0426

# Code rollback (drop back to a previous commit):
cd /opt/360booking/backend && git checkout <prev-sha>
bash /opt/360booking/build-backend.sh
docker compose up -d backend

# Worst-case data restore from the most recent backup:
gunzip -c /opt/360booking/backups/booking360_<TIMESTAMP>.sql.gz | \
  docker compose exec -T postgres psql -U booking360 -d booking360
```

## Migration history (POS subsystem)

| Revision | Sprint | Adds |
|---|---|---|
| `possync0427` | 3 | `pos_devices`, `pos_sync_events` (UNIQUE on `mutation_id`), `pos_device_logs` |
| `posown0428` | 7 | `restaurant_orders.owner_device_id`, `owner_expires_at`, `owner_claimed_at` |
| `kdslive0428` | 8 | `restaurant_kitchen_tickets.updated_at` |

## Hardware adapters — confirmed OFF

| Adapter | State |
|---|---|
| Datecs fiscal printer | OFF (sidecar checks presence only; never spawned) |
| BT POS card terminal | OFF (`bt-ecr.ts` is skeleton; throws on call) |
| ESC/POS kitchen printer | OFF (simulator-only) |
| ANAF live submit (`prod`) | OFF (`ANAF_ENVIRONMENT=test` default; cutover requires Ovidiu's confirmation) |
