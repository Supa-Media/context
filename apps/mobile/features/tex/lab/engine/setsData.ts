/**
 * Where the Testing tab's conversations come from and go. Training and Dev: the repo's copies
 * (`labData.generated.ts` SETS) under the Lab's drafts in Convex (`functions/texSets.ts`), each edit sent as ops.
 * Test: the eval service's `/tex-test-set` route, people only, read with the @context-lc console grant; its public
 * counts say how many stars each hidden chat holds, without a word of it. Pure apart from `fetch`.
 */
import type { Conversation } from "./sets";
import type { HiddenChat } from "./setsStore";

export type Draft = { id: string; set: string; conv: string; rev: number; removed?: boolean };

/** The repo's conversations with the Lab's drafts over them; a removed one goes, a new one joins. */
export function mergeDrafts(repo: Conversation[], drafts: Draft[]): { convs: Conversation[]; revs: Record<string, number>; repoIds: Set<string> } {
  const byId = new Map(repo.map((c) => [c.id, c]));
  const revs: Record<string, number> = {};
  for (const d of drafts) {
    revs[d.id] = d.rev;
    if (d.removed) {
      byId.delete(d.id);
      continue;
    }
    try {
      byId.set(d.id, JSON.parse(d.conv) as Conversation);
    } catch {
      /* a draft this build can't read keeps the repo copy */
    }
  }
  return { convs: [...byId.values()].filter((c) => c.set === "training" || c.set === "dev"), revs, repoIds: new Set(repo.map((c) => c.id)) };
}

/** The hidden Test chats as the public counts give them: by position, kind, messages and stars, never an id. */
export function hiddenOf(counts: unknown): { hidden: HiddenChat[]; stars: number } {
  const r = counts && typeof counts === "object" ? (counts as Record<string, unknown>) : {};
  const per = Array.isArray(r.perChat) ? r.perChat : [];
  const hidden = per
    .map((x) => (x && typeof x === "object" ? (x as Record<string, unknown>) : null))
    .filter((x): x is Record<string, unknown> => !!x)
    .map((x) => ({ kind: x.kind === "group" ? ("group" as const) : ("one" as const), msgs: Number(x.msgs) || 0, stars: Number(x.stars) || 0 }));
  const stars = Number(r.stars);
  return { hidden, stars: Number.isFinite(stars) ? stars : hidden.reduce((a, h) => a + h.stars, 0) };
}

export type TestClient = {
  counts: () => Promise<{ hidden: HiddenChat[]; stars: number }>;
  list: () => Promise<Conversation[]>;
  put: (c: Conversation) => Promise<void>;
  remove: (id: string) => Promise<void>;
};

const said = (status: number, body: unknown) => {
  const b = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  if (Array.isArray(b.problems) && b.problems.length) return "The Test Set refused it: " + b.problems.slice(0, 3).join("; ");
  if (status === 403) return "Only editors of @context-lc can open the Test Set";
  if (status === 503) return "The Test Set's service can't be reached";
  return "The Test Set didn't answer";
};

/** The eval service's routes, from the MCP endpoint the console shows. */
export function testClient(endpoint: string, token: (refresh: boolean | { rejected: string }) => Promise<string>, doFetch: typeof fetch = (...a) => fetch(...a)): TestClient | null {
  let origin: string;
  try {
    origin = new URL(endpoint).origin;
  } catch {
    return null;
  }
  const call = async (path: string, init?: { method: "POST"; body: unknown }) => {
    const go = async (t: string) =>
      doFetch(origin + path, {
        method: init?.method ?? "GET",
        headers: init ? { authorization: `Bearer ${t}`, "content-type": "application/json" } : { authorization: `Bearer ${t}` },
        body: init ? JSON.stringify(init.body) : undefined,
      });
    const t = await token(false);
    let r = await go(t);
    if (r.status === 401) r = await go(await token({ rejected: t }));
    const body = await r.json().catch(() => null);
    if (r.status !== 200) throw new Error(said(r.status, body));
    return body as Record<string, unknown>;
  };
  return {
    counts: async () => {
      const r = await doFetch(origin + "/tex-eval/counts");
      return hiddenOf(await r.json().catch(() => null));
    },
    // The list names each chat with counts only (`msgs` is how many), so each one's words are read by its id.
    list: async () => {
      const b = await call("/tex-test-set");
      const ids = (Array.isArray(b.chats) ? b.chats : []).map((c) => (c && typeof c === "object" ? String((c as { id?: unknown }).id ?? "") : "")).filter(Boolean);
      const read = await Promise.all(ids.map((id) => call("/tex-test-set?id=" + encodeURIComponent(id)).then((r) => r.conversation as Conversation | undefined)));
      return read.flatMap((c) => (c && Array.isArray(c.msgs) ? [{ id: c.id, title: c.title || c.id, set: "test" as const, kind: c.kind, members: c.members || [], msgs: c.msgs }] : []));
    },
    put: async (c) => void (await call("/tex-test-set", { method: "POST", body: { put: { ...c, set: "test" } } })),
    remove: async (id) => void (await call("/tex-test-set", { method: "POST", body: { remove: id } })),
  };
}
