import { describe, expect, test } from "@jest/globals";

import { privacyContent } from "../features/legal/content";

describe("the privacy policy describes connected AI assistants", () => {
  test("names their access, workspace boundary, third-party terms, and training", () => {
    expect(privacyContent.updated).toBe("October 5, 2026");
    expect(privacyContent.intro).toContain(
      "what an AI assistant you connect can see and do",
    );

    const assistants = privacyContent.sections.find(
      (section) => section.title === "AI assistants you connect",
    );

    expect(assistants?.body).toEqual([
      "You can connect AI assistants, such as Claude, ChatGPT, or Codex, to Context.lc. Each one signs in with your permission and gets its own access, which you can revoke at any time from your Context.lc settings.",
      "A connected assistant can read and search only the notes you can already see, in the workspaces you belong to, filtered by each workspace's privacy settings. It can write, move, or comment only where your role allows, and every change it makes is recorded in that workspace's activity under the assistant's name.",
      "Notes reach an assistant only when it asks for them on your behalf. What the assistant's provider does with that content is governed by its own terms and privacy policy, not this one.",
      "We do not use your notes to train AI models, and we do not sell them.",
    ]);
  });
});

describe("the privacy policy describes early-beta diagnostics", () => {
  test("names both vendors, what is never sent, the switches and feedback reports", () => {
    const diagnostics = privacyContent.sections.find(
      (section) => section.title === "Diagnostics and feedback",
    );
    const text = diagnostics?.body.join(" ") ?? "";
    expect(text).toContain("Sentry");
    expect(text).toContain("PostHog");
    expect(text).toContain("never include your notes, their titles, your folder names, your links");
    expect(text).toContain("Feedback");
    expect(text).toContain("only the attachments you left ticked");
  });
});

describe("the privacy policy describes X ads' pixel", () => {
  test("says where it runs and that only a hash of the address is sent", () => {
    const text = privacyContent.sections.flatMap((section) => section.body).join("\n");
    expect(text).toContain("X's (Twitter's) advertising pixel");
    expect(text).toContain("never inside the app or on your notes");
    expect(text).toContain("one-way hash of your email address");
  });
});
