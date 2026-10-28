/**
 * The OAuth scopes Google accepts for each Google Chat API method Context
 * calls, or once called, copied from Google's public discovery document
 * (`https://chat.googleapis.com/$discovery/rest?version=v1`, revision
 * 20261025, fetched 2026-10-28). Each method's `scopes` list there is the
 * whole set Google takes for it, user and app authentication together.
 *
 * Kept as data so a test can ask what a mocked fetch never can: would Google
 * accept this call with the scopes the connect asks for? A stubbed Chat API
 * answers whatever the test says; the first check-in read called
 * `spaces.members.get` against a stub that answered 200, though no scope the
 * connect asks for allows it. Update a row only from the discovery document
 * itself.
 */

const AUTH = "https://www.googleapis.com/auth/";

export interface ChatMethod {
  id: string;
  httpMethod: "GET" | "POST";
  /** Matches the path after `https://chat.googleapis.com/v1/`. */
  path: RegExp;
  scopes: readonly string[];
}

export const CHAT_DISCOVERY_REVISION = "20261025";

export const CHAT_METHODS: readonly ChatMethod[] = [
  {
    id: "chat.spaces.list",
    httpMethod: "GET",
    path: /^spaces$/,
    scopes: ["chat.bot", "chat.spaces", "chat.spaces.readonly"].map((s) => AUTH + s),
  },
  {
    id: "chat.spaces.findDirectMessage",
    httpMethod: "GET",
    path: /^spaces:findDirectMessage$/,
    scopes: ["chat.bot", "chat.spaces", "chat.spaces.readonly"].map((s) => AUTH + s),
  },
  {
    id: "chat.spaces.setup",
    httpMethod: "POST",
    path: /^spaces:setup$/,
    scopes: ["chat.spaces", "chat.spaces.create"].map((s) => AUTH + s),
  },
  {
    id: "chat.spaces.members.get",
    httpMethod: "GET",
    path: /^spaces\/[^/]+\/members\/[^/]+$/,
    scopes: [
      "chat.admin.memberships",
      "chat.admin.memberships.readonly",
      "chat.app.memberships",
      "chat.bot",
      "chat.memberships",
      "chat.memberships.readonly",
    ].map((s) => AUTH + s),
  },
  {
    id: "chat.spaces.messages.list",
    httpMethod: "GET",
    path: /^spaces\/[^/]+\/messages$/,
    scopes: ["chat.app.messages.readonly", "chat.import", "chat.messages", "chat.messages.readonly"].map((s) => AUTH + s),
  },
  {
    id: "chat.spaces.messages.create",
    httpMethod: "POST",
    path: /^spaces\/[^/]+\/messages$/,
    scopes: ["chat.bot", "chat.import", "chat.messages", "chat.messages.create"].map((s) => AUTH + s),
  },
  {
    id: "chat.spaces.get",
    httpMethod: "GET",
    path: /^spaces\/[^/:]+$/,
    scopes: [
      "chat.admin.spaces",
      "chat.admin.spaces.readonly",
      "chat.app.spaces",
      "chat.bot",
      "chat.spaces",
      "chat.spaces.readonly",
    ].map((s) => AUTH + s),
  },
];

/** The discovery method a Chat API request is, or throws: an unknown call is one nobody checked. */
export function chatMethodOf(url: string, httpMethod: string): ChatMethod {
  const path = decodeURIComponent(new URL(url).pathname.replace(/^\/v1\//, ""));
  const found = CHAT_METHODS.find((method) => method.httpMethod === httpMethod && method.path.test(path));
  if (found === undefined) throw new Error(`no discovery row for ${httpMethod} ${path}: add it from Google's discovery document`);
  return found;
}

/** Whether Google would take this call with these granted scopes. */
export function chatCallAllowed(url: string, httpMethod: string, granted: readonly string[]): boolean {
  return chatMethodOf(url, httpMethod).scopes.some((scope) => granted.includes(scope));
}
