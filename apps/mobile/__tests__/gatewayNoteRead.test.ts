import { describe, expect, test } from "@jest/globals";
import { ConvexError } from "convex/values";
import { noteReadUrl, readNoteAnswer, readNoteThroughGateway } from "../features/console/files/gatewayNoteRead";
import { refusesOpen } from "../features/console/files/browser/errors";

/**
 * The app opening a note through the gateway (`gatewayNoteRead.ts`, Dev2 2026-11-11): the control plane is asked only
 * when the gateway hands the note back, and a read that could not finish is never a refusal that closes the note.
 *
 * Sabotage, confirmed: treating 503 as `null` fails "a read the gateway could not finish…" (the control plane would
 * run its own engine again); dropping the 409 case fails "a note the gateway hands back…".
 */

const URL_ = "https://gateway.test/@alice/files/read";
const NOTE = {
  kind: "file",
  path: "1-projects/plan.md",
  text: "# Plan\n",
  etag: "c2.doc.rev",
  rawEtag: "raw-1",
  documentId: "doc",
  visibility: "team",
  inherited: "private",
  exception: true,
  readOnly: false,
  encrypted: false,
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

describe("the address", () => {
  test("names the workspace when it is known, and is null for an endpoint that is not a web address", () => {
    expect(noteReadUrl("https://gateway.test/mcp", "alice")).toBe(URL_);
    expect(noteReadUrl("https://gateway.test/mcp", null)).toBe("https://gateway.test/files/read");
    expect(noteReadUrl("https://gateway.test/mcp", "../evil")).toBe("https://gateway.test/files/read");
    expect(noteReadUrl("not a url", "alice")).toBeNull();
  });
});

describe("one open", () => {
  test("is the note, sent with the grant and only the path", async () => {
    const sent: { url: string; init: RequestInit }[] = [];
    const note = await readNoteThroughGateway({ url: URL_, token, path: NOTE.path, fetchImpl: fakeFetch([{ status: 200, body: NOTE }], sent) });
    expect(note).toEqual(NOTE);
    expect(sent).toHaveLength(1);
    expect((sent[0]!.init.headers as Record<string, string>).authorization).toBe("Bearer t1");
    expect(JSON.parse(String(sent[0]!.init.body))).toEqual({ path: NOTE.path });
  });

  test("a note the gateway hands back goes to the control plane", async () => {
    const note = await readNoteThroughGateway({ url: URL_, token, path: NOTE.path, fetchImpl: fakeFetch([{ status: 409, body: { error: "not_object" } }]) });
    expect(note).toBeNull();
  });

  test("a refused grant is re-minted once, never in a loop", async () => {
    const sent: { url: string; init: RequestInit }[] = [];
    const note = await readNoteThroughGateway({
      url: URL_,
      token,
      path: NOTE.path,
      fetchImpl: fakeFetch([{ status: 401, body: {} }, { status: 401, body: {} }], sent),
    });
    expect(note).toBeNull();
    expect(sent.map((one) => (one.init.headers as Record<string, string>).authorization)).toEqual(["Bearer t1", "Bearer t2"]);
  });

  test("a read the gateway could not finish is STORAGE_UNSAFE, which keeps the note open", async () => {
    let caught: unknown = null;
    try {
      await readNoteThroughGateway({ url: URL_, token, path: NOTE.path, fetchImpl: fakeFetch([{ status: 503, body: { error: "unavailable" } }]) });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ConvexError);
    expect((caught as ConvexError<{ code: string }>).data.code).toBe("STORAGE_UNSAFE");
    expect(refusesOpen(caught)).toBe(false);
  });

  test("no answer at all is a network failure, not a refusal and not the control plane", async () => {
    await expect(readNoteThroughGateway({ url: URL_, token, path: NOTE.path, fetchImpl: fakeFetch([]) })).rejects.toBeInstanceOf(TypeError);
  });

  test("an answer this build cannot read is never shown as the note", () => {
    expect(readNoteAnswer({ ...NOTE, text: 3 })).toBeNull();
    expect(readNoteAnswer({ ...NOTE, kind: "folder" })).toBeNull();
    expect(readNoteAnswer({ ...NOTE, encrypted: true, readOnly: false })?.readOnly).toBe(true);
  });
});

describe("what closes an open", () => {
  test("access and existence still close it; a read that could not finish does not", () => {
    expect(refusesOpen(new ConvexError({ code: "FORBIDDEN", message: "no" }))).toBe(true);
    expect(refusesOpen(new ConvexError({ code: "FILE_NOT_FOUND", message: "no" }))).toBe(true);
    expect(refusesOpen(new ConvexError({ code: "SOMETHING_NEW", message: "no" }))).toBe(true);
    expect(refusesOpen(new ConvexError({ code: "STORAGE_UNSAFE", message: "later" }))).toBe(false);
    expect(refusesOpen(new TypeError("offline"))).toBe(false);
  });
});
