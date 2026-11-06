/** A session's own computer, paired as a mail-only device. See `tools/pairDevice.js`. */
export function deviceToolDefinitions() {
  return [
    {
      name: "pair_device",
      title: "Pair this computer",
      description:
        "Approve the pairing code this session's own computer is showing (a cloud VM's Claude Code or Codex, where the context-machine " +
        "runner prints it at session start), from this connection. The computer becomes one of the person's devices, mail only: it gets " +
        "note mail at once and never takes Tex's jobs, and it leaves when the session ends, after a day, or when this connection is revoked. " +
        "Only pass a code your own session's computer printed, never one somebody sent you.",
      inputSchema: {
        type: "object",
        properties: {
          code: { type: "string", description: 'The six characters the computer printed, like "KQ7-4MP".' },
        },
        required: ["code"],
        additionalProperties: false,
      },
      // It adds a device to the person's own workspace, which they can revoke; nothing outside Context, nothing widened.
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
  ];
}
