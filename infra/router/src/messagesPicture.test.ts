/**
 * A drawn card's picture, for the page its Context card opens
 * (`messagesPicture.ts`): read from the texting Worker with the card's key,
 * only an image passed on, and the same 404 for every miss.
 *
 * Sabotage record (applied, suite run, named check observed failing, reverted):
 *   `pictureResponse` fetching with a key it did not check → "a malformed key asks the Worker nothing" fails.
 *   `pictureResponse` passing any content type → "passes on only an image" fails.
 */

import { describe, expect, it } from "vitest";

import { pictureResponse } from "./messagesPicture";

const OBJECT = "a".repeat(64);
const TOKEN = "b".repeat(64);

function texts(answer: Response | (() => never), seen: string[] = []): { TEXTS: Fetcher } {
  return {
    TEXTS: {
      fetch: async (input: RequestInfo | URL) => {
        seen.push(String(input));
        if (typeof answer === "function") answer();
        return (answer as Response).clone();
      },
    } as unknown as Fetcher,
  };
}

async function get(query: string, env: { TEXTS?: Fetcher }, method = "GET"): Promise<Response> {
  const url = new URL(`https://context.lc/messages/picture${query}`);
  return (await pictureResponse(new Request(url, { method }), url, env))!;
}

const png = () => new Response("png-bytes", { headers: { "content-type": "image/png" } });

describe("a drawn card's picture", () => {
  it("is the Worker's kept picture, by the card's key, served as an image and nothing more", async () => {
    const seen: string[] = [];
    const response = await get(`?p=${OBJECT}.${TOKEN}.png`, texts(png(), seen));
    expect(seen).toEqual([`https://texts/media/${OBJECT}/${TOKEN}.png`]);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("png-bytes");
    expect(response.headers.get("Content-Type")).toBe("image/png");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("Cache-Control")).toContain("private");
  });

  it("passes on only an image", async () => {
    for (const type of ["text/html", "text/vcard", "image/svg+xml", ""]) {
      const answer = new Response("<script>x</script>", { headers: { "content-type": type } });
      expect((await get(`?p=${OBJECT}.${TOKEN}.png`, texts(answer))).status).toBe(404);
    }
  });

  it("a malformed key asks the Worker nothing; a refused, broken or missing Worker is the same 404", async () => {
    const seen: string[] = [];
    for (const query of ["", "?p=nope", `?p=${OBJECT}.${TOKEN}`, `?p=${OBJECT}.${TOKEN}.svg`, `?p=${OBJECT}.${TOKEN}.vcf`, `?p=../${OBJECT}.${TOKEN}.png`, `?p=${OBJECT.toUpperCase()}.${TOKEN}.png`]) {
      expect((await get(query, texts(png(), seen))).status).toBe(404);
    }
    expect(seen).toEqual([]);
    for (const env of [texts(new Response(null, { status: 404 })), texts(() => { throw new Error("down"); }), {}]) {
      expect((await get(`?p=${OBJECT}.${TOKEN}.png`, env)).status).toBe(404);
    }
  });

  it("is only this path, and only GET", async () => {
    const url = new URL("https://context.lc/messages/card");
    expect(await pictureResponse(new Request(url), url, {})).toBeNull();
    expect((await get(`?p=${OBJECT}.${TOKEN}.png`, {}, "POST")).status).toBe(405);
  });
});
