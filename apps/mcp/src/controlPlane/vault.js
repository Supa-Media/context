/**
 * Vault links: a page where the person saves or shares a login themselves.
 * The control plane mints the request and builds the URL; this answers it,
 * or `null` for anything it refused.
 */

export function createVaultMethods({ post, required }) {
  return {
    /**
     * `request` is `{kind: "add", type?, name?, site?, fields?, perEnv?}`,
     * `{kind: "share", entryId, handle}` or `{kind: "view", entryId, env?}`.
     * Everything an agent suggests for the form is put on the URL as a
     * prefill, never sent to the control plane: it holds no part of an entry.
     */
    async vaultRequest(accessToken, expectedWorkspaceId, request) {
      const { name, site, type, fields, perEnv, env, ...rest } = request ?? {};
      const parsed = await post("/gateway/vault/request", { accessToken, expectedWorkspaceId, ...rest });
      const url = required(parsed, "url");
      if (typeof url !== "string" || !/^https?:\/\//.test(url)) return null;
      const built = new URL(url);
      if (type === "secret" || type === "card") built.searchParams.set("type", type);
      if (typeof name === "string" && name) built.searchParams.set("name", name);
      if (typeof site === "string" && site) built.searchParams.set("site", site);
      if (Array.isArray(fields) && fields.length > 0) built.searchParams.set("fields", fields.join(","));
      if (typeof perEnv === "boolean") built.searchParams.set("envs", perEnv ? "1" : "0");
      if (typeof env === "string" && env) built.searchParams.set("env", env);
      return { url: built.toString() };
    },
    /**
     * Tex's saved Browserbase profile for one browser (`agent/browserProfile.js`):
     * `{ profileId, created }`, or `{ profileId: null }` when it has none and
     * none can be made. With `forget`, "sign Tex out": `{ forgotten }`.
     */
    async browserProfile(accessToken, expectedWorkspaceId, { owner, chat = null, forget = false }) {
      return await post("/gateway/browser-profile", {
        accessToken,
        expectedWorkspaceId,
        owner,
        ...(chat !== null ? { chat } : {}),
        ...(forget ? { forget: true } : {}),
      });
    },
  };
}
