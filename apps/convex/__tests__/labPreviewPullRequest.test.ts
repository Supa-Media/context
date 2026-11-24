import { describe, expect, it } from "vitest";
import { previewPullRequest } from "../functions/lib/labPreviewPullRequest";

const answering = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

describe("a Lab test chat's pull request", () => {
  it("an open pull request has a preview to start", async () => {
    expect(await previewPullRequest(4071, "token-example", answering(200, { state: "open", merged_at: null }))).toEqual({ open: true });
  });

  it("a merged or closed pull request is refused with why, since its preview was deleted", async () => {
    const merged = await previewPullRequest(4076, "token-example", answering(200, { state: "closed", merged_at: "2026-11-24T07:00:00Z" }));
    expect(merged).toEqual({ open: false, why: expect.stringContaining("merged, so its preview is gone") });
    const closed = await previewPullRequest(4076, "token-example", answering(200, { state: "closed", merged_at: null }));
    expect(closed).toEqual({ open: false, why: expect.stringContaining("closed, so its preview is gone") });
    expect(await previewPullRequest(9_999_999, "token-example", answering(404, { message: "Not Found" }))).toEqual({ open: false, why: "there is no such pull request" });
  });

  it("when GitHub can't be asked, nothing is refused and the run starts as before", async () => {
    expect(await previewPullRequest(4071, undefined, answering(200, { state: "closed" }))).toBeNull();
    expect(await previewPullRequest(4071, "token-example", answering(500, {}))).toBeNull();
    expect(await previewPullRequest(4071, "token-example", (async () => { throw new Error("offline"); }) as unknown as typeof fetch)).toBeNull();
  });
});
