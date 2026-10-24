/**
 * A LOGIN SAVED ON THE PAGE TEX TEXTED CARRIES ON THE TASK BY ITSELF.
 *
 * Dev2, 2026-10-24, ordering Instacart groceries by text: Tex sent the
 * private link to save the login, Dev2 saved it, and nothing happened until
 * they texted "done" ("after adding the email and password Tex should know
 * that i'm done adding"). So a turn that minted a link to save something says
 * so in its answer (`vaultWatch`), the texting Worker watches the control
 * plane for that save (`apps/agent/src/vaultWatch.ts`), and once it lands it
 * asks for a turn with `event: "vault_saved"` and no text of theirs.
 *
 * That turn's question is this module's fixed line, never anything the
 * Worker sends: the body only names the event, and only the texting client's
 * own 1:1 turn may name it. The line is ours, marked as not a text from them,
 * and asks for nothing that reaches anyone else.
 */

export const VAULT_SAVED_QUESTION =
  "(Not a text from them. Context sent this by itself: they just saved what you asked for on the private vault page you texted them, so it's in their vault now. " +
  "Carry on with the task you needed it for straight away, using it (check fetch vault: for its id); don't ask whether they saved it or wait for them to text. " +
  "Text them what you did or found, as you would have once they said it was saved.)";

/** The question for a turn the body names as the vault event, or null for any other turn. */
export function vaultSavedQuestion(body, { texting, job }) {
  if (!texting || job !== null) return null;
  return body?.event === "vault_saved" ? VAULT_SAVED_QUESTION : null;
}

/**
 * Marks the turn's ledger (`vaultLink`) when it minted a link to save
 * something, so its answer can ask the Worker to watch for the save. A flag
 * only: the link itself stays in the answer the model wrote.
 */
export function withVaultWatch(ledger, callTool) {
  return async (name, args) => {
    const result = await callTool(name, args);
    if (name === "vault_add_link" && result?.isError !== true) ledger.vaultLink = true;
    return result;
  };
}
