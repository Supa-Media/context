import { describe, expect, it } from "vitest";
import { UPLOAD_DIR, browserbaseUploads, setFileInput, uploadToSession } from "./upload";

const ENV = { BROWSERBASE_API_KEY: "bb_test_key", BROWSERBASE_PROJECT_ID: "proj-test" };
// "%PDF-1.4\n": nine bytes.
const file = { name: "receipt.pdf", type: "application/pdf", data: "JVBERi0xLjQK" };

function fakeApi(status = 200) {
  const calls: Array<{ url: string; method: string; key: string | null; form: FormData | null }> = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      key: new Headers(init?.headers).get("X-BB-API-Key"),
      form: init?.body instanceof FormData ? init.body : null,
    });
    return new Response(JSON.stringify({ message: status === 200 ? "ok" : "account 1234 is over its limit" }), { status });
  }) as typeof fetch;
  return { calls, fetcher };
}

/** A document whose CDP session answers for one file box, or none. */
function fakeSend({ present = true } = {}) {
  const sent: Array<{ method: string; params?: Record<string, unknown> }> = [];
  const send = (async (method: string, params?: Record<string, unknown>) => {
    sent.push({ method, params });
    if (method === "Runtime.evaluate") return present ? { result: { type: "object", subtype: "node", objectId: "box-1" } } : { result: { type: "object", subtype: "null" } };
    return {};
  }) as <T = unknown>(method: string, params?: Record<string, unknown>) => Promise<T>;
  return { send, sent };
}

describe("uploadToSession", () => {
  it("sends the file to the session's own uploads, and answers where the browser finds it", async () => {
    const api = fakeApi();
    const path = await uploadToSession(ENV, "sess-1", file, api.fetcher);
    expect(path).toBe(`${UPLOAD_DIR}receipt.pdf`);
    expect(api.calls).toHaveLength(1);
    expect(api.calls[0]).toMatchObject({ url: "https://api.browserbase.com/v1/sessions/sess-1/uploads", method: "POST", key: "bb_test_key" });
    const sentFile = api.calls[0]!.form!.get("file") as File;
    expect(sentFile.name).toBe("receipt.pdf");
    expect(sentFile.type).toBe("application/pdf");
    expect(new TextDecoder().decode(await sentFile.arrayBuffer())).toBe("%PDF-1.4\n");
  });

  it("fails without relaying the vendor's words", async () => {
    const api = fakeApi(413);
    await expect(uploadToSession(ENV, "sess-1", file, api.fetcher)).rejects.toThrow(/^browserbase 413$/);
  });
});

describe("setFileInput", () => {
  it("has the browser set its copy of the file on the box", async () => {
    const { send, sent } = fakeSend();
    expect(await setFileInput(send, '[data-tex-file-box="abc12345"]', ["/tmp/.uploads/receipt.pdf"], null)).toBe(true);
    expect(sent).toEqual([
      { method: "Runtime.evaluate", params: { expression: `document.querySelector("[data-tex-file-box=\\"abc12345\\"]")` } },
      { method: "DOM.setFileInputFiles", params: { files: ["/tmp/.uploads/receipt.pdf"], objectId: "box-1" } },
    ]);
  });

  it("finds the box in a same-site frame's own world", async () => {
    const { send, sent } = fakeSend();
    await setFileInput(send, '[data-tex-file-box="abc12345"]', ["/tmp/.uploads/receipt.pdf"], 7);
    expect(sent[0]!.params).toMatchObject({ contextId: 7 });
  });

  it("sets nothing when the box is gone", async () => {
    const { send, sent } = fakeSend({ present: false });
    expect(await setFileInput(send, '[data-tex-file-box="abc12345"]', ["/tmp/.uploads/receipt.pdf"], null)).toBe(false);
    expect(sent.some((s) => s.method === "DOM.setFileInputFiles")).toBe(false);
  });
});

describe("browserbaseUploads", () => {
  it("stages the file in the session, and logs how a file went in but never its name", async () => {
    const api = fakeApi();
    const uploads = browserbaseUploads(ENV, "sess-1", api.fetcher);
    expect(await uploads.stage(file)).toBe("/tmp/.uploads/receipt.pdf");
    const logged: string[] = [];
    const log = console.log;
    console.log = (line: string) => logged.push(line);
    try {
      uploads.said("browser");
    } finally {
      console.log = log;
    }
    expect(logged).toEqual([JSON.stringify({ event: "site_shots_upload", via: "browser" })]);
  });
});
