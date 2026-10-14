import { openStore } from "../offline/store";

/**
 * Light, Dark, or follow the device — the person's own choice (Dev2,
 * 2026-10-14: "need a way to switch between dark mode and light mode. It
 * can't be based off system settings any longer").
 *
 * ## Two copies, one authority
 *
 * The **account** holds the choice (`functions/appearance.ts`), so picking
 * Dark on a phone holds in the browser and the desktop app too. The **device**
 * holds a copy, because the first frame is painted before any query can
 * answer: `public/index.html` reads the same key before the bundle runs, and
 * this module reads it synchronously on web at import. The copy records whose
 * choice it is and whether a change is still on its way to the account, so
 * `reconcile` can tell "the account moved on" from "this device has not been
 * heard yet". A visitor with no account keeps the device copy only.
 *
 * ## Why a module store rather than React state
 *
 * The Settings picker, the account menu toggle and the theme hooks must never
 * disagree, and the hooks are called from hundreds of components with no
 * provider guaranteed above them. One store, read through
 * `useSyncExternalStore` in `theme.tsx`, is what makes all three one value.
 */

export type Appearance = "system" | "light" | "dark";

export const APPEARANCES: readonly Appearance[] = ["system", "light", "dark"];

/** Read by `public/index.html` too; the shell test checks both spell it alike. */
export const APPEARANCE_KEY = "context.appearance.v1";

export interface StoredAppearance {
  appearance: Appearance;
  /** The account this choice belongs to; absent for a visitor's or one made before sign-in. */
  account?: string;
  /** When the choice was made here, or when the account's copy was adopted. */
  changedAt?: number;
  /** Made on this device and not yet taken by the account. */
  pending?: boolean;
}

const ACCOUNT_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export function isAppearance(value: unknown): value is Appearance {
  return value === "system" || value === "light" || value === "dark";
}

/** Anything unreadable is "follow the device", which is what no choice means. */
export function parseStoredAppearance(raw: string | null | undefined): StoredAppearance {
  if (raw === null || raw === undefined) return { appearance: "system" };
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (value === null || typeof value !== "object") return { appearance: "system" };
    const next: StoredAppearance = {
      appearance: isAppearance(value.appearance) ? value.appearance : "system",
    };
    if (typeof value.account === "string" && ACCOUNT_PATTERN.test(value.account)) next.account = value.account;
    if (typeof value.changedAt === "number" && Number.isFinite(value.changedAt)) next.changedAt = value.changedAt;
    if (value.pending === true) next.pending = true;
    return next;
  } catch {
    return { appearance: "system" };
  }
}

/**
 * The web's synchronous peek, so the first React render already draws the
 * chosen palette. Native has no synchronous storage; there the splash is held
 * until `appearanceLoaded` settles (`app/_layout.tsx`).
 */
function peek(): StoredAppearance | null {
  try {
    const storage = (globalThis as { localStorage?: Storage }).localStorage;
    if (storage === undefined) return null;
    return parseStoredAppearance(storage.getItem(APPEARANCE_KEY));
  } catch {
    return null;
  }
}

const peeked = peek();
let stored: StoredAppearance = peeked ?? { appearance: "system" };
let loaded: Promise<StoredAppearance> | null = peeked === null ? null : Promise.resolve(stored);
const listeners = new Set<() => void>();

function emit(): void {
  mirrorToDocument(stored.appearance);
  for (const listener of listeners) listener();
}

/**
 * Keep `<html data-appearance>` in step on web, so the shell's own ground
 * (`public/index.html`) — what shows past the app's edges and on overscroll —
 * follows a choice made after load, not only one made before it.
 */
function mirrorToDocument(appearance: Appearance): void {
  const root = (globalThis as { document?: Document }).document?.documentElement;
  if (root === undefined) return;
  if (appearance === "system") root.removeAttribute("data-appearance");
  else root.setAttribute("data-appearance", appearance);
}

export function loadAppearance(): Promise<StoredAppearance> {
  if (loaded === null) {
    loaded = openStore()
      .get(APPEARANCE_KEY)
      .then((raw) => {
        const read = parseStoredAppearance(raw);
        const changed = read.appearance !== stored.appearance;
        stored = read;
        if (changed) emit();
        return stored;
      })
      .catch(() => stored);
  }
  // The record as it stands now, not as it stood when first read: a choice
  // made since then is the one every later step must weigh.
  return loaded.then(() => stored);
}

/** Settles once the device copy has been read (at once on web). */
export function appearanceLoaded(): Promise<unknown> {
  return loadAppearance();
}

/** The choice in force, for `useSyncExternalStore`. */
export function currentAppearance(): Appearance {
  return stored.appearance;
}

export function subscribeAppearance(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

async function write(next: StoredAppearance): Promise<void> {
  const changed = next.appearance !== stored.appearance;
  stored = next;
  if (changed) emit();
  try {
    await openStore().set(APPEARANCE_KEY, JSON.stringify(next));
  } catch {
    // Storage refused (full, private mode). The choice still holds for this
    // session, and the account's copy carries it to the next one.
  }
}

/** Who is signed in, so a change made now is recorded as theirs. */
let active: { account: string; afterChange: () => void } | null = null;

/** The person's pick, from Settings or the account menu. Applies at once. */
export async function setAppearance(appearance: Appearance): Promise<void> {
  await loadAppearance();
  await write({
    appearance,
    account: active?.account ?? stored.account,
    changedAt: Date.now(),
    pending: true,
  });
  active?.afterChange();
}

// ── Keeping the device copy and the account's in step ──────────────────────

export interface AccountAppearance {
  appearance: Appearance;
  updatedAt: number;
}

export type AppearanceStep =
  | { kind: "adopt"; value: AccountAppearance }
  | { kind: "push"; appearance: Appearance }
  | { kind: "claim" }
  | { kind: "reset" }
  | { kind: "none" };

/**
 * What to do, given this device's copy and the account's.
 *
 *  - **The later change wins.** A change made here and not yet saved is sent
 *    unless the account holds a newer one; otherwise the account's is applied.
 *  - **A choice made before sign-in is carried up**, unless it is "follow the
 *    device", which the account already means by having no row.
 *  - **Another person's choice on this device is never sent to this
 *    account.** The newcomer gets their own, or follows the device.
 */
export function reconcileAppearance(
  local: StoredAppearance,
  remote: AccountAppearance | null,
  me: string,
): AppearanceStep {
  if (local.account === me) {
    const newer = remote === null || (local.changedAt ?? 0) >= remote.updatedAt;
    if (local.pending === true && newer) return { kind: "push", appearance: local.appearance };
    if (remote !== null && (local.pending === true || local.appearance !== remote.appearance)) {
      return { kind: "adopt", value: remote };
    }
    return { kind: "none" };
  }
  if (local.account === undefined) {
    if (remote !== null) return { kind: "adopt", value: remote };
    return local.appearance === "system" ? { kind: "claim" } : { kind: "push", appearance: local.appearance };
  }
  return remote !== null ? { kind: "adopt", value: remote } : { kind: "reset" };
}

/** Save the choice to the account; resolves to when the account took it. */
export type PushAppearance = (appearance: Appearance) => Promise<number>;

let chain: Promise<void> = Promise.resolve();
let lastRemote: { me: string; remote: AccountAppearance | null } | null = null;

function enqueue(step: () => Promise<void>): Promise<void> {
  chain = chain.then(step).catch(() => {
    // A failed save leaves the change pending; the next chance retries it.
  });
  return chain;
}

async function apply(me: string, remote: AccountAppearance | null, push: PushAppearance): Promise<void> {
  const local = await loadAppearance();
  const step = reconcileAppearance(local, remote, me);
  switch (step.kind) {
    case "none":
      return;
    case "adopt":
      await write({ appearance: step.value.appearance, account: me, changedAt: step.value.updatedAt });
      return;
    case "claim":
      await write({ ...local, account: me });
      return;
    case "reset":
      await write({ appearance: "system", account: me });
      return;
    case "push": {
      const sentAt = local.changedAt;
      const updatedAt = await push(step.appearance);
      // A change made while this save was in flight is still waiting.
      if (stored.changedAt !== sentAt || stored.appearance !== step.appearance) return;
      await write({ appearance: step.appearance, account: me, changedAt: updatedAt });
      if (lastRemote?.me === me) lastRemote = { me, remote: { appearance: step.appearance, updatedAt } };
      return;
    }
  }
}

/** The account's copy has arrived or changed (null: the account has none). */
export function syncAppearanceWithAccount(
  remote: AccountAppearance | null,
  me: string,
  push: PushAppearance,
): Promise<void> {
  lastRemote = { me, remote };
  return enqueue(() => apply(me, remote, push));
}

/** While `me` is signed in, send each change. Returns the stop for sign-out. */
export function startAppearanceSync(me: string, push: PushAppearance): () => void {
  active = {
    account: me,
    afterChange: () => {
      // Only once the account's copy is known, so a change is weighed against
      // it rather than sent blind; until then it waits, pending.
      if (lastRemote?.me !== me) return;
      void enqueue(() => apply(me, lastRemote?.me === me ? lastRemote.remote : null, push));
    },
  };
  return () => {
    if (active?.account === me) active = null;
  };
}

/** Tests only: resolves once every queued step has run. */
export async function appearanceSettledForTests(): Promise<void> {
  let seen: Promise<void> | null = null;
  while (seen !== chain) {
    seen = chain;
    await chain;
  }
}

/** Tests only. */
export function resetAppearanceForTests(next: StoredAppearance = { appearance: "system" }): void {
  stored = next;
  loaded = Promise.resolve(stored);
  active = null;
  chain = Promise.resolve();
  lastRemote = null;
  listeners.clear();
}
