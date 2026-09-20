/**
 * THE BINDING, ENUMERATED — so a fifth connect flow cannot arrive without it.
 *
 * `dropboxConnect.ts`, `googleConnect.ts`, `calendarConnect.ts` and
 * `chatProduct.ts` each carry the same three lines: mint a value at start,
 * return it to the starting browser alone, require it back at completion. Each
 * has its own tests for that, and each got them by somebody remembering. The
 * fourth flow is the evidence that remembering is not a guard — the change
 * that bound the first three left Chat completing on `{state, code}` alone,
 * and the attack against it still ran end to end.
 *
 * So this file does not name the four flows to check them. It **finds** every
 * function shaped like an OAuth callback and asserts the binding on each,
 * by shape rather than by name:
 *
 *  - a table that stores a `hashedState` stores a `hashedCompletion` too;
 *  - a **public action** taking `{state, code}` is a callback, and declares
 *    `completionSecret`;
 *  - an **internal mutation** taking `hashedState` declares a required
 *    `hashedCompletion`.
 *
 * A new provider — Notion, Slack, a second storage back end — cannot skip the
 * binding by being written in a new file or under a new name, because none of
 * those rules mentions a file or a name. What it *can* do is arrive with a
 * different shape entirely, which is why the last block drives all four flows
 * end to end from their real `start` actions, and why the counts below are
 * asserted rather than left implicit: a rule whose subject list quietly went
 * empty is the failure mode `docs/decisions/testing.md` opens with.
 *
 * `docs/decisions/identity-and-access.md`, "A third-party OAuth callback
 * carries a secret the browser kept, not just `state`", is the decision this
 * enforces.
 */

import { describe, expect, test, vi, afterEach } from "vitest";
import { api } from "../_generated/api";
import schema from "../schema";
import { asUser, captureError, createUser, createWorkspace, errorCode, setupTest } from "./fixtures.helpers";
import type { Id } from "../_generated/dataModel";

const APP = "https://app.context.invalid";

afterEach(() => {
  vi.unstubAllEnvs();
});

/* -------------------------------------------------------------------------- */
/* Reading the shapes                                                         */
/* -------------------------------------------------------------------------- */

/** What a registered Convex function exposes about itself at runtime. */
interface Registered {
  isPublic?: boolean;
  isInternal?: boolean;
  isAction?: boolean;
  isMutation?: boolean;
  isQuery?: boolean;
  exportArgs?: () => string;
}

/** One argument, as the validator itself describes it — not as source text. */
interface ArgSpec {
  optional: boolean;
}

/**
 * The args a registered function declares. Read from `exportArgs()`, which is
 * the validator Convex will actually enforce — deliberately not a regex over
 * the file, because `docs/decisions/testing.md` records two guards that were
 * defeated by reading source as prose.
 */
function argsOf(fn: unknown): Record<string, ArgSpec> | null {
  const registered = fn as Registered;
  if (typeof registered?.exportArgs !== "function") return null;
  const exported = JSON.parse(registered.exportArgs()) as {
    type?: string;
    value?: Record<string, { optional?: boolean }>;
  };
  if (exported.type !== "object" || typeof exported.value !== "object") return null;
  const args: Record<string, ArgSpec> = {};
  for (const [name, spec] of Object.entries(exported.value ?? {})) {
    args[name] = { optional: spec.optional === true };
  }
  return args;
}

const modules = import.meta.glob("../functions/*.ts", { eager: true }) as Record<
  string,
  Record<string, unknown>
>;

interface Found {
  /** `dropboxConnect.completeDropboxConnect` — the name a failure has to name. */
  where: string;
  args: Record<string, ArgSpec>;
}

function findFunctions(matches: (fn: Registered, args: Record<string, ArgSpec>) => boolean): Found[] {
  const found: Found[] = [];
  for (const [path, mod] of Object.entries(modules)) {
    const file = path.replace("../functions/", "").replace(/\.ts$/, "");
    for (const [name, exported] of Object.entries(mod)) {
      const args = argsOf(exported);
      if (args === null) continue;
      if (!matches(exported as Registered, args)) continue;
      found.push({ where: `${file}.${name}`, args });
    }
  }
  return found.sort((a, b) => a.where.localeCompare(b.where));
}

/** Every public action shaped like an OAuth callback: it takes a `state` and a `code`. */
const callbackActions = findFunctions(
  (fn, args) => fn.isAction === true && fn.isPublic === true && "state" in args && "code" in args,
);

/** Every internal mutation that looks an attempt up by, or parks one under, a hashed state. */
const attemptMutations = findFunctions(
  (fn, args) => fn.isMutation === true && fn.isInternal === true && "hashedState" in args,
);

/* -------------------------------------------------------------------------- */
/* The rules                                                                  */
/* -------------------------------------------------------------------------- */

describe("every third-party connect carries the browser binding", () => {
  /**
   * The non-vacuity check, first, because every rule below is a loop over a
   * list — and a loop over an empty list passes. These lists are also the
   * enumeration itself: a fifth flow lands here as a failing diff, which is
   * the point. Updating them is a one-line edit; noticing that the flow needs
   * `completionSecret` is what the edit is for.
   */
  test("THE ENUMERATION FOUND EVERY FLOW, so no rule below is passing vacuously", () => {
    expect(callbackActions.map((f) => f.where)).toEqual([
      "calendarConnect.completeCalendarConnect",
      "chatProduct.completeChatConnect",
      "dropboxConnect.completeDropboxConnect",
      "googleConnect.completeGmailConnect",
      "googleConnect.completeGoogleConnect",
    ]);
    expect(attemptMutations.map((f) => f.where)).toEqual([
      "calendarConnect.consumeCalendarAttemptAndExchange",
      "calendarConnect.parkCalendarAttempt",
      "chatProduct.consumeChatAttemptAndExchange",
      "chatProduct.parkChatAttempt",
      "dropboxConnect.consumeAttemptAndExchange",
      "dropboxConnect.parkAttempt",
      "googleConnect.consumeAttemptAndExchange",
      "googleConnect.consumeGoogleAttemptAndExchange",
      "googleConnect.parkAttempt",
    ]);
  });

  /**
   * A callback is a public action with no session on it: `#76` established
   * that a sign-in wall here burns the provider's single-use code. `state`
   * cannot be the thing that binds it, because `state` travels through the
   * provider. So this is the arg that has to be there.
   */
  test("a public action taking {state, code} declares completionSecret", () => {
    for (const found of callbackActions) {
      expect(`${found.where}: ${Object.keys(found.args).join(",")}`).toContain("completionSecret");
    }
  });

  /**
   * Required, not optional, on the internal side. The *public* arg is
   * deliberately optional — a browser on yesterday's bundle must get this
   * flow's one refusal rather than a validator error, which would be a
   * distinguishable answer for the length of a deploy — but the internal
   * mutation that reads an attempt takes the hash unconditionally, so a
   * caller that omits it is a type error rather than a bypass.
   */
  test("an internal mutation keyed on hashedState requires a hashedCompletion", () => {
    for (const found of attemptMutations) {
      expect({ where: found.where, has: "hashedCompletion" in found.args }).toEqual({
        where: found.where,
        has: true,
      });
      expect({ where: found.where, optional: found.args.hashedCompletion?.optional }).toEqual({
        where: found.where,
        optional: false,
      });
    }
  });

  /**
   * And the row itself. Optional in the schema only because attempts parked
   * before the binding existed carry none — those are refused rather than
   * trusted, which is a check in the consume path, not here.
   */
  test("a table that stores a hashedState stores a hashedCompletion", () => {
    const tables = Object.entries(schema.tables) as [
      string,
      { validator?: { fields?: Record<string, unknown> } },
    ][];
    const attemptTables = tables.filter(([, t]) => "hashedState" in (t.validator?.fields ?? {}));
    expect(attemptTables.map(([name]) => name).sort()).toEqual([
      "dropboxConnectAttempts",
      "googleConnectAttempts",
    ]);
    for (const [name, table] of attemptTables) {
      expect({ name, has: "hashedCompletion" in (table.validator?.fields ?? {}) }).toEqual({
        name,
        has: true,
      });
    }
  });

  /**
   * **The checker, checked.** Each rule above is a predicate over a shape, so
   * the shapes it would have to catch can be handed to it directly. Without
   * this, a refactor that made `argsOf` answer `null` for everything would
   * turn all four rules green and silent — which is the exact failure
   * `docs/decisions/testing.md` opens with.
   */
  test("the reader itself: a function that hides its args is not silently skipped", () => {
    expect(argsOf({})).toBeNull();
    expect(argsOf({ exportArgs: () => JSON.stringify({ type: "any" }) })).toBeNull();
    const unbound = argsOf({
      exportArgs: () =>
        JSON.stringify({
          type: "object",
          value: {
            state: { fieldType: { type: "string" }, optional: false },
            code: { fieldType: { type: "string" }, optional: false },
          },
        }),
    });
    expect(unbound).not.toBeNull();
    // The shape the rule exists to fail on, failing.
    expect("completionSecret" in (unbound ?? {})).toBe(false);
    const optionalHash = argsOf({
      exportArgs: () =>
        JSON.stringify({
          type: "object",
          value: { hashedCompletion: { fieldType: { type: "string" }, optional: true } },
        }),
    });
    expect(optionalHash?.hashedCompletion.optional).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* The behaviour, driven from each flow's real start action                   */
/* -------------------------------------------------------------------------- */

/**
 * One entry per flow, and `THE ENUMERATION FOUND EVERY FLOW` above is what
 * keeps this list honest: a fifth callback action fails that test until it is
 * added here too.
 *
 * Each `start` is the real action, called by the real owner, with the real
 * flag set — so what is under test is the whole path from minting a secret to
 * requiring it back, not a hand-written row that happens to agree with it.
 */
type TestConvex = ReturnType<typeof setupTest>;

interface Flow {
  name: string;
  enable: () => void;
  start: (
    t: TestConvex,
    owner: Id<"users">,
    workspaceId: Id<"workspaces">,
  ) => Promise<{ authorizeUrl: string; completionSecret: string }>;
  complete: (
    t: TestConvex,
    args: { state: string; code: string; completionSecret?: string },
  ) => Promise<{ workspaceId: Id<"workspaces"> }>;
}

function enableGoogle() {
  vi.stubEnv("MAIL_CONNECT_ENABLED", "true");
  vi.stubEnv("GOOGLE_OAUTH_CLIENT_ID", "test-google-client-id.apps.googleusercontent.com");
}

const FLOWS: Flow[] = [
  {
    name: "dropbox",
    enable: () => vi.stubEnv("DROPBOX_APP_KEY", "test-app-key"),
    start: (t, owner, workspaceId) =>
      asUser(t, owner).action(api.functions.dropboxConnect.startDropboxConnect, {
        workspaceId,
        redirectUri: `${APP}/storage/dropbox/callback`,
      }),
    complete: (t, args) => t.action(api.functions.dropboxConnect.completeDropboxConnect, args),
  },
  {
    name: "gmail",
    enable: enableGoogle,
    start: (t, owner, workspaceId) =>
      asUser(t, owner).action(api.functions.googleConnect.startGmailConnect, {
        workspaceId,
        redirectUri: `${APP}/mail/google/callback`,
      }),
    complete: (t, args) => t.action(api.functions.googleConnect.completeGmailConnect, args),
  },
  {
    name: "google",
    enable: () => {
      vi.stubEnv("MAIL_CONNECT_ENABLED", "true");
      vi.stubEnv("CALENDAR_CONNECT_ENABLED", "true");
      vi.stubEnv("GOOGLE_OAUTH_CLIENT_ID", "test-google-client-id.apps.googleusercontent.com");
    },
    start: (t, owner, workspaceId) =>
      asUser(t, owner).action(api.functions.googleConnect.startGoogleConnect, {
        workspaceId,
        redirectUri: `${APP}/connect/google`,
        syncServices: { gmail: true, calendar: true, chat: true },
      }),
    complete: (t, args) => t.action(api.functions.googleConnect.completeGoogleConnect, args),
  },
  {
    name: "calendar",
    enable: () => {
      vi.stubEnv("CALENDAR_CONNECT_ENABLED", "true");
      vi.stubEnv("GOOGLE_OAUTH_CLIENT_ID", "test-google-client-id.apps.googleusercontent.com");
    },
    start: (t, owner, workspaceId) =>
      asUser(t, owner).action(api.functions.calendarConnect.startCalendarConnect, {
        workspaceId,
        redirectUri: `${APP}/calendar/google/callback`,
      }),
    complete: (t, args) => t.action(api.functions.calendarConnect.completeCalendarConnect, args),
  },
  {
    name: "chat",
    enable: enableGoogle,
    start: (t, owner, workspaceId) =>
      asUser(t, owner).action(api.functions.chatProduct.startChatConnect, {
        workspaceId,
        redirectUri: `${APP}/chat/google/callback`,
      }),
    complete: (t, args) => t.action(api.functions.chatProduct.completeChatConnect, args),
  },
];

async function ownerScenario() {
  const t = setupTest();
  const owner = await createUser(t, "owner@example.invalid");
  const workspaceId = await createWorkspace(t, owner, "atlas");
  return { t, owner, workspaceId };
}

describe("the attack, run against every flow there is", () => {
  /**
   * **THE ATTACK, as it was constructed against `main` — where all four of
   * these passed.**
   *
   *  1. the attacker owns their own workspace and starts a connect for it: every
   *     check in the start action passes, because they really are the owner,
   *     and the redirect really is ours;
   *  2. they send the resulting authorize URL to somebody else;
   *  3. that person consents on the provider's own screen, which correctly
   *     names Context, and the callback lands on our real console — in THEIR
   *     browser, with a code only they hold;
   *  4. their browser completes with what the URL carried and nothing else.
   *
   * PKCE does not see it: the attacker is the initiator, so the verifier is
   * genuinely theirs. The redirect pin does not see it: the attack uses the
   * real redirect. What sees it is a value that never travelled through the
   * provider, which the victim's browser does not have.
   */
  for (const flow of FLOWS) {
    test(`${flow.name}: A BROWSER THAT STARTED NOTHING CANNOT FINISH SOMEBODY ELSE'S CONNECT`, async () => {
      flow.enable();
      const { t, owner, workspaceId } = await ownerScenario();
      const { authorizeUrl, completionSecret } = await flow.start(t, owner, workspaceId);
      const state = new URL(authorizeUrl).searchParams.get("state") as string;
      expect(state).toBeTruthy();
      // The secret is what the URL does not carry. If it did, the victim's
      // browser would have it and the binding would be decoration.
      expect(authorizeUrl).not.toContain(completionSecret);

      const refusal = await captureError(() =>
        flow.complete(t, { state, code: "victims-code" }),
      );
      expect(errorCode(refusal)).toBe("CONNECT_ATTEMPT_INVALID");
    });

    test(`${flow.name}: ...and the browser that did start it finishes it`, async () => {
      flow.enable();
      const { t, owner, workspaceId } = await ownerScenario();
      const { authorizeUrl, completionSecret } = await flow.start(t, owner, workspaceId);
      const state = new URL(authorizeUrl).searchParams.get("state") as string;

      const consumed = await flow.complete(t, {
        state,
        code: "the-owners-code",
        completionSecret,
      });
      expect(consumed.workspaceId).toBe(workspaceId);
    });

    /**
     * **The refusal tells the caller nothing.** Four causes — a state that was
     * never issued, a state already spent, an expired attempt, and a wrong
     * secret — and one answer, compared as JSON rather than by eye. A refusal
     * that named the wrong secret would tell somebody holding a state that
     * the attempt exists, whose it is, and that only one value is missing.
     */
    test(`${flow.name}: a wrong secret is byte-for-byte the answer a state nobody issued gets`, async () => {
      flow.enable();
      const { t, owner, workspaceId } = await ownerScenario();
      const { authorizeUrl } = await flow.start(t, owner, workspaceId);
      const state = new URL(authorizeUrl).searchParams.get("state") as string;

      const wrongSecret = await captureError(() =>
        flow.complete(t, { state, code: "c", completionSecret: "not-the-one-kept" }),
      );
      const neverIssued = await captureError(() =>
        flow.complete(t, {
          state: "never-issued-at-all",
          code: "c",
          completionSecret: "not-the-one-kept",
        }),
      );
      // A second attempt, started and spent, so "already answered" is in the set too.
      const { authorizeUrl: secondUrl, completionSecret: secondSecret } = await flow.start(
        t,
        owner,
        workspaceId,
      );
      const secondState = new URL(secondUrl).searchParams.get("state") as string;
      await flow.complete(t, { state: secondState, code: "c", completionSecret: secondSecret });
      const spent = await captureError(() =>
        flow.complete(t, { state: secondState, code: "c", completionSecret: secondSecret }),
      );

      const shape = (error: unknown) =>
        JSON.stringify({
          data: (error as { data?: unknown }).data,
          message: (error as { message?: string }).message,
        });
      expect(shape(wrongSecret)).toBe(shape(neverIssued));
      expect(shape(spent)).toBe(shape(neverIssued));
    });

    /** A wrong secret spends the attempt, so it is never something to retry against. */
    test(`${flow.name}: a refused completion spends the attempt`, async () => {
      flow.enable();
      const { t, owner, workspaceId } = await ownerScenario();
      const { authorizeUrl, completionSecret } = await flow.start(t, owner, workspaceId);
      const state = new URL(authorizeUrl).searchParams.get("state") as string;

      await captureError(() => flow.complete(t, { state, code: "c" }));
      // Now with the right secret: the attempt is gone, so this is refused too.
      const afterwards = await captureError(() =>
        flow.complete(t, { state, code: "c", completionSecret }),
      );
      expect(errorCode(afterwards)).toBe("CONNECT_ATTEMPT_INVALID");
    });
  }
});
