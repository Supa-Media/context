/**
 * Two JSON files in `app.getPath("userData")`, written atomically.
 *
 * The settings and the outbox. Neither holds a credential — that is the
 * keychain's job (`core/sync/tokenStore.ts`) — but the outbox holds transcript
 * text that has not reached the bucket yet, which is somebody's meeting, so:
 *
 * **Writes are atomic.** Write a temporary file, then rename. A power cut
 * halfway through a write of a two-hour transcript must not leave a truncated
 * JSON file where the queue used to be; rename is the only operation a
 * filesystem promises not to tear.
 *
 * **A read never throws.** `normalizeSettings` and `normalizeOutbox` repair
 * whatever comes back, including nothing at all. See their own headers for what
 * "repair" is allowed to mean — for settings it is deliberately not "keep going
 * with what parsed".
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { normalizeSettings } from "../core/settings.ts";
import type { DesktopSettings } from "../core/settings.ts";
import { normalizeOutbox } from "../core/sync/outbox.ts";
import type { Outbox } from "../core/sync/outbox.ts";
import { EMPTY_CURSOR, normalizeCursor } from "../core/imessage/cursor.ts";
import type { ImessageCursor } from "../core/imessage/cursor.ts";
import { FRESH_BACKUP_CURSOR, normalizeBackupCursor } from "../core/messages/cursor.ts";
import type { BackupCursor } from "../core/messages/cursor.ts";

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return undefined;
  }
}

/*
  ONE WRITE PER FILE AT A TIME, EACH WITH ITS OWN TEMPORARY FILE.

  The outbox is written from three places that do not wait for each other: the
  page's meeting writes, the drain, and the capture controller. All three wrote
  through one fixed `outbox.json.tmp`, so two writes in flight shared a
  temporary file: the first rename moved it, and the second rename found
  nothing and threw `ENOENT`. That throw came back to the page as the answer to
  its finalize, and the owner's meetings sat "Not in your bucket yet" behind it
  (2026-10-28). Worse, the renames could land out of order and put an older
  queue on disk over a newer one.

  Writes to one path now run in the order they were asked for, and each has a
  temporary name of its own, so neither failure can happen. A write that fails
  does not stop the next one.
*/
const pending = new Map<string, Promise<void>>();
let temporaries = 0;

function writeJson(path: string, value: unknown): Promise<void> {
  const text = JSON.stringify(value, null, 2);
  const previous = pending.get(path) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(() => replaceFile(path, text));
  pending.set(path, next);
  void next.finally(() => {
    if (pending.get(path) === next) pending.delete(path);
  }).catch(() => undefined);
  return next;
}

async function replaceFile(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  temporaries += 1;
  const temporary = `${path}.${process.pid}.${temporaries}.tmp`;
  await writeFile(temporary, text, { mode: 0o600 });
  await rename(temporary, path);
}

export class DesktopStore {
  #dir: string;

  constructor(userDataDir: string) {
    this.#dir = userDataDir;
  }

  get settingsPath(): string {
    return join(this.#dir, "settings.json");
  }

  get outboxPath(): string {
    return join(this.#dir, "outbox.json");
  }

  get imessageCursorPath(): string {
    return join(this.#dir, "imessage-cursor.json");
  }

  get backupCursorPath(): string {
    return join(this.#dir, "messages-backup-cursor.json");
  }

  async readSettings(): Promise<DesktopSettings> {
    return normalizeSettings(await readJson(this.settingsPath));
  }

  async writeSettings(settings: DesktopSettings): Promise<void> {
    await writeJson(this.settingsPath, settings);
  }

  async readOutbox(): Promise<Outbox> {
    return normalizeOutbox(await readJson(this.outboxPath));
  }

  async writeOutbox(outbox: Outbox): Promise<void> {
    await writeJson(this.outboxPath, outbox);
  }

  async readImessageCursor(): Promise<ImessageCursor> {
    const raw = await readJson(this.imessageCursorPath);
    return raw === undefined ? { ...EMPTY_CURSOR } : normalizeCursor(raw);
  }

  async writeImessageCursor(cursor: ImessageCursor): Promise<void> {
    await writeJson(this.imessageCursorPath, cursor);
  }

  async readBackupCursor(): Promise<BackupCursor> {
    const raw = await readJson(this.backupCursorPath);
    return raw === undefined ? { ...FRESH_BACKUP_CURSOR } : normalizeBackupCursor(raw);
  }

  async writeBackupCursor(cursor: BackupCursor): Promise<void> {
    await writeJson(this.backupCursorPath, cursor);
  }
}
