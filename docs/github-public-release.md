# GitHub Public Release Plan

This is the playbook for opening `pos-desktop` as a public GitHub repository. Sprint 0 sets the constraints; Sprint 10 executes the actual publish.

## Repository shape (Sprint 10)

- New public repo `360booking/pos-desktop` (or as decided by maintainer).
- Source = a subset of `/opt/360booking/pos-desktop` with **only** the open-source-safe files.

## What ships publicly

- All UI code under `pos-desktop/src/`.
- All adapter **interfaces** under `pos-desktop/src/adapters/<kind>/types.ts`.
- All adapter **simulators** (`adapters/<kind>/simulator.ts`).
- SQLite migrations.
- Tauri shell (`src-tauri/`).
- `config.example.json` (no secrets).
- README, LICENSE, CHANGELOG, SECURITY, CONTRIBUTING.
- GitHub Actions workflow that builds the Windows installer in **simulator-only** mode.

## What does NOT ship publicly

- `config.json` actual file. The `.gitignore` keeps it out by name.
- Datecs adapter (Sprint 5) — Datecs FP-55 implementation may be subject to vendor licensing. Default position: keep the adapter in a private sub-package or behind a build-time flag and ship only the simulator publicly. This is decided per-vendor in Sprint 5.
- Real backend URL for 360booking.com.
- Any tenant slugs, JWT secrets, certificates, signing keys.
- BT POS / ECR protocol code if covered by an NDA — same private-package treatment.

## Build matrix

| Build | Target | Adapters baked |
|---|---|---|
| `pnpm build:demo` | open-source MSI | simulators only — no Datecs, no real ECR |
| `pnpm build:tenant` | private MSI | all production adapters |

The flag is the env var `POS_BUILD_PROFILE = demo | tenant`. Vite reads it and tree-shakes the adapter registry.

## Secret hygiene

- Pre-commit hook (`scripts/check-secrets.sh`) runs `gitleaks` on staged changes. Sprint 10 makes it required in CI for the public repo.
- `.gitignore` lists: `config.json`, `*.pem`, `*.pfx`, `.env*` (except `.env.example`), `secrets/`, `private-adapters/`.
- Public CI never has access to signing certificates; signed installer release is done from a separate, manually-triggered private workflow.

## License

Recommended: **MIT** for the desktop client (commodity tool, maximises adoption). The backend (`/opt/360booking/backend`) stays proprietary or moves to a stronger copyleft separately. Discussion belongs in Sprint 10.

## README structure (Sprint 10)

```
1. Screenshot
2. What this is
3. Status (alpha / beta)
4. Quick start (demo mode, 60s)
5. System requirements
6. Architecture overview (link to docs/)
7. Configuring real hardware (link to private fork notes)
8. Building from source
9. Contributing
10. License
```

## CI

GitHub Actions:
- `lint.yml` — eslint + tsc on PRs.
- `test.yml` — vitest on PRs.
- `build-demo-msi.yml` — on tag `v*` builds the demo MSI on `windows-latest`, uploads as a release asset.
- (private) `build-tenant-msi.yml` — manual dispatch, signs with cert from secrets, uploads to internal release channel.

## Compliance reminders

- No customer data (orders, names, phones) ever in fixtures or seeds. Use `Faker.locale("ro_RO")` if needed.
- Demo backend in README points to a public sandbox or to "run your own" — never to production.
- Issue tracker template asks contributors to redact tenant IDs and tokens before pasting logs.
