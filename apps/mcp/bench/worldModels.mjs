/**
 * The models and stand-ins a benchmark world runs on (`world.mjs`): a scripted model with `--fake`, else Claude
 * through `claudeTransport` with production's extras. Shared by the conversation runs (`run.mjs`) and the job tasks
 * (`jobTasks.mjs`), so both measure the same product.
 */
import { anthropicGateway, cachedEmbeddings, claudeTransport, fakeAi, fakeGateway, workersAi } from "./models.mjs";

export function benchModels(options, { scripted = false, sites = [], send = claudeTransport(process.env) } = {}) {
  const models = options.fake
    ? { gatewayFetch: fakeGateway(), ai: cachedEmbeddings(fakeAi()) }
    : {
        gatewayFetch: anthropicGateway(send),
        // Embeds too (`@cf/baai/bge-m3`), remembered by text so each passage
        // and each query is paid for once a run.
        ai: cachedEmbeddings(workersAi(process.env.CLOUDFLARE_ACCOUNT_ID, process.env.CLOUDFLARE_AI_TOKEN, process.env.AI_GATEWAY_ID ?? null)),
        searchKey: process.env.BRAVE_SEARCH_API_KEY,
        // Production reads answers for work handed back (wrangler.toml HANDBACK_JUDGE), so a real run does too.
        handbackJudge: true,
        // The Worker names the texts a turn covers, so production reads the chat's ledger and sorts the text into a thread (`loggedTurn.js`, `conversationThreads.js`); a real run does too. A scripted model leaves it off, since it would answer the thread sorter's call too.
        ledgerTurns: true,
      };
  if (scripted) {
    models.sites = sites;
    delete models.searchKey;
  }
  return models;
}
