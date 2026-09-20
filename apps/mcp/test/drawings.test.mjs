/**
 * A DRAWING IS A NOTE THE GATEWAY READS DIFFERENTLY AND WRITES NOT AT ALL.
 *
 * `packages/drawings/test` proves the parse. This proves the four places the
 * gateway had to change around it, wired end to end through the worker, because
 * each one is a behaviour of a *tool call* and none of them can be seen from
 * the pure layer:
 *
 *  1. **`read_note` describes a drawing instead of returning it.** The payload
 *     never reaches the caller, and the reply says `kind: drawing` so a client
 *     knows what it is holding.
 *  2. **`write_note` refuses to replace one with text.** This is the guard the
 *     first behaviour makes necessary: a client that reads a note, edits a line
 *     and writes it back would otherwise destroy the only copy of somebody's
 *     diagram. It is the check this file exists for.
 *  3. **Search indexes the labels, not the base64.** Both the indexed path and
 *     the fallback scan, because they are separate implementations of "does
 *     this note match" and the scan is the one that reads live bytes.
 *  4. **A note that embeds a drawing says so.** `![[x.excalidraw]]` is an image
 *     to Obsidian and four words to everything else.
 *
 * Visibility is asserted alongside, not as an afterthought: a drawing is a note
 * and `canSee` decides it, so a private drawing must be as invisible as a
 * private note — including its description, which would otherwise be a
 * paraphrase of a private file leaking past the rule that covers the file.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted. Counts are FAIL lines across the
 * whole gateway suite.
 *
 *   the `isDrawingPath` branch removed from `toolReadNote`                   9
 *   the `isDrawingPath` guard removed from `toolWriteNote`                   5
 *   the write guard accepting content with no payload                        5
 *   the drawing branch removed from `extractFields`                          3
 *   `drawingEmbedLine` returning ""                                          3
 *   the embed line appended to the body instead of the header                2
 *   `drawingEmbedLine` ignoring the `!` that makes a link an embed           1
 *
 * The second row is a bug this diff shipped and self-review caught. The embed
 * line was first *appended to the note body*, where it reads as note content —
 * so a client that read a note, edited a line and wrote it back would have
 * written "Embedded drawings (read one…)" into the customer's file. That is the
 * data-loss the drawing guard three checks above exists to stop, reintroduced
 * by the feature meant to be safe. It now goes in the header block, beside
 * `etag` and `visibility`, and the check that holds it there asserts the body
 * is byte-identical to the file rather than merely that it "looks right".
 *
 * The `drawingEmbedLine` ignoring the `!` row started at **zero**, and the reason is worth keeping. The host
 * note embedded one drawing and mentioned none, so a footer that listed every
 * link to a drawing — embedded or merely referenced — produced exactly the same
 * output as one that read the marker. The code span in the fixture did not
 * help: `parseLinks` masks code before this ever sees it, so that line was
 * testing `codeRanges`, not this. The note now also *links* to a second drawing
 * without embedding it, which is the only content that can tell the two apart.
 *
 * The fourth row is thin at three, and honestly so. A query for a label still
 * hits without the branch, because the plugin writes every label into the
 * Markdown half as plain text and the fallback scan matches raw bytes. What the
 * branch prevents is base64 becoming *terms* — a property of the index rather
 * than of any one answer — so it is asserted directly against `extractFields`
 * rather than through a query that would pass either way.
 */

import worker from "../src/index.js";
import { compressToBase64 } from "../../../packages/drawings/src/lzstring.js";
import { extractFields } from "../src/search/indexer.js";
import { CONTROL_PLANE_ORIGIN, GATEWAY_SECRET, createControlPlaneStub } from "./controlPlaneStub.mjs";
import { createWorkerCtx } from "./workerCtx.mjs";

const OWNER_TOKEN = `cat_draw_owner_${"0".repeat(16)}`;
const TEAM_TOKEN = `cat_draw_team_${"0".repeat(17)}`;

const MANIFEST =
  "---\nrole: privacy-manifest\nversion: 1\n---\n\n" +
  "<!-- BEGIN BRAIN PRIVACY RULES -->\n\n```yaml\ndefault_visibility: private\n\n" +
  "folder_defaults:\n  index.md: team\n  1-projects: team\n  2-areas: private\n```\n\n" +
  "<!-- END BRAIN PRIVACY RULES -->\n";

/** A drawing the way the plugin writes one, payload and all. */
function drawingFile(elements, { name = "plan" } = {}) {
  const scene = { type: "excalidraw", version: 2, source: "https://excalidraw.com", elements };
  const payload = compressToBase64(JSON.stringify(scene));
  const labels = elements
    .filter((element) => element.type === "text")
    .map((element) => `${element.text} ^${element.id}`)
    .join("\n\n");
  return [
    "---",
    "excalidraw-plugin: parsed",
    "tags: [excalidraw]",
    "---",
    "",
    "# Excalidraw Data",
    "",
    "## Text Elements",
    labels,
    "",
    "%%",
    "## Drawing",
    "```compressed-json",
    payload.match(/.{1,64}/g).join("\n"),
    "```",
    "%%",
    "",
  ].join("\n");
}

const ELEMENTS = [
  { id: "boxA", type: "rectangle", x: 0, y: 0, width: 160, height: 80, strokeColor: "#1e1e1e", backgroundColor: "#d0e2ff", strokeWidth: 2, opacity: 100 },
  { id: "labelA", type: "text", x: 10, y: 30, width: 140, height: 25, text: "Cassowary", fontSize: 20, containerId: "boxA" },
  { id: "boxB", type: "rectangle", x: 320, y: 0, width: 160, height: 80, strokeColor: "#1e1e1e", strokeWidth: 2, opacity: 100 },
  { id: "labelB", type: "text", x: 330, y: 30, width: 140, height: 25, text: "Quoll", fontSize: 20, containerId: "boxB" },
  { id: "arrow1", type: "arrow", x: 160, y: 40, width: 160, height: 0, points: [[0, 0], [160, 0]], strokeColor: "#1e1e1e", strokeWidth: 2, opacity: 100, startBinding: { elementId: "boxA" }, endBinding: { elementId: "boxB" } },
];

const PRIVATE_ELEMENTS = [
  { id: "p1", type: "text", x: 0, y: 0, width: 200, height: 25, text: "Numbat", fontSize: 20 },
];

function createBucket() {
  const objects = new Map();
  let etags = 0;
  return {
    seed(key, body) {
      objects.set(key, { body, etag: `e${++etags}`, uploaded: new Date() });
    },
    text(key) {
      return objects.get(key)?.body;
    },
    async get(key) {
      const stored = objects.get(key);
      if (!stored) return null;
      return {
        etag: stored.etag,
        text: async () => stored.body,
        arrayBuffer: async () => new TextEncoder().encode(stored.body).buffer,
      };
    },
    async put(key, value, options = {}) {
      const expected = options?.onlyIf?.etagMatches;
      if (expected && objects.get(key)?.etag !== expected) return null;
      if (options?.onlyIf?.absent && objects.has(key)) return null;
      const body = typeof value === "string" ? value : new TextDecoder().decode(value);
      objects.set(key, { body, etag: `e${++etags}`, uploaded: new Date() });
      return { etag: `e${etags}` };
    },
    async delete(key) {
      objects.delete(key);
      return {};
    },
    async list({ prefix } = {}) {
      return {
        objects: [...objects.keys()]
          .filter((key) => !prefix || key.startsWith(prefix))
          .sort()
          .map((key) => ({
            key,
            size: objects.get(key).body.length,
            uploaded: objects.get(key).uploaded,
            etag: objects.get(key).etag,
          })),
        truncated: false,
      };
    },
  };
}

async function callTool(env, token, name, args) {
  const { ctx, settle } = createWorkerCtx();
  const response = await worker.fetch(
    new Request("https://mcp.context.test/mcp", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    }),
    env,
    ctx
  );
  const body = await response.json();
  await settle();
  return body?.result?.content?.[0]?.text ?? "";
}

export async function runDrawingChecks(check) {
  const controlPlane = createControlPlaneStub();
  const restore = controlPlane.install();
  try {
    const bucket = createBucket();
    controlPlane.addWorkspace("ws_draw", "draw", {
      provider: "r2-binding",
      bindingName: "DRAW_BUCKET",
      capabilities: { conditionalWrite: true, conditionalCreate: true, conditionalDelete: true },
      status: "active",
    });
    await controlPlane.addGrant({
      accessToken: OWNER_TOKEN,
      workspaceId: "ws_draw",
      role: "owner",
      scopes: ["context:read", "context:write", "context:private"],
      clientId: "mcp_client_draw_owner",
      userId: "user_draw_owner",
    });
    await controlPlane.addGrant({
      accessToken: TEAM_TOKEN,
      workspaceId: "ws_draw",
      role: "editor",
      scopes: ["context:read", "context:write"],
      clientId: "mcp_client_draw_team",
      userId: "user_draw_team",
    });

    const env = {
      CONTROL_PLANE_URL: CONTROL_PLANE_ORIGIN,
      GATEWAY_SECRET,
      NATIVE_BINDINGS: "DRAW_BUCKET",
      DRAW_BUCKET: bucket,
    };

    const DRAWING = "1-projects/plan.excalidraw.md";
    const BIG_DRAWING = "1-projects/big.excalidraw.md";
    const PRIVATE_DRAWING = "2-areas/secret.excalidraw.md";
    const source = drawingFile(ELEMENTS);

    bucket.seed("privacy.md", MANIFEST);
    bucket.seed("index.md", "# front page");
    bucket.seed(DRAWING, source);
    bucket.seed(PRIVATE_DRAWING, drawingFile(PRIVATE_ELEMENTS, { name: "secret" }));
    // 120 unlabelled boxes: the shape where a payload dwarfs anything sayable
    // about it, which is every diagram past a sketch.
    bucket.seed(
      BIG_DRAWING,
      drawingFile(
        Array.from({ length: 120 }, (_, index) => ({
          id: `e${index}`,
          type: "rectangle",
          x: (index % 12) * 120,
          y: Math.floor(index / 12) * 90,
          width: 100,
          height: 70,
          strokeColor: "#1e1e1e",
          backgroundColor: "#d0e2ff",
          strokeWidth: 2,
          opacity: 100,
          seed: 1000 + index,
        })),
        { name: "big" }
      )
    );
    bucket.seed(
      "1-projects/read-path.md",
      "# The read path\n\nHow it works.\n\n![[plan.excalidraw]]\n\n" +
        // A plain link to a *different* drawing: mentioned, not embedded. It is
        // the only thing in this note that tells an embed from a reference, and
        // without it a footer that ignored the `!` would pass every check here.
        "Compare it with [[big.excalidraw]], which is not shown here.\n\n" +
        "And `![[not-a-real.excalidraw]]` in a code span.\n"
    );

    /* -- (1) read_note describes rather than dumps -------------------------- */

    const read = await callTool(env, OWNER_TOKEN, "read_note", { path: DRAWING });

    check("a drawing is announced as one", read.includes("kind: drawing"));
    check("its labels come back", read.includes("Cassowary") && read.includes("Quoll"));
    check("its connections come back", read.includes("Cassowary → Quoll"));
    check("its inventory comes back", read.includes("2 rectangles"));
    check("the etag is still the file's", /\netag: e\d+\n/.test(`\n${read}`));

    const payloadHead = compressToBase64(
      JSON.stringify({ type: "excalidraw", version: 2, source: "https://excalidraw.com", elements: ELEMENTS })
    ).slice(0, 32);
    check("the compressed payload never reaches the caller", !read.includes(payloadHead));
    check("nor does the fence that carries it", !read.includes("compressed-json"));
    check("the reply is smaller than the file it describes", read.length < source.length);
    /*
      The ratio claim belongs on a real drawing, not on a five-element fixture.
      A description grows with the *labels*; a payload grows with every element,
      binding and point — so the saving is small on a toy and is the whole point
      on anything somebody actually drew. Asserting it on the fixture above
      would have been a check that passes for the wrong reason.
    */
    const bigRead = await callTool(env, OWNER_TOKEN, "read_note", { path: BIG_DRAWING });
    const bigSource = bucket.text(BIG_DRAWING);
    check(
      "on a real-sized drawing the reply is a small fraction of the file",
      bigRead.length < bigSource.length / 8
    );
    check("and it still describes what is in it", bigRead.includes("120 rectangles"));
    check(
      "and it says the file itself is untouched",
      read.includes("unchanged in the bucket")
    );

    /* -- (2) a drawing is still a note, and canSee still decides ------------ */

    const teamPrivate = await callTool(env, TEAM_TOKEN, "read_note", { path: PRIVATE_DRAWING });
    check(
      "a private drawing is not readable by a team connection",
      !teamPrivate.includes("Numbat") && teamPrivate.includes("not found")
    );
    const teamVisible = await callTool(env, TEAM_TOKEN, "read_note", { path: DRAWING });
    check("a team-visible drawing is described for a team connection", teamVisible.includes("Cassowary"));

    /* -- (3) the guard: a drawing is never overwritten with text ------------ */

    const echoed = await callTool(env, OWNER_TOKEN, "write_note", {
      path: DRAWING,
      content: read.slice(read.indexOf("# plan")),
    });
    check("writing the description back is refused", echoed.includes("carries no drawing payload"));
    check("the refusal says what to do instead", echoed.includes("Excalidraw or Obsidian"));
    check("and the file is untouched", bucket.text(DRAWING) === source);

    const prose = await callTool(env, OWNER_TOKEN, "write_note", {
      path: DRAWING,
      content: "# plan\n\nJust some notes about the diagram.\n",
    });
    check("so is plain prose at a drawing's path", prose.includes("carries no drawing payload"));
    check("the drawing survives that too", bucket.text(DRAWING) === source);

    const replacement = drawingFile([
      ...ELEMENTS,
      { id: "labelC", type: "text", x: 0, y: 200, width: 200, height: 25, text: "Bilby", fontSize: 20 },
    ]);
    const realWrite = await callTool(env, OWNER_TOKEN, "write_note", {
      path: DRAWING,
      content: replacement,
    });
    check("a real drawing may still be written", !realWrite.includes("carries no drawing payload"));
    check("and it lands", bucket.text(DRAWING).includes("Bilby"));
    bucket.seed(DRAWING, source);

    /* -- (4) a note that embeds a drawing says so --------------------------- */

    const host = await callTool(env, OWNER_TOKEN, "read_note", { path: "1-projects/read-path.md" });
    const header = host.slice(0, host.indexOf("\n\n"));
    const body = host.slice(host.indexOf("\n\n") + 2);

    check("an embedded drawing is named", host.includes("embedded drawings:"));
    check("with the path to read", host.includes("plan.excalidraw.md"));
    /*
      IN THE HEADER, NOT THE BODY, and this is the check for it. Appended to the
      body it reads as note content, so a client that reads a note, edits a line
      and writes it back would have written this sentence into the customer's
      file — the same data-loss the drawing guard above exists to stop, arriving
      through the feature meant to be safe. Found by reading the diff.
    */
    check("the embed line is header metadata, not note content", header.includes("embedded drawings:"));
    check("and the body is byte-identical to the file", body === bucket.text("1-projects/read-path.md"));
    check("the note's own text is untouched", body.includes("How it works."));
    check(
      "an embed inside a code span is not followed",
      !host.includes("not-a-real.excalidraw.md")
    );
    check(
      "a drawing that is linked but not embedded is not listed as embedded",
      !header.includes("big.excalidraw.md")
    );

    const plain = await callTool(env, OWNER_TOKEN, "read_note", { path: "index.md" });
    check("a note with no embeds gets no such line", !plain.includes("embedded drawings:"));
    check(
      "and its body is byte-identical too",
      plain.slice(plain.indexOf("\n\n") + 2) === bucket.text("index.md")
    );

    /* -- (5) search indexes the labels, not the base64 ---------------------- */

    const fields = extractFields(DRAWING, source);
    check("a drawing's indexed title is its name", fields.title === "plan");
    check("its labels are indexed", fields.body.includes("Cassowary"));
    check(
      "its payload is not",
      !fields.body.includes(payloadHead) && !fields.body.includes("compressed-json")
    );
    check(
      "the indexed text is a fraction of the file",
      fields.body.length < source.length / 4
    );

    const found = await callTool(env, OWNER_TOKEN, "search_notes", { query: "Cassowary" });
    check("and a label is findable", found.includes("plan.excalidraw.md"));

    const privateSearch = await callTool(env, TEAM_TOKEN, "search_notes", { query: "Numbat" });
    check(
      "a private drawing's labels are not findable by a team connection",
      !privateSearch.includes("secret.excalidraw.md")
    );
  } finally {
    restore();
  }
}
