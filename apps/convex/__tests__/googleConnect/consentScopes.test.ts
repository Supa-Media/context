/**
 * The minimum consent every new request asks for (2026-10-30, after Google
 * asked for exact scope matching and least privilege per feature;
 * `standardScopesFor` / `agentScopesFor` in `lib/googleConnect/aiScopes.ts`).
 *
 * The standard client, the person's own use: identity, plus the owned
 * calendar read with Calendar (the Meetings view). The agent client, AI's:
 * identity and each connected product's own scopes, Gmail's read and drafts,
 * the owned calendar's events, Chat's read and send. Asked through the real
 * start actions, with the deployment's global settings in every state, since
 * those settings now decide only how rows made before are read.
 *
 * Sabotage record (applied, run, observed failing, reverted):
 *  1. `standardScopesFor` asking `gmail.readonly` again → "the standard client
 *     is asked for identity and the owned calendar read, and nothing else"
 *     fails.
 *  2. `AGENT_PRODUCT_SCOPES.calendar` as the broad `calendar.events` → "no
 *     new request, of either client, names the broad calendar pair" fails.
 *  3. Chat's scopes back on `AGENT_PRODUCT_SCOPES.gmail` → "a product the
 *     person did not connect contributes nothing" fails.
 *  4. `agentConnectTarget` dropping the legacy Chat carry-over → "allowing AI
 *     access on a row made before keeps Chat it already sent" fails.
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { api } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import { asUser, seedGoogleConnection } from "../fixtures.helpers";
import {
  CALENDAR_OWNED_READ_SCOPE,
  CALENDAR_OWNED_SCOPE,
  CALENDAR_SCOPES,
  CALENDAR_WRITE_SCOPE,
  CHAT_READ_SCOPE,
  CHAT_SEND_SCOPE,
  CHAT_SPACES_CREATE_SCOPE,
  CHAT_SPACES_READ_SCOPE,
  GMAIL_COMPOSE_SCOPE,
  GMAIL_SCOPES,
  GMAIL_SEND_SCOPE,
  IDENTITY_SCOPES,
  canSendEmail,
} from "../../functions/lib/googleOAuth";
import { readOnlyServices } from "../../functions/lib/googleWriteAccess";
import { APP, REDIRECT, enableAllGoogleConnect, personalScenario } from "./fixtures.helpers";
import { legacyGrantScopes } from "./legacyScopes.helpers";

const AGENT_ID = "agent-client.apps.googleusercontent.example";
const CALLBACK = `${APP}/connect/google`;
/** The deployment's global settings, every state they can be in today. */
const GLOBALS = [
  { GOOGLE_AGENT_CLIENT_ACTIVE: "", GOOGLE_CALENDAR_SCOPE: "" },
  { GOOGLE_AGENT_CLIENT_ACTIVE: "", GOOGLE_CALENDAR_SCOPE: "owned" },
  { GOOGLE_AGENT_CLIENT_ACTIVE: "true", GOOGLE_CALENDAR_SCOPE: "" },
  { GOOGLE_AGENT_CLIENT_ACTIVE: "true", GOOGLE_CALENDAR_SCOPE: "owned" },
];

const STANDARD = [...IDENTITY_SCOPES, CALENDAR_OWNED_READ_SCOPE];
const AGENT = [
  ...IDENTITY_SCOPES,
  GMAIL_SCOPES[0],
  GMAIL_COMPOSE_SCOPE,
  CALENDAR_OWNED_SCOPE,
  CHAT_READ_SCOPE,
  CHAT_SPACES_READ_SCOPE,
  CHAT_SEND_SCOPE,
  CHAT_SPACES_CREATE_SCOPE,
];

afterEach(() => {
  vi.unstubAllEnvs();
});

function deployment(globals: Record<string, string>) {
  enableAllGoogleConnect();
  vi.stubEnv("APP_ORIGIN", APP);
  vi.stubEnv("GOOGLE_AGENT_OAUTH_CLIENT_ID", AGENT_ID);
  for (const [key, value] of Object.entries(globals)) vi.stubEnv(key, value);
}

const scopesOf = (authorizeUrl: string) => new URL(authorizeUrl).searchParams.get("scope")?.split(" ") ?? [];

async function standardAsked(products = { gmail: true, calendar: true, chat: true }) {
  const { t, owner, workspaceId } = await personalScenario();
  const result = await asUser(t, owner).action(api.functions.googleConnect.startGoogleConnect, {
    workspaceId,
    redirectUri: REDIRECT,
    syncServices: products,
  });
  return scopesOf(result.authorizeUrl);
}

async function agentAsked(row: { products: Array<"gmail" | "calendar" | "chat">; scopes: string[]; consentPlan?: "split" }) {
  const { t, owner, workspaceId } = await personalScenario();
  const connectionId: Id<"googleConnections"> = await seedGoogleConnection(t, { workspaceId, boundBy: owner });
  await t.run((ctx) => ctx.db.patch(connectionId, row));
  const started = await asUser(t, owner).action(api.functions.googleClients.startGoogleAgentConnect, {
    workspaceId,
    connectionId,
    redirectUri: CALLBACK,
  });
  expect(new URL(started.authorizeUrl).searchParams.get("client_id")).toBe(AGENT_ID);
  return scopesOf(started.authorizeUrl);
}

describe("exactly what each client is asked for", () => {
  test("the standard client is asked for identity and the owned calendar read, and nothing else", async () => {
    for (const globals of GLOBALS) {
      deployment(globals);
      expect(new Set(await standardAsked())).toEqual(new Set(STANDARD));
      expect(new Set(await standardAsked({ gmail: true, calendar: false, chat: true }))).toEqual(new Set(IDENTITY_SCOPES));
      vi.unstubAllEnvs();
    }
  });

  test("the agent client is asked for Gmail's read and drafts, the owned calendar's events and Chat, and nothing else", async () => {
    for (const globals of GLOBALS) {
      deployment(globals);
      const asked = await agentAsked({ products: ["gmail", "calendar", "chat"], scopes: [...IDENTITY_SCOPES], consentPlan: "split" });
      expect(new Set(asked)).toEqual(new Set(AGENT));
      vi.unstubAllEnvs();
    }
  });

  test("both clients together are the ten scopes, one owned calendar pair and no other calendar scope", () => {
    expect(new Set([...STANDARD, ...AGENT]).size).toBe(10);
  });

  test("no new request, of either client, names the broad calendar pair or gmail.send", async () => {
    for (const globals of GLOBALS) {
      deployment(globals);
      const asked = [...(await standardAsked()), ...(await agentAsked({ products: ["gmail", "calendar", "chat"], scopes: legacyGrantScopes(["gmail", "calendar"]) }))];
      for (const broad of [CALENDAR_SCOPES[0], CALENDAR_WRITE_SCOPE, GMAIL_SEND_SCOPE]) expect(asked).not.toContain(broad);
      vi.unstubAllEnvs();
    }
  });

  test("a product the person did not connect contributes nothing", async () => {
    deployment(GLOBALS[0]!);
    const gmailOnly = await agentAsked({ products: ["gmail"], scopes: [...IDENTITY_SCOPES], consentPlan: "split" });
    expect(new Set(gmailOnly)).toEqual(new Set([...IDENTITY_SCOPES, GMAIL_SCOPES[0], GMAIL_COMPOSE_SCOPE]));
    const calendarOnly = await agentAsked({ products: ["calendar"], scopes: [...STANDARD], consentPlan: "split" });
    expect(new Set(calendarOnly)).toEqual(new Set([...IDENTITY_SCOPES, CALENDAR_OWNED_SCOPE]));
  });

  test("allowing AI access on a row made before keeps Chat it already sent", async () => {
    deployment(GLOBALS[0]!);
    // Chat rode on Gmail's standard consent then: the row lists Gmail only.
    const asked = await agentAsked({ products: ["gmail"], scopes: legacyGrantScopes(["gmail"]) });
    expect(asked).toEqual(expect.arrayContaining([CHAT_READ_SCOPE, CHAT_SEND_SCOPE, CHAT_SPACES_CREATE_SCOPE]));
    // A row made under the minimum consent gets Chat by connecting Chat, never by Gmail.
    const split = await agentAsked({ products: ["gmail"], scopes: legacyGrantScopes(["gmail"]), consentPlan: "split" });
    expect(split.some((scope) => scope.includes("/chat."))).toBe(false);
  });
});

describe("what older grants can still do", () => {
  test("either Gmail write scope sends, so older send-only grants keep working; read alone never does", () => {
    expect(canSendEmail([...GMAIL_SCOPES, GMAIL_COMPOSE_SCOPE])).toBe(true);
    expect(canSendEmail([...GMAIL_SCOPES, GMAIL_SEND_SCOPE])).toBe(true);
    expect(canSendEmail([...GMAIL_SCOPES, GMAIL_SEND_SCOPE, GMAIL_COMPOSE_SCOPE])).toBe(true);
    expect(canSendEmail([...GMAIL_SCOPES])).toBe(false);
    const services = { gmail: true, calendar: false, chat: false };
    expect(readOnlyServices(services, [...GMAIL_SCOPES, GMAIL_COMPOSE_SCOPE])).toEqual([]);
    expect(readOnlyServices(services, [...GMAIL_SCOPES])).toEqual(["gmail"]);
  });
});
