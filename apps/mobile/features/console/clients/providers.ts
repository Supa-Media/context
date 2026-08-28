/**
 * How to point an AI client at this context, per client.
 *
 * The endpoint on its own is not enough to connect anything. Every client asks
 * for it in a different place, under a different name, and half of them do not
 * have a page you can link to at all — so "copy this URL" leaves a person
 * hunting through settings for the screen that will accept it. This module is
 * the missing half: for each client, one link that lands on the right screen,
 * and the exact strings that screen is going to ask for.
 *
 * ## Three kinds of link, and the difference is not cosmetic
 *
 * `install` actually installs — a documented deep link the client turns into a
 * configured server. `connector` opens the client's own add-a-connector screen
 * with the form already open; the person still pastes. `docs` is an admission:
 * this client has no URL that gets you closer than a page of instructions, so
 * that is what the button says and that is where it goes.
 *
 * A `docs` link dressed up as a `connector` one would be the worst outcome
 * here — somebody clicks "Open Notion", lands on a help article, and concludes
 * the button is broken. `ProviderLink.kind` exists so the button label and the
 * caption are derived from what the link really does rather than written twice
 * and allowed to drift.
 *
 * ## Every URL is built from the endpoint that was passed in
 *
 * Not from `MCP_ENDPOINT`. A self-hoster's console points at their own gateway
 * (see `placeholderData.ts`), and a deep link that hard-coded ours would
 * silently connect their client to our deployment. `endpoint` is a parameter on
 * every builder in this file for that reason, and there is a test asserting no
 * built link mentions a host the caller did not supply.
 *
 * Nothing here is a secret: the endpoint is the same URL for everyone and
 * carries no token. Authorization happens after the client arrives, over OAuth,
 * and the grant is what differs per person.
 */

/** What every client should be told this server is called. */
export const SERVER_NAME = "Context";

/**
 * The machine-readable spelling — the key a CLI writes into its config and the
 * `name=` on a deep link. Lower-case and hyphen-free because that is what every
 * one of these tools accepts without quoting.
 */
export const SERVER_SLUG = "context";

/**
 * The description clients that have a description field show to their model.
 *
 * Written for the model, not for the person: it is the sentence that decides
 * whether the client thinks to reach for this context at all. Optional
 * everywhere it appears, which is why `ProviderField.optional` exists.
 */
export const SERVER_DESCRIPTION =
  "Search, read and write my context — notes, projects, decisions and reference material, kept as plain Markdown.";

// ─── Links ───────────────────────────────────────────────────────────────────

/**
 * `install` configures the server outright, `connector` opens the screen that
 * takes it, `docs` goes to instructions because nothing better exists.
 */
export type ProviderLinkKind = "install" | "connector" | "docs";

export interface ProviderLink {
  kind: ProviderLinkKind;
  /** Button label — reads as what pressing it does. */
  label: string;
  href: string;
}

/** One field the client's form (or the person's shell) is going to want. */
/** How a client is made to save its own sessions when they end. */
export interface ProviderHook {
  /** One line on what it will do, in the person's terms. */
  note: string;
  command: (endpoint: string) => string;
}

export interface ProviderField {
  id: string;
  label: string;
  value: string;
  /** The connector works without it. Rendered as "optional", never omitted. */
  optional?: boolean;
}

export interface ClientProvider {
  id: string;
  /** As the client calls itself. */
  name: string;
  /**
   * Matches the name this client registers itself under over OAuth, so a row
   * can say "connected" instead of making somebody cross-reference two lists.
   *
   * A heuristic, and treated as one: the name is chosen by the client, not by
   * us, so a miss leaves a row unticked and the grant still listed under
   * Connected clients below. Order matters — see `providerIdForClientName`.
   */
  matches: RegExp;
  /**
   * Whether the fields go into a form or into a shell.
   *
   * Independent of `ProviderLink.kind`, and the two must not be conflated:
   * Notion's link is `docs` because there is no deep link to its connector
   * screen, but what waits at the end of those instructions is still a form
   * with a Name box in it. Deriving the caption from the link kind alone told
   * those people to run a URL in their terminal.
   */
  form: "connector" | "command";
  /**
   * One line saying what is about to happen, including anything that will stop
   * it happening — a plan requirement, an admin switch, an app that cannot do
   * this at all. This is the only place those caveats are written.
   */
  note: string;
  /**
   * The session-end hook, for the clients that have one.
   *
   * Absent on most of them, and that absence is the honest part: a hook needs a
   * documented end-of-session event that hands over the transcript, and a
   * guessed integration that silently never fires is worse than no button —
   * the person believes their sessions are being saved and finds out months
   * later that none of them were.
   */
  hook?: ProviderHook;
  link: (endpoint: string) => ProviderLink;
  fields: (endpoint: string) => readonly ProviderField[];
}

// ─── Deep links ──────────────────────────────────────────────────────────────

/**
 * Base64 for a Workers-and-Hermes world.
 *
 * `btoa` is not on every runtime this app ships to, and pulling a polyfill in
 * for one query parameter would be a dependency for eleven lines. Input is
 * UTF-8 encoded first, so a self-hoster whose endpoint contains non-ASCII gets
 * a link that works rather than a mangled one.
 */
export function base64Utf8(text: string): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const bytes = utf8Bytes(text);
  let out = "";

  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i];
    const b = bytes[i + 1];
    const c = bytes[i + 2];
    const chunk = (a << 16) | ((b ?? 0) << 8) | (c ?? 0);

    out += alphabet[(chunk >> 18) & 63];
    out += alphabet[(chunk >> 12) & 63];
    out += b === undefined ? "=" : alphabet[(chunk >> 6) & 63];
    out += c === undefined ? "=" : alphabet[chunk & 63];
  }

  return out;
}

/** UTF-8 bytes of a string, via the one encoder every runtime here has. */
function utf8Bytes(text: string): number[] {
  const escaped = encodeURIComponent(text);
  const bytes: number[] = [];

  for (let i = 0; i < escaped.length; i += 1) {
    if (escaped[i] === "%") {
      bytes.push(parseInt(escaped.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      bytes.push(escaped.charCodeAt(i));
    }
  }

  return bytes;
}

/**
 * Cursor's documented one-click install: `name` plus the server's own config
 * object, base64'd. The config is the *value* — what would sit under the
 * server's key in `mcp.json` — not the whole `mcpServers` wrapper.
 */
export function cursorInstallHref(endpoint: string): string {
  const config = base64Utf8(JSON.stringify({ url: endpoint }));
  return `cursor://anysphere.cursor-deeplink/mcp/install?name=${SERVER_SLUG}&config=${encodeURIComponent(config)}`;
}

/**
 * VS Code's install redirect — the same link its one-click badges use.
 *
 * The `insiders.vscode.dev/redirect` form rather than the `vscode:` scheme on
 * purpose: it is an ordinary `https` URL, so a browser that has no handler
 * registered shows a page instead of a dead click, and it hands off to stable
 * VS Code (the host name is a redirector, not a channel selector).
 */
export function vsCodeInstallHref(endpoint: string): string {
  const config = JSON.stringify({ type: "http", url: endpoint });
  return `https://insiders.vscode.dev/redirect/mcp/install?name=${SERVER_SLUG}&config=${encodeURIComponent(config)}`;
}

// ─── Shell safety ────────────────────────────────────────────────────────────

/**
 * Quote an endpoint for a command somebody is going to paste into a shell.
 *
 * The deep links were hardened against an endpoint containing `&`; the commands
 * were not, and they are the more dangerous half. `codex mcp add context --url
 * https://host/mcp?a=1&b=2` truncates at the ampersand, backgrounds the first
 * half and runs `b=2` as an assignment — the person gets a server configured
 * with a mangled URL and no error to tell them so.
 *
 * Bare when it is safe to be bare, because `'https://mcp.context.lc/mcp'` in
 * quotes on every row is noise that teaches people to ignore the quoting on the
 * row where it matters. The unquoted set is the conservative POSIX one; the
 * escape is the standard `'\''` idiom, so even an endpoint containing a single
 * quote survives.
 */
export function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

// ─── Field shapes ────────────────────────────────────────────────────────────

/** Name, optionally a description, and the URL — in the order forms ask. */
function connectorFields(endpoint: string, withDescription: boolean): ProviderField[] {
  const fields: ProviderField[] = [{ id: "name", label: "Name", value: SERVER_NAME }];

  if (withDescription) {
    fields.push({
      id: "description",
      label: "Description",
      value: SERVER_DESCRIPTION,
      optional: true,
    });
  }

  fields.push({ id: "url", label: "MCP server URL", value: endpoint });
  return fields;
}

// ─── The catalogue ───────────────────────────────────────────────────────────

/**
 * Ordered by how many people will want each one, not alphabetically.
 *
 * Adding a client means adding a row here and nothing else: the pane renders
 * whatever this array holds.
 */
export const CLIENT_PROVIDERS: readonly ClientProvider[] = [
  {
    id: "chatgpt",
    matches: /chatgpt|openai/i,
    name: "ChatGPT",
    form: "connector",
    note: "Opens Settings → Connectors with the create form already open. Custom connectors need a paid plan and developer mode, under Settings → Apps → Advanced.",
    link: () => ({
      kind: "connector",
      label: "Open ChatGPT",
      href: "https://chatgpt.com/plugins#settings/Connectors?create-connector=true&redirectAfter=%2Fplugins",
    }),
    fields: (endpoint) => connectorFields(endpoint, true),
  },
  {
    id: "claude",
    matches: /claude/i,
    name: "Claude",
    form: "connector",
    note: "Opens the Add custom connector dialog on claude.ai. Paste the URL, then approve the sign-in Claude sends you to.",
    link: () => ({
      kind: "connector",
      label: "Open Claude",
      href: "https://claude.ai/customize/connectors?modal=add-custom-connector",
    }),
    fields: (endpoint) => connectorFields(endpoint, false),
  },
  {
    id: "claude-code",
    matches: /claude[\s._-]*code/i,
    name: "Claude Code",
    form: "command",
    note: "One command in your terminal, then /mcp inside Claude Code to sign in.",
    hook: {
      note: "Signs in once, then brackets every session: at the start the model is told to orient before answering, and at the end the session's user-visible messages are saved to 0-inbox/. It asks for capture access only — it can add to your inbox and cannot read a single note. Add --orient to have your actual orientation injected at session start instead, which asks for read access on a credential that lives on your machine unattended.",
      command: (endpoint) => `npx -y @context-lc/hook install --endpoint ${shellQuote(endpoint)}`,
    },
    link: () => ({
      kind: "docs",
      label: "Claude Code MCP docs",
      href: "https://docs.claude.com/en/docs/claude-code/mcp",
    }),
    fields: (endpoint) => [
      {
        id: "add",
        label: "Add the server",
        value: `claude mcp add --transport http ${SERVER_SLUG} ${shellQuote(endpoint)}`,
      },
      { id: "login", label: "Then sign in", value: "/mcp" },
    ],
  },
  {
    id: "codex",
    matches: /codex/i,
    name: "Codex CLI",
    form: "command",
    note: "Add it, then sign in — Codex handles the OAuth flow for HTTP servers itself.",
    link: () => ({
      kind: "docs",
      label: "Codex MCP docs",
      href: "https://developers.openai.com/codex/mcp",
    }),
    fields: (endpoint) => [
      {
        id: "add",
        label: "Add the server",
        value: `codex mcp add ${SERVER_SLUG} --url ${shellQuote(endpoint)}`,
      },
      { id: "login", label: "Then sign in", value: `codex mcp login ${SERVER_SLUG}` },
    ],
  },
  {
    id: "cursor",
    matches: /cursor/i,
    name: "Cursor",
    form: "connector",
    note: "Installs it for you — Cursor opens with the server filled in and asks you to confirm.",
    link: (endpoint) => ({
      kind: "install",
      label: "Add to Cursor",
      href: cursorInstallHref(endpoint),
    }),
    fields: (endpoint) => connectorFields(endpoint, false),
  },
  {
    id: "vscode",
    matches: /vs[\s._-]*code|visual studio|copilot/i,
    name: "VS Code",
    form: "connector",
    note: "Installs it into VS Code's MCP settings for Copilot's agent mode.",
    link: (endpoint) => ({
      kind: "install",
      label: "Add to VS Code",
      href: vsCodeInstallHref(endpoint),
    }),
    fields: (endpoint) => connectorFields(endpoint, false),
  },
  {
    id: "notion",
    matches: /notion/i,
    name: "Notion",
    form: "connector",
    note: "For Notion's Custom Agents. A workspace owner has to switch on custom MCP servers first, then add this URL as an approved connection.",
    link: () => ({
      kind: "docs",
      label: "How to connect Notion",
      href: "https://www.notion.com/help/mcp-connections-for-custom-agents",
    }),
    fields: (endpoint) => connectorFields(endpoint, true),
  },
  {
    id: "gemini-cli",
    matches: /gemini/i,
    name: "Gemini CLI",
    form: "command",
    note: "The Gemini app has no custom connectors. Gemini CLI does — one command, and it stores the server in ~/.gemini/settings.json.",
    link: () => ({
      kind: "docs",
      label: "Gemini CLI MCP docs",
      href: "https://google-gemini.github.io/gemini-cli/docs/tools/mcp-server.html",
    }),
    fields: (endpoint) => [
      {
        id: "add",
        label: "Add the server",
        value: `gemini mcp add --transport http ${SERVER_SLUG} ${shellQuote(endpoint)}`,
      },
    ],
  },
];

/**
 * The caption under a provider's fields — what to actually do with them.
 *
 * A command is always run, whatever the link did. A form is where the link
 * kind matters: `install` already filled the form in, so the fields are a
 * fallback rather than an instruction.
 */
export function fieldsCaption(provider: ClientProvider, kind: ProviderLinkKind): string {
  if (provider.form === "command") return "Run these in your terminal.";
  if (kind === "install") {
    return "Nothing to paste — these are here in case you would rather add it by hand.";
  }
  if (kind === "connector") return "Paste these into the form that opens.";
  return "Paste these into the form the instructions point you at.";
}

/**
 * Which row a connected client belongs to, by the name it registered under.
 *
 * Specificity first, and that ordering is the whole correctness of this
 * function: "Claude Code" matches `/claude/` too, so a catalogue-order scan
 * would tick the Claude row for every terminal and leave Claude Code looking
 * unconnected. Anything unrecognised returns `null` and appears only in the
 * Connected clients list, which is the honest outcome — the name is the
 * client's to choose and we do not get to insist it be one of nine.
 */
const MATCH_ORDER = [
  "claude-code",
  "codex",
  "cursor",
  "vscode",
  "gemini-cli",
  "notion",
  "chatgpt",
  "claude",
] as const;

export function providerIdForClientName(name: string): string | null {
  if (typeof name !== "string" || !name.trim()) return null;
  for (const id of MATCH_ORDER) {
    const provider = CLIENT_PROVIDERS.find((candidate) => candidate.id === id);
    if (provider?.matches.test(name)) return provider.id;
  }
  return null;
}

/** How many connected clients belong to each row. */
export function connectedCountsByProvider(
  clients: readonly { name: string }[],
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const client of clients) {
    const id = providerIdForClientName(client.name);
    if (id) counts[id] = (counts[id] || 0) + 1;
  }
  return counts;
}
