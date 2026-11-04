/**
 * Where the Tex page's data comes from: the gateway's `/tex/page` routes in
 * the product, an in-memory copy in the visual fixture and the tests. The
 * screens only ever see this interface, so the page the fixture draws is the
 * page production draws.
 *
 * Authenticated exactly as `/tex/computer` is (`useTexComputer`): a console
 * grant held in memory, replaced once when the gateway refuses it, never in a
 * loop. The handle is only the page's address; the gateway decides whose page
 * it is from the grant and refuses a handle that is not the caller's own.
 */

import { readJobDetail, readList, readOverview } from "./texPageRead";
import { openLive, type Live, type PatchFrame } from "./texPageLive";
import { readLedgerPage, readLedgerSees } from "./texPageLedger";
import { readMachinesPage } from "./texMachineRead";
import type { MachinesPage } from "./texMachineTypes";
import type { JobDetail, LedgerPage, LedgerQuery, LedgerSees, ListKind, ListPage, Overview, PageAction } from "./texPageTypes";

type Route = "" | "job" | "list" | "act" | "ledger" | "machines";

export type Read<T> = { kind: "ok"; value: T } | { kind: "notYours" } | { kind: "failed" };

/**
 * Which part of the overview to read (the owner, 2026-11-04: "make the hub
 * page load fast"): `core` is everything the first screen draws but the
 * tiles, `tiles` the five shortcut tiles alone (their reads are the slow
 * ones: routines, About and Tex's browser), `chats` only the chat picker.
 * Absent reads all of it. The page asks `core` and `tiles` side by side and
 * draws the first that lands.
 */
export type OverviewPart = "core" | "tiles" | "chats";

const PART_SECTIONS: Record<OverviewPart, readonly string[]> = {
  core: ["chats", "chat", "status", "thinking", "thinkingToday", "minions", "earlier", "earlierWeek", "behind"],
  tiles: ["chat", "tiles"],
  chats: ["chats", "chat"],
};

export interface TexPageSource {
  overview(chat: string, part?: OverviewPart): Promise<Read<Overview>>;
  job(chat: string, id: string): Promise<Read<JobDetail>>;
  list<K extends ListKind>(chat: string, kind: K, cursor?: string): Promise<Read<ListPage<K>>>;
  act(chat: string, action: PageAction): Promise<{ ok: boolean; error?: string }>;
  /** The chat's history file, raw, filtered. */
  ledger(chat: string, query: LedgerQuery): Promise<Read<LedgerPage>>;
  /** The chat as the next texted turn is shown it. */
  sees(chat: string): Promise<Read<LedgerSees>>;
  /**
   * The person's machines, as this chat sees them (`/tex/page/machines`). A
   * gateway that does not know machines answers 404, read as `notYours`, and
   * the page then shows nothing about machines.
   */
  machines(chat: string): Promise<Read<MachinesPage>>;
  /** The live feed for one chat; null where there is none. */
  live(chat: string, onPatch: (patch: PatchFrame) => void, onLive: (live: boolean) => void): Live | null;
}

export function texPageUrl(mcpEndpoint: string, route: Route): string | null {
  let parsed: URL;
  try {
    parsed = new URL(mcpEndpoint);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
  return `${parsed.origin}/tex/page${route ? `/${route}` : ""}`;
}

/** How one answer reads: refused as not the caller's, failed, or its body. */
export function readAnswer<T>(status: number, body: unknown, read: (v: unknown) => T | null): Read<T> {
  const r = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : null;
  // A group that is not the caller's answers exactly as a missing one does.
  if ((status === 403 && r?.error === "not_yours") || status === 404) return { kind: "notYours" };
  if (status !== 200 || r === null) return { kind: "failed" };
  const value = read(r);
  return value === null ? { kind: "failed" } : { kind: "ok", value };
}

export interface GatewaySourceOptions {
  endpoint: string;
  handle: string;
  /** The console grant's token; `{rejected}` replaces the one the gateway refused. */
  token: (refresh: boolean | { rejected: string }) => Promise<string>;
  fetch?: typeof fetch;
}

export function gatewaySource(options: GatewaySourceOptions): TexPageSource {
  const doFetch = options.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const post = async (route: Route, body: Record<string, unknown>) => {
    const url = texPageUrl(options.endpoint, route);
    if (url === null) return null;
    const call = async (refresh: boolean | { rejected: string }) => {
      const token = await options.token(refresh);
      const response = await doFetch(url, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ handle: options.handle, ...body }),
      });
      return { token, status: response.status, body: await response.json().catch(() => null) };
    };
    try {
      let answer = await call(false);
      if (answer.status === 401) answer = await call({ rejected: answer.token });
      return answer;
    } catch {
      return null;
    }
  };
  const origin = (() => {
    try {
      return new URL(options.endpoint).origin;
    } catch {
      return null;
    }
  })();

  return {
    async overview(chat, part) {
      const a = await post("", { chat, ...(part ? { sections: PART_SECTIONS[part] } : {}) });
      return a === null ? { kind: "failed" } : readAnswer(a.status, a.body, readOverview);
    },
    async job(chat, id) {
      const a = await post("job", { chat, id });
      return a === null ? { kind: "failed" } : readAnswer(a.status, a.body, (b) => readJobDetail((b as { job?: unknown }).job));
    },
    async list(chat, kind, cursor) {
      const a = await post("list", { chat, kind, ...(cursor ? { cursor } : {}) });
      return a === null ? { kind: "failed" } : readAnswer(a.status, a.body, (b) => readList(kind, b));
    },
    async act(chat, action) {
      const a = await post("act", { chat, action });
      if (a === null) return { ok: false, error: "unreachable" };
      const body = a.body as { ok?: unknown; error?: unknown } | null;
      return a.status === 200 && body?.ok !== false
        ? { ok: true }
        : { ok: false, error: typeof body?.error === "string" ? body.error : `status_${a.status}` };
    },
    async machines(chat) {
      const a = await post("machines", { chat });
      return a === null ? { kind: "failed" } : readAnswer(a.status, a.body, readMachinesPage);
    },
    async ledger(chat, query) {
      const a = await post("ledger", { chat, view: "raw", ...query });
      return a === null ? { kind: "failed" } : readAnswer(a.status, a.body, readLedgerPage);
    },
    async sees(chat) {
      const a = await post("ledger", { chat, view: "sees" });
      return a === null ? { kind: "failed" } : readAnswer(a.status, a.body, readLedgerSees);
    },
    live(chat, onPatch, onLive) {
      if (origin === null || typeof WebSocket === "undefined") return null;
      return openLive({ gatewayOrigin: origin, handle: options.handle, chat, token: (r) => options.token(r), onPatch, onLive });
    },
  };
}
