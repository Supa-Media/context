import { describe, expect, it } from "vitest";
import { groupCommand } from "./groupInbox";

describe("sharing a mailbox with the chat, in other words (chat-mail.md)", () => {
  it("reads \"add my <address> email to this group\" as sharing the inbox, never as inviting the address", () => {
    // The Crystal Care chat, 2026-10-29: read as inviting the address, when it meant the inbox.
    expect(groupCommand("Tex add my seyi@crystalnurse.example email to this group")).toEqual({ kind: "share_mail", address: "seyi@crystalnurse.example" });
    expect(groupCommand("Tex, connect my gmail me@work.example to the chat")).toEqual({ kind: "share_mail", address: "me@work.example" });
    expect(groupCommand("Tex add bo@work.example to this group")).toBeNull();
  });
});
