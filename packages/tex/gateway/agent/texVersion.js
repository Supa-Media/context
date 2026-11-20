/**
 * WHICH TEX ANSWERED A TURN (Dev2, 2026-11-13: "we have to log which version of tex a message is going through in the
 * history ledger"), kept on the turn's `reply` entry as `version` so the Tex Architecture Lab can replay an old text
 * and say what it ran on then.
 *
 * Two things make a version, and both are named:
 * - `code`: the commit the gateway was deployed from. The deploy workflows pass it as the `TEX_CODE_VERSION` var
 *   (`wrangler deploy --var`); a self-hosted deploy that sets nothing has none. `deploy` is Cloudflare's own id for
 *   the uploaded Worker version (the `CF_VERSION_METADATA` binding), which tells two deploys of one commit apart.
 * - `setup`: the live setup's version (`production.js` `versionOf`, a hash over `ai/production/texting-assistant.md`
 *   and its prompt modules), because the words Tex runs on change outside a pull request, in Context.
 *
 * Every value is shape-checked and cut, never a word of the chat. A turn's own reads never carry it
 * (`texStore/ledger.js` slim), so it changes no prompt.
 */

const COMMIT = /^[0-9a-f]{7,40}$/i;
const WORKER_VERSION = /^[0-9a-f-]{8,64}$/i;
const SETUP_VERSION = /^[0-9a-f]{6,64}$/i;

/** `{code?, deploy?, setup?}` for this turn, or null when nothing is known. */
export function texVersion(env, production) {
  const code = typeof env?.TEX_CODE_VERSION === "string" && COMMIT.test(env.TEX_CODE_VERSION.trim()) ? env.TEX_CODE_VERSION.trim().slice(0, 12).toLowerCase() : null;
  const id = env?.CF_VERSION_METADATA?.id;
  const deploy = typeof id === "string" && WORKER_VERSION.test(id) ? id.toLowerCase() : null;
  const raw = production?.version;
  const setup = typeof raw === "string" && SETUP_VERSION.test(raw) ? raw.toLowerCase() : null;
  if (code === null && deploy === null && setup === null) return null;
  return { ...(code ? { code } : {}), ...(deploy ? { deploy } : {}), ...(setup ? { setup } : {}) };
}
