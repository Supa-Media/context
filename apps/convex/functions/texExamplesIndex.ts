/**
 * Filling Tex's example index: the Vectorize index the front door searches for
 * the Training moments closest to the text it is answering (`tex-examples`).
 *
 * The index is Tex's own, not a workspace's: its name never takes the
 * `context-meaning-` prefix, so the meaning census and cleanup, which act only
 * on workspace rows and that prefix, never touch it. Only Training moments go
 * in, and the vector id is `<chat>#<at>`. Nothing about a customer is read
 * here; the moments come from the generated Training file in the repository.
 *
 * What is searched, and whether a text may see a moment from its own chat, is
 * decided in the gateway (`packages/tex/gateway/agent/graph/nodes/examples.js`), so a
 * stale or extra id left here is dropped at query time and needs no delete.
 *
 * The same credential as meaning search (`SEARCH_D1_API_TOKEN`,
 * `SEARCH_D1_ACCOUNT_ID`). Absent, the sync records "not configured" and
 * stops; the front door then answers from its fixed examples as it does today.
 *
 * Logs carry the status and a count, never a vector, a passage or Cloudflare's
 * own words.
 */

import { internal } from "../_generated/api";
import { internalAction, type ActionCtx } from "../_generated/server";
import { TEX_EXAMPLES_INDEX, indexEntries } from "@context/tex/src/texExamples.cjs";
import GENERATED from "../../../packages/tex/src/texTraining.generated.json";
import { createMeaningClient } from "../../mcp/src/search/meaning/client.js";
import { createRestEmbedder } from "../../mcp/src/search/meaning/embed.js";
import { D1_ACCOUNT_SECRET, D1_TOKEN_SECRET } from "./lib/d1";
import { isIsolatedPreview } from "./lib/previewDeployment";
import { ensureMeaningIndex, type MeaningConfig } from "./lib/vectorize";

const EXAMPLES_INDEX_DESCRIPTION = "Context: Tex's example moments for the front door";

export type ExamplesSyncResult =
  | { status: "not configured" }
  | { status: "refused on a preview" }
  | { status: "synced"; count: number }
  | { status: "failed"; code: string };

/** Both halves of the credential, or `null`. Same shape as `meaningProvision.ts`'s `configFor`. */
async function configFor(ctx: ActionCtx): Promise<MeaningConfig | null> {
  const apiToken = await ctx.runAction(internal.functions.admin.readIntegrationSecret, {
    name: D1_TOKEN_SECRET,
  });
  const accountId = await ctx.runAction(internal.functions.admin.readIntegrationSecret, {
    name: D1_ACCOUNT_SECRET,
  });
  if (
    typeof apiToken !== "string" ||
    apiToken.length === 0 ||
    typeof accountId !== "string" ||
    accountId.length === 0
  ) {
    return null;
  }
  return { accountId, apiToken };
}

/**
 * The sync's work with its credential given: the index created or adopted,
 * every Training moment embedded and upserted under its `<chat>#<at>` id.
 *
 * Exported so the guard test can drive it with a fake `fetch`. A provider
 * failure comes back as its code only: its text can name the account or the
 * index, so it is never returned or logged.
 */
export async function syncTexExamples(
  config: MeaningConfig,
  generated: unknown = GENERATED,
): Promise<ExamplesSyncResult> {
  // A per-branch preview shares this account with production, and this index
  // is one name in it, not prefixed. Refuse before any request is made, so a
  // preview can never create or write the index production answers from.
  if (isIsolatedPreview()) return { status: "refused on a preview" };
  const entries = indexEntries(generated);
  const embedder = createRestEmbedder({
    accountId: config.accountId,
    apiToken: config.apiToken,
    fetchImpl: config.fetchImpl,
  });
  if (!embedder) return { status: "not configured" };
  try {
    await ensureMeaningIndex(config, TEX_EXAMPLES_INDEX, EXAMPLES_INDEX_DESCRIPTION);
    const vectors = await embedder(entries.map((entry) => entry.text));
    const client = createMeaningClient(
      { indexName: TEX_EXAMPLES_INDEX, accountId: config.accountId, apiToken: config.apiToken },
      { fetchImpl: config.fetchImpl },
    );
    const count = await client.upsert(
      entries.map((entry, i) => ({ id: entry.id, values: vectors[i], metadata: {} })),
    );
    return { status: "synced", count };
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    return { status: "failed", code: typeof code === "string" ? code : "UNKNOWN" };
  }
}

/** Run by `.github/workflows/deploy-convex.yml` after each deploy. Reached by no client. */
export const sync = internalAction({
  args: {},
  handler: async (ctx): Promise<ExamplesSyncResult> => {
    const config = await configFor(ctx);
    const result: ExamplesSyncResult = config === null ? { status: "not configured" } : await syncTexExamples(config);
    console.log(
      result.status === "synced"
        ? `tex examples index: synced ${result.count}`
        : result.status === "failed"
          ? `tex examples index: failed (${result.code})`
          : `tex examples index: ${result.status}`,
    );
    return result;
  },
});
