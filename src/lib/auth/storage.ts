/**
 * On-disk persistence for the POS desktop refresh token (Sprint 10).
 *
 * Backed by the existing `settings` table in pos-desktop.db (one
 * SQLite plugin already in the bundle, no new Tauri plugin or capability
 * needed). Two keys:
 *   - auth.refresh         JSON-encoded { refreshToken, userEmail, savedAt }
 *   - auth.device_id       string device UUID
 *
 * ONLY written when the user ticks "Stay signed in". We don't encrypt
 * yet — closed in Sprint 11 by routing through tauri-plugin-stronghold or
 * the OS credential store. The stored payload includes a `_do_not_share`
 * field so anyone poking at the DB sees the warning.
 *
 * The deviceId is a stable per-installation UUID, generated on first
 * launch, persisted, and never reset unless the user wipes the row.
 */
import { initDb } from '@/lib/db';
import { logger } from '@/lib/logger';

const KEY_AUTH = 'auth.refresh';
const KEY_DEVICE_ID = 'auth.device_id';

export interface PersistedAuth {
  refreshToken: string;
  userEmail: string | null;
  savedAt: number;
}

interface StoredAuth extends PersistedAuth {
  _do_not_share: string;
  _format: 1;
}

async function readKey(key: string): Promise<string | null> {
  try {
    const db = await initDb();
    const rows = await db.select<{ value_json: string }[]>(
      'SELECT value_json FROM settings WHERE key = ?',
      [key],
    );
    return rows[0]?.value_json ?? null;
  } catch (err) {
    // initDb rejects outside the Tauri shell (vite preview, vitest).
    // That's the right behaviour — silently no-op so the app still
    // boots, just without persisted auth.
    logger.warn('auth-store', 'readKey failed', { key, err: String(err) });
    return null;
  }
}

async function writeKey(key: string, value: string): Promise<void> {
  try {
    const db = await initDb();
    await db.execute(
      `INSERT INTO settings (key, value_json) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json,
                                      updated_at = datetime('now')`,
      [key, value],
    );
  } catch (err) {
    logger.warn('auth-store', 'writeKey failed', { key, err: String(err) });
  }
}

async function deleteKey(key: string): Promise<void> {
  try {
    const db = await initDb();
    await db.execute('DELETE FROM settings WHERE key = ?', [key]);
  } catch (err) {
    logger.warn('auth-store', 'deleteKey failed', { key, err: String(err) });
  }
}

export async function readAuthFile(): Promise<PersistedAuth | null> {
  const raw = await readKey(KEY_AUTH);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<StoredAuth>;
    if (!parsed.refreshToken) return null;
    return {
      refreshToken: parsed.refreshToken,
      userEmail: parsed.userEmail ?? null,
      savedAt: parsed.savedAt ?? 0,
    };
  } catch {
    return null;
  }
}

export async function writeAuthFile(payload: PersistedAuth): Promise<void> {
  const wrapper: StoredAuth = {
    ...payload,
    _format: 1,
    _do_not_share:
      'This row contains a refresh token for the 360booking POS device. Treat it like a password. ' +
      'Log out from the app to revoke it server-side.',
  };
  await writeKey(KEY_AUTH, JSON.stringify(wrapper));
}

export async function clearAuthFile(): Promise<void> {
  await deleteKey(KEY_AUTH);
}

let _deviceIdCache: string | null = null;

function newId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `dev-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export async function getDeviceId(): Promise<string> {
  if (_deviceIdCache) return _deviceIdCache;
  const stored = await readKey(KEY_DEVICE_ID);
  if (stored) {
    // settings.value_json is a JSON literal; deviceId is stored as a JSON string.
    try {
      const parsed = JSON.parse(stored);
      if (typeof parsed === 'string' && parsed) {
        _deviceIdCache = parsed;
        return parsed;
      }
    } catch {
      // tolerate raw strings from older versions
      if (stored && !stored.startsWith('{') && !stored.startsWith('[')) {
        _deviceIdCache = stored;
        return stored;
      }
    }
  }
  const id = newId();
  await writeKey(KEY_DEVICE_ID, JSON.stringify(id));
  _deviceIdCache = id;
  return id;
}
