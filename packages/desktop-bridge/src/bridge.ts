/**
 * THE ONLY PLACE EITHER SIDE REACHES FOR `window.desktop`.
 *
 * One function, and it answers `null` far more often than it answers a bridge:
 * in a browser, on a phone, in a test, in an iframe the shell refused to expose
 * to, and on a shell whose bridge this bundle does not understand. Every one of
 * those is the ordinary case, and the caller's response to all of them is the
 * same — behave exactly as the web build already behaves, which is a real
 * product rather than a fallback.
 *
 * ## Why detection is not a user-agent sniff
 *
 * Electron's UA is configurable, spoofable, and says nothing about which build
 * is underneath. The presence of a *frozen object with a version this bundle
 * knows* is the only thing that means "there is a shell here that will answer".
 * `docs/decisions/desktop.md`: **detection is
 * `Platform.OS === "web" && getDesktopBridge() !== null`**.
 *
 * ## Why it can refuse, and why refusing is safe
 *
 * The page is the party at risk from a bad `window.desktop`, not the shell: the
 * shell re-checks the sender on every channel it answers, so nothing here is
 * the security boundary for the *machine*. What this function protects is the
 * **person's understanding of what is being recorded**. A page that accepted
 * any object called `desktop` would draw a system-audio switch, report
 * "recording", and produce a meeting with nothing in it. So the checks below
 * fail closed, and closed means "a browser", which is honest.
 *
 * Four refusals, each a different way of being wrong:
 *
 *  - **Absent, or not an object.** No shell. The common case.
 *  - **Not frozen.** The shell exposes `Object.freeze({...})` through
 *    `contextBridge`; an object a page can still edit is a page's own object.
 *    (If a future Electron ever stopped preserving the seal, the fix is a
 *    shell-side check that the exposed bridge is frozen — not weakening this
 *    one, which is what makes a planted bridge visible at all.)
 *  - **A version this bundle does not understand.** See below.
 *  - **A surface that is missing a member its own version promised.** Checked
 *    per version, against the row that was true when that shell shipped.
 *  - **A credential-shaped member.** `desktop.md` is unambiguous: *"There is no
 *    `getToken` here and there must not be."* A shell that grew one is a shell
 *    this bundle refuses to talk to, which turns that sentence into a check
 *    that runs on every load rather than a comment somebody reads once.
 *
 * ## What the credential refusal is, and what it is not
 *
 * It is a check on **names**: every own and inherited key of the bridge and of
 * the sub-objects this contract declares (`connection`, `outbox`), matched as
 * case-insensitive substrings, whether the member is a data property, a getter,
 * or non-enumerable. That is exactly enough for the thing it exists to catch —
 * *our own shell growing a `getToken`* — and it catches it on the next page
 * load in every browser running the bundle rather than in a review somebody
 * skimmed.
 *
 * It is **not** a defence against a hostile shell, and nothing may be built on
 * a reading of it as one. Three ways past it, all of them real and all of them
 * pinned as checks in `bridge.test.mjs` rather than left as prose:
 *
 *  - a Proxy whose `ownKeys` hides the member while its `get` still serves it;
 *  - a member with an innocent name that returns a credential — on the second
 *    call, or once the page has done something worth stealing;
 *  - a credential nested deeper than the one level walked here:
 *    `connection.detail.token` is not seen.
 *
 * None of those is a hole in the product, because **a hostile main process is
 * not in the threat model**: the process that could plant such a bridge is the
 * process that already owns the window, the preload and the credential itself.
 * The boundary that matters runs the other way and lives where the page cannot
 * reach it — `shouldExposeBridge` in the shell, and `isConsoleFrame` /
 * `isBridgeSender` in `main/consoleBridge.ts` beside it. That second clause
 * read "the main process re-checking the sender on **every** channel" when this
 * file was written, which was a sentence copied from a docblock describing a
 * layer nobody had built; `#277` built it, for every channel this bridge
 * answers. The wider IPC surface is not all gated — thirteen registrations of
 * twenty-eight are, and `docs/decisions/desktop.md` carries the rest as named
 * remaining work with a census asserting the split — but none of the ungated
 * ones is reachable from a page, which is what this paragraph needs to be true.
 * The correction is here rather than silent because this paragraph is
 * load-bearing for the refusal above: it is why a check that a Proxy walks past
 * is acceptable. What this refusal buys is that the sentence in
 * `docs/decisions/desktop.md` — *"There is no `getToken` here and there must not
 * be"* — is enforced against the code this house writes, on every load, with the
 * page failing closed to "this is a browser" rather than drawing a shell it has
 * decided to distrust.
 *
 * ## Which way compatibility runs
 *
 * The shell ships as a binary somebody has to install; the UI ships when
 * `deploy-web.yml` publishes. **The UI is therefore the half that has to be
 * backward compatible**, and `isSupportedBridgeVersion` says so in code: a
 * bridge *older* than this bundle is accepted and used at its own version, and
 * only a bridge *newer* than anything this bundle knows is refused. A newer
 * shell is transient — the web bundle catches up within a deploy — and while it
 * lasts the page behaves as a browser rather than calling methods whose shape
 * it is guessing at.
 */

import {
  BRIDGE_VERSION,
  MIN_BRIDGE_VERSION,
  type DesktopBridge,
} from "./contract.ts";

/**
 * Where a bridge would be found. `globalThis` in a browser; a plain object in a
 * test, which is the whole reason this is an argument.
 */
export interface BridgeScope {
  desktop?: unknown;
}

/** Why a bridge was not returned. Diagnostic, never rendered raw at somebody. */
export type BridgeRefusal =
  | "absent"
  | "not-an-object"
  | "not-frozen"
  | "threw"
  | "version-unreadable"
  | "version-unsupported"
  | "surface-incomplete"
  | "credential-shaped-member";

/**
 * The members that must be present, per bridge version.
 *
 * Keyed by version so that adding version 2 adds an entry and **never edits
 * entry 1**: a v1 shell in somebody's Applications folder is checked against
 * the list that was true when it shipped, which is the only list it can
 * satisfy. Editing the v1 row is how a bundle starts refusing shells that are
 * doing nothing wrong.
 */
const VERSION_1_MEMBERS: readonly string[] = Object.freeze([
  "capabilities",
  "startCapture",
  "pauseCapture",
  "resumeCapture",
  "stopCapture",
  "onSegment",
  "onLevel",
  "onCaptureState",
  "onDetection",
  "onTrayCommand",
]);

const REQUIRED_MEMBERS: Readonly<Record<number, readonly string[]>> = Object.freeze({
  1: VERSION_1_MEMBERS,
  /*
    Version 2 adds `meetings`, which is a sub-object rather than a method, so
    this row is version 1's list unchanged. It is written as a reference to the
    same frozen array rather than retyped: the two rows really are the same
    list, and a copy is a place for them to drift apart one member at a time.
  */
  2: VERSION_1_MEMBERS,
});

/** The sub-objects, and the methods each must carry, per version. */
const VERSION_1_SUB_MEMBERS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  connection: Object.freeze(["get", "connect", "disconnect", "onChange"]),
  outbox: Object.freeze(["status", "drain", "onChange"]),
});

const REQUIRED_SUB_MEMBERS: Readonly<
  Record<number, Readonly<Record<string, readonly string[]>>>
> = Object.freeze({
  1: VERSION_1_SUB_MEMBERS,
  /*
    **The version-1 row above is untouched, and that is the rule this table
    exists for.** A shell in somebody's Applications folder answers `1` and is
    checked against the list that was true when it shipped, which is the only
    list it can satisfy. Adding `meetings` to row 1 would make this bundle
    refuse every shell that predates it — shells that are doing nothing wrong —
    and the page would silently become a browser on every one of them.
  */
  2: Object.freeze({ ...VERSION_1_SUB_MEMBERS, meetings: Object.freeze(["write"]) }),
});

/**
 * Names a bridge may never carry, matched case-insensitively as substrings.
 *
 * Substrings rather than an exact list on purpose: the thing being forbidden is
 * a *shape* — anything that hands the page a credential — and `getToken`,
 * `token`, `accessToken` and `refreshToken` are four spellings of one mistake.
 * The cost of the wider rule is that a legitimate member could not be called
 * `tokenCount`; that is a rename, and it is a much smaller cost than the thing
 * being prevented.
 */
const CREDENTIAL_SHAPED = ["token", "secret", "credential", "password", "authorization", "cookie"];

/** Whether this bundle will talk to a bridge reporting `version`. */
export function isSupportedBridgeVersion(version: unknown): boolean {
  if (typeof version !== "number" || !Number.isInteger(version)) return false;
  return version >= MIN_BRIDGE_VERSION && version <= BRIDGE_VERSION;
}

function isCredentialShaped(name: string): boolean {
  const lowered = name.toLowerCase();
  return CREDENTIAL_SHAPED.some((forbidden) => lowered.includes(forbidden));
}

function membersOf(value: object): string[] {
  const names = new Set<string>();
  let current: object | null = value;
  // Walk the prototype chain: a bridge whose `getToken` is on a prototype is
  // still a bridge with a `getToken`. Stops at `Object.prototype`, whose own
  // names belong to the language rather than to whoever built this object.
  while (current !== null && current !== Object.prototype) {
    for (const key of Reflect.ownKeys(current)) {
      if (typeof key === "string") names.add(key);
    }
    current = Reflect.getPrototypeOf(current);
  }
  return [...names];
}

/**
 * The check, with its reason.
 *
 * Exported beside `getDesktopBridge` because "there is no bridge" and "there is
 * a bridge and we refused it" are different facts, and a shell that ships a
 * broken surface should be diagnosable from the console rather than by
 * bisecting. Nothing renders these strings at a person.
 */
export function inspectDesktopBridge(
  scope: BridgeScope | undefined = globalThis as BridgeScope,
): { bridge: DesktopBridge | null; refusal: BridgeRefusal | null } {
  try {
    return inspect(scope);
  } catch {
    /*
      Every read below — the property itself, `Object.isFrozen`, `Reflect
      .ownKeys` — is a read of an object somebody else put on this page, and a
      getter or a Proxy trap that throws is a way to take the app down at the
      exact moment it asks "am I in a shell". So the whole inspection is one
      `try`, and a throw is a refusal rather than an exception the caller has to
      have thought about. It is deliberately not a silent `null`: the reason is
      reported, because a *real* shell that started throwing here would
      otherwise present as "this is a browser now".
    */
    return { bridge: null, refusal: "threw" };
  }
}

function inspect(
  scope: BridgeScope | undefined,
): { bridge: DesktopBridge | null; refusal: BridgeRefusal | null } {
  const refuse = (refusal: BridgeRefusal) => ({ bridge: null, refusal });

  const candidate = scope?.desktop;
  if (candidate === undefined || candidate === null) return refuse("absent");
  if (typeof candidate !== "object") return refuse("not-an-object");
  if (!Object.isFrozen(candidate)) return refuse("not-frozen");

  const bridge = candidate as unknown as DesktopBridge & Record<string, unknown>;

  const version = (bridge as { version?: unknown }).version;
  if (version === undefined) return refuse("version-unreadable");
  if (!isSupportedBridgeVersion(version)) return refuse("version-unsupported");

  const required = REQUIRED_MEMBERS[version as number] ?? [];
  for (const name of required) {
    if (typeof bridge[name] !== "function") return refuse("surface-incomplete");
  }

  const subs = REQUIRED_SUB_MEMBERS[version as number] ?? {};
  for (const [group, methods] of Object.entries(subs)) {
    const sub = bridge[group];
    if (sub === null || typeof sub !== "object") return refuse("surface-incomplete");
    for (const name of methods) {
      if (typeof (sub as Record<string, unknown>)[name] !== "function") {
        return refuse("surface-incomplete");
      }
    }
  }

  // The credential check runs over the bridge and every sub-object it declares,
  // because `connection` is exactly where somebody would put one.
  const surfaces: object[] = [bridge];
  for (const group of Object.keys(subs)) {
    const sub = bridge[group];
    if (sub !== null && typeof sub === "object") surfaces.push(sub);
  }
  for (const surface of surfaces) {
    if (membersOf(surface).some(isCredentialShaped)) return refuse("credential-shaped-member");
  }

  return { bridge: bridge as DesktopBridge, refusal: null };
}

/**
 * The bridge this page has, or `null`.
 *
 * `null` is not an error and is never reported as one: it is a browser, a
 * phone, a test, or a shell this bundle will not guess at. Callers pair it with
 * `Platform.OS === "web"` and take the path they already had.
 */
export function getDesktopBridge(
  scope: BridgeScope | undefined = globalThis as BridgeScope,
): DesktopBridge | null {
  return inspectDesktopBridge(scope).bridge;
}
