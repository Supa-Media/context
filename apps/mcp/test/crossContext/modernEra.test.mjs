/**
 * The same answers in the modern protocol era, and the addressing argument
 * stripped before a tool sees its arguments (read off the module that does it).
 *
 * Split out of crossContext.test.mjs; see fixtures.mjs for the shared harness.
 */

import {
  createWorkerCtx,
  gatewaySourceFiles,
  soleSource,
  TOKEN_OWNER,
  worker,
} from "./fixtures.mjs";

/** @param {(label: string, ok: boolean) => void} check */
export async function runCrossContextModernEraChecks(check, harness) {
  const { theirs, env } = harness;
  /* --------------------- the same answer in the modern era ----------------- */

  /*
    Authority is decided once, never per protocol era, and cross-context reach
    is authority. Both eras call `callToolForSession`, so this is one assertion
    rather than a second suite — but it is the assertion that says so, and the
    era that added a header would otherwise be the era that routes differently.
  */
  const { ctx: modernCtx, settle: settleModern } = createWorkerCtx();
  const modern = await worker.fetch(
    new Request("https://mcp.context.test/mcp", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TOKEN_OWNER}`,
        "Content-Type": "application/json",
        "MCP-Protocol-Version": "2026-07-28",
        "Mcp-Method": "tools/call",
        "Mcp-Name": "read_note",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 7,
        method: "tools/call",
        params: {
          name: "read_note",
          arguments: { path: "1-projects/shared-name.md", context: "@theirs" },
          _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" },
        },
      }),
    }),
    env,
    modernCtx
  );
  const modernText = JSON.parse(await modern.text())?.result?.content?.[0]?.text || "";
  await settleModern();
  check("a modern-era call addresses the same context the legacy one does", modernText.includes("THEIRS-MARKER"));
  check(
    "and a modern-era write is refused by the same role clamp",
    /permission denied/i.test(
      (
        await (async () => {
          const { ctx: c, settle: s } = createWorkerCtx();
          const response = await worker.fetch(
            new Request("https://mcp.context.test/mcp", {
              method: "POST",
              headers: {
                Authorization: `Bearer ${TOKEN_OWNER}`,
                "Content-Type": "application/json",
                "MCP-Protocol-Version": "2026-07-28",
                "Mcp-Method": "tools/call",
                "Mcp-Name": "write_note",
              },
              body: JSON.stringify({
                jsonrpc: "2.0",
                id: 8,
                method: "tools/call",
                params: {
                  name: "write_note",
                  arguments: {
                    path: "1-projects/modern-intruder.md",
                    content: "should never be written",
                    context: "@theirs",
                  },
                  _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" },
                },
              }),
            }),
            env,
            c
          );
          const text = JSON.parse(await response.text())?.result?.content?.[0]?.text || "";
          await s();
          return text;
        })()
      )
    ) && !theirs.has("1-projects/modern-intruder.md")
  );

  /* ---------------------- the argument is not a tool input ----------------- */

  // `context` addresses the call and is never an input. No tool reads it today,
  // so no behaviour changes if it leaks through — which is exactly why this is
  // asserted where it is decided. Read off disk rather than fetched: `fetch` is
  // the stub's, and a suite that asks its own fixtures about the source is
  // asking the wrong thing. Named by the module that decides it, and it must be
  // the only module under `src/` that does (`gatewaySource.mjs`).
  check(
    "the addressing argument is stripped before the tool sees the arguments",
    soleSource(gatewaySourceFiles(), /delete args\.context;/, "tools/session.js").ok
  );
}
