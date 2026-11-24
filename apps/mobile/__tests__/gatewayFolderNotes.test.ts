import { describe, expect, test } from "@jest/globals";
import { folderNotesAnswer, folderNotesThroughGateway, folderNotesUrl, frontNotesThroughGateway, peekNoteThroughGateway } from "../features/offline/gatewayFolderNotes";
import { tableListNotes } from "../features/offline/serverLists";

/**
 * A folder page's notes through the gateway (`gatewayFolderNotes.ts`, owner 2026-11-24: "we should just be able to
 * talk directly to cloudflare"): the control plane is asked whenever the gateway does not answer with a page, so the
 * road can never leave a page without its notes.
 *
 * Sabotage, confirmed: answering a 409 body as a page fails "a workspace the gateway hands back…"; dropping the
 * re-mint fails "a refused grant is minted again once".
 */

const URL_ = "https://gateway.test/files/folder-notes";
const PAGE = {
  kind: "folderNotes",
  available: true,
  notes: [{ path: "2-areas/health.md", updatedAt: 5, size: 40, props: JSON.stringify({ properties: { status: "active" }, heading: "Health", lede: "Stay well." }) }],
  cursor: null,
  missing: [],
  fill: false,
};

function fakeFetch(answers: { status: number; body: unknown }[], sent: { url: string; init: RequestInit }[] = []) {
  return (async (url: string, init: RequestInit) => {
    sent.push({ url, init });
    const next = answers.shift();
    if (next === undefined) throw new TypeError("offline");
    return { status: next.status, json: async () => next.body } as Response;
  }) as unknown as typeof fetch;
}

const token = async (refresh: false | { rejected: string }) => (refresh === false ? "t1" : "t2");
const ask = (fetchImpl: typeof fetch, cursor?: string) =>
  folderNotesThroughGateway({ url: URL_, token, folder: "2-areas", subfolders: true, cursor, fetchImpl });

describe("the address", () => {
  test("is the gateway's origin, whatever path the endpoint has", () => {
    expect(folderNotesUrl("https://gateway.test/mcp")).toBe(URL_);
    expect(folderNotesUrl("https://gateway.test/@alice/mcp")).toBe(URL_);
    expect(folderNotesUrl("not a url")).toBeNull();
    expect(folderNotesUrl("javascript:alert(1)")).toBeNull();
  });
});

describe("a folder page through the gateway", () => {
  test("is the page the gateway answers, asked with the grant and nothing else", async () => {
    const sent: { url: string; init: RequestInit }[] = [];
    const page = await ask(fakeFetch([{ status: 200, body: PAGE }], sent), "2-areas/a.md");
    expect(page).toEqual({ available: true, notes: [{ path: "2-areas/health.md", updatedAt: 5, props: PAGE.notes[0].props }], cursor: null, missing: [] });
    expect(sent[0].url).toBe(URL_);
    expect((sent[0].init.headers as Record<string, string>).authorization).toBe("Bearer t1");
    expect(JSON.parse(String(sent[0].init.body))).toEqual({ folder: "2-areas", subfolders: true, cursor: "2-areas/a.md" });
  });

  test("draws on the page as the control plane's answer does", async () => {
    const list = await tableListNotes({ readNotes: async () => [], folderNotes: async () => (await ask(fakeFetch([{ status: 200, body: PAGE }])))! }, "2-areas", true);
    expect(list.complete).toBe(true);
    expect(list.notes[0]).toMatchObject({ path: "2-areas/health.md", heading: "Health", lede: "Stay well.", properties: { status: "active" } });
  });

  test("a workspace the gateway hands back is asked of the control plane", async () => {
    for (const status of [409, 400, 403, 404, 500, 503]) {
      expect(await ask(fakeFetch([{ status, body: { ...PAGE, error: "not_object" } }]))).toBeNull();
    }
  });

  test("a refused grant is minted again once, never in a loop", async () => {
    const sent: { url: string; init: RequestInit }[] = [];
    expect(await ask(fakeFetch([{ status: 401, body: null }, { status: 200, body: PAGE }], sent))).not.toBeNull();
    expect((sent[1].init.headers as Record<string, string>).authorization).toBe("Bearer t2");
    const twice: { url: string; init: RequestInit }[] = [];
    expect(await ask(fakeFetch([{ status: 401, body: null }, { status: 401, body: null }, { status: 200, body: PAGE }], twice))).toBeNull();
    expect(twice).toHaveLength(2);
  });

  test("no grant, no network or a body this build cannot read is the control plane's to answer", async () => {
    expect(await folderNotesThroughGateway({ url: URL_, token: async () => { throw new Error("Not authenticated"); }, folder: "", subfolders: false, cursor: undefined, fetchImpl: fakeFetch([]) })).toBeNull();
    expect(await ask(fakeFetch([]))).toBeNull();
    expect(await ask(fakeFetch([{ status: 200, body: { ...PAGE, notes: [{ path: 3, props: "{}" }] } }]))).toBeNull();
    expect(folderNotesAnswer({ ...PAGE, kind: "file" })).toBeNull();
  });
});

describe("a page's front notes and description through the gateway", () => {
  const page = (notes: { path: string }[], extra: Record<string, unknown> = {}) => ({
    status: 200,
    body: { ...PAGE, notes: notes.map((each) => ({ ...each, props: JSON.stringify({ heading: each.path }) })), ...extra },
  });

  test("the front notes of each folder, from one page each, without the folder's other notes", async () => {
    const sent: { url: string; init: RequestInit }[] = [];
    const notes = await frontNotesThroughGateway({
      url: URL_,
      token,
      folders: ["p/a", "p/b"],
      fetchImpl: fakeFetch([page([{ path: "p/a/about.md" }, { path: "p/a/plan.md" }]), page([{ path: "p/b/README.md" }])], sent),
    });
    expect(notes?.map((each) => each.path)).toEqual(["p/a/about.md", "p/b/README.md"]);
    expect(sent.map((each) => JSON.parse(String(each.init.body)))).toEqual([
      { folder: "p/a", subfolders: false },
      { folder: "p/b", subfolders: false },
    ]);
  });

  test("anything less than a whole answer is the control plane's to give", async () => {
    const ask = (answers: { status: number; body: unknown }[]) => frontNotesThroughGateway({ url: URL_, token, folders: ["p/a"], fetchImpl: fakeFetch(answers) });
    expect(await ask([{ status: 409, body: { error: "not_object" } }])).toBeNull();
    expect(await ask([page([{ path: "p/a/about.md" }], { cursor: "p/a/about.md" })])).toBeNull();
    expect(await ask([page([], { missing: ["p/a/about.md"] })])).toBeNull();
  });

  test("a description is a peek, never an open, and only of a Markdown note", async () => {
    const sent: { url: string; init: RequestInit }[] = [];
    const read = { kind: "file", path: "p/a/about.md", text: "# A\n", etag: "raw", visibility: "team", inherited: "team", exception: false, readOnly: false, encrypted: false };
    expect(await peekNoteThroughGateway({ url: "https://gateway.test/files/read", token, path: "p/a/about.md", fetchImpl: fakeFetch([{ status: 200, body: read }], sent) })).toEqual({ text: "# A\n", encrypted: false });
    expect(JSON.parse(String(sent[0].init.body))).toEqual({ path: "p/a/about.md", peek: true });
    expect(await peekNoteThroughGateway({ url: "https://gateway.test/files/read", token, path: "p/a/metrics.csv", fetchImpl: fakeFetch([], sent) })).toBeNull();
    expect(sent).toHaveLength(1);
    expect(await peekNoteThroughGateway({ url: "https://gateway.test/files/read", token, path: "p/a/about.md", fetchImpl: fakeFetch([{ status: 503, body: { error: "unavailable" } }]) })).toBeNull();
  });
});
