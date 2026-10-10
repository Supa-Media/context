/**
 * Vault links: a page where the person saves or shares a login themselves.
 * The control plane mints the request and builds the URL; this answers it,
 * or `null` for anything it refused.
 */

export function createVaultMethods({ post, required }) {
  return {
    /**
     * `request` is `{kind: "add", name?, site?}` or `{kind: "share", entryId,
     * handle}`. The name and site are put on the URL as a prefill, never sent
     * to the control plane: it holds no part of a login.
     */
    async vaultRequest(accessToken, expectedWorkspaceId, request) {
      const { name, site, ...rest } = request ?? {};
      const parsed = await post("/gateway/vault/request", { accessToken, expectedWorkspaceId, ...rest });
      const url = required(parsed, "url");
      if (typeof url !== "string" || !/^https?:\/\//.test(url)) return null;
      const built = new URL(url);
      if (typeof name === "string" && name) built.searchParams.set("name", name);
      if (typeof site === "string" && site) built.searchParams.set("site", site);
      return { url: built.toString() };
    },
  };
}
