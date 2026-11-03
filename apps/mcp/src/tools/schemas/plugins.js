/**
 * `list_plugins`. (The proposal tools that followed it were removed on
 * 2026-11-03: `docs/decisions/gateway-protocol.md`, "No proposals".)
 *
 * Part of `baseToolDefinitions` (`../schemas.js`), which concatenates these
 * families in the order the list has always had; moved verbatim.
 */

export function pluginToolDefinitions() {
  return [
    {
      name: "list_plugins",
      title: "Check Obsidian plugins",
      description:
        "Check the Obsidian plugins already in this context's bucket and report, for each one, "
        + "whether Context can run it, whether it needs the owner to approve a host it calls, "
        + "whether it stays in Obsidian while Context reads the files it writes, or whether it "
        + "cannot run here — with the specific call that decides it. Reads .obsidian/plugins/ and "
        + "writes nothing; the Obsidian setup is left exactly as it is.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
  ];
}
