/** The vault tools' definitions: logins and secrets an agent may name and ask about, never read. */

export function vaultToolDefinitions() {
  return [
    {
      name: "vault_list",
      title: "List saved logins and secrets",
      description:
        "The logins and secrets (API keys, environment variables, custom fields) in this workspace's vault that this person may use: " +
        "each one's id, name, the sites it fills on, and its field names with which of dev, staging and prod hold a value. " +
        "You never see a username, password or value, and nobody can give you one; Tex's browser fills them in itself, and the person sees values on the page vault_view_link gives them. " +
        "A personal workspace's vault is the person's own; a shared workspace's holds logins people chose to share there.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    {
      name: "vault_add_link",
      title: "Link to save a login or secret",
      description:
        "Get a private link where the person saves a login, or a secret such as API keys and environment variables, themselves, signed in to Context. " +
        "Use it whenever one is needed and is not in vault_list, and whenever someone tries to send you a password, key or token: never take one in a message. " +
        "For a secret, name the fields you expect (e.g. OPENAI_API_KEY); they are per environment (dev, staging, prod) unless perEnv is false. " +
        "Send them the link and say it is private to them and lasts 30 minutes.",
      inputSchema: {
        type: "object",
        properties: {
          type: { type: "string", enum: ["login", "secret"], description: "login (username and password) or secret (named fields). Default login." },
          name: { type: "string", description: "What to call it, e.g. Netflix or OpenAI. Optional; they can change it." },
          site: { type: "string", description: "The site it fills on, e.g. netflix.com. Optional for a secret; they can change it." },
          fields: {
            type: "array",
            items: { type: "string" },
            maxItems: 30,
            description: "Field names to start the form with, e.g. [\"OPENAI_API_KEY\", \"OPENAI_ORG_ID\"]. Optional; they can add and remove fields.",
          },
          perEnv: { type: "boolean", description: "Whether those fields hold one value each for dev, staging and prod. Default true for a secret." },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    {
      name: "vault_share_link",
      title: "Link to share a login",
      description:
        "Get a link where the person confirms giving one saved login to another member of this shared workspace. " +
        "You cannot share a login yourself: only the person, signed in, can press Share on that page. " +
        "After they do, that member and their own assistants can have it filled in for them. " +
        "Personal logins stay personal: to share one, the person saves it in the shared workspace first (vault_add_link with context set to it).",
      inputSchema: {
        type: "object",
        properties: {
          entry: { type: "string", description: "The login's id, from vault_list." },
          with: { type: "string", description: "Who to share it with: their @handle." },
        },
        required: ["entry", "with"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    {
      name: "vault_view_link",
      title: "Link to see a saved secret",
      description:
        "Get a private link where the person sees one saved entry's values, signed in to Context: reveal or copy each one, or copy a whole environment as a .env file. " +
        "Use it when they ask for a key, a password or their env variables. You never see the values; only they do, on that page.",
      inputSchema: {
        type: "object",
        properties: {
          entry: { type: "string", description: "The entry's id, from vault_list." },
          env: { type: "string", enum: ["dev", "staging", "prod"], description: "Open the page on this environment. Optional." },
        },
        required: ["entry"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
  ];
}
