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

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return undefined;
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2), { mode: 0o600 });
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
}
