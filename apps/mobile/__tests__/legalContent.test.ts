import { describe, expect, test } from "@jest/globals";

import { privacyContent, supportContent, termsContent } from "../features/legal/content";

describe("the privacy policy describes connected AI assistants", () => {
  test("names their access, workspace boundary, third-party terms, and training", () => {
    expect(privacyContent.updated).toBe("October 28, 2026");
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

/**
 * App Review 5.1.1(i) / 5.1.2(i): the policy names who receives recording
 * audio, that it is asked for first, how to take it back, and only the
 * provider claims we verified (`docs/decisions/meetings/transcription-consent.md`).
 */
describe("the privacy policy describes cloud transcription", () => {
  const section = privacyContent.sections.find((entry) => entry.title === "Cloud transcription");
  const text = section?.body.join("\n") ?? "";

  test("names the provider, the model's author, and that the audio goes to Cloudflare", () => {
    expect(text).toContain("Cloudflare Workers AI");
    expect(text).toContain("Whisper, a speech recognition model made by OpenAI");
    expect(text).toContain("The audio goes to Cloudflare, not to OpenAI.");
    expect(text).toContain("other people's voices");
  });

  test("says nothing is sent before a yes, Not now records nothing, and how to withdraw", () => {
    expect(text).toContain("Nothing is sent until you allow it.");
    expect(text).toContain("If you choose Not now, no audio is recorded or sent");
    expect(text).toContain("in Settings, under Meetings");
    expect(text).toContain("including from a recording that is already running");
    // Withdrawal reaches other devices and the servers when it arrives, and a
    // request already sent cannot be recalled: said, not promised away.
    expect(text).toContain("Your other devices and our servers stop once the change reaches them");
    expect(text).toContain("cannot be called back");
    expect(text).not.toContain("From then on nothing more is sent");
    expect(text).toContain("we ask again if the provider or the purpose changes");
  });

  test("makes only the retention and training claims we verified", () => {
    expect(text).toContain("Context.lc does not store the audio");
    expect(text).toContain("Cloudflare states that it does not use content sent to Workers AI to train AI models.");
    expect(text).not.toMatch(/Cloudflare (deletes|does not (keep|retain|store))/);
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
    // The Usage tab's two additions, said in the policy before they are sent.
    expect(text).toContain("which of the app's buttons are pressed (by a fixed name, never their words)");
    expect(text).toContain("how long the app is in use");
  });
});

describe("the privacy policy describes X ads' pixel", () => {
  test("says where it runs and that only a hash of the address is sent", () => {
    const text = privacyContent.sections.flatMap((section) => section.body).join("\n");
    expect(text).toContain("advertising pixels of X (Twitter) and Meta (Facebook and Instagram)");
    expect(text).toContain("never inside the app or on your notes");
    expect(text).toContain("one-way hash of your email address");
  });
});

describe("the privacy policy matches what the phone app collects", () => {
  const text = privacyContent.sections.flatMap((section) => section.body).join("\n");

  test("names phone numbers, profile photos and meeting audio", () => {
    expect(text).toContain("your phone number if you sign in with one");
    expect(text).toContain("the profile photo you choose");
    expect(text).toContain(
      "If you record a meeting, and only after you allow cloud transcription, the audio is sent through Context.lc to Cloudflare Workers AI",
    );
  });

  test("says app signups are never reported to an advertising network", () => {
    expect(text).toContain("Signups made in the iPhone or Android app are never reported to X, Meta or any other advertising network.");
  });

  test("names the AI built into Context.lc and the providers it uses", () => {
    expect(privacyContent.sections.map((section) => section.title)).toContain("AI built into Context.lc");
    expect(text).toContain("Anthropic and Cloudflare Workers AI");
  });

  test("says deletion erases Context-managed notes, with no request by email", () => {
    expect(text).toContain("Notes and attachments in Context-managed storage for those workspaces are permanently erased");
    expect(text).not.toContain("To have notes in Context-managed storage erased as well, email us");
  });

  test("points to in-app account deletion rather than a request by email", () => {
    expect(text).toContain("You can delete your account yourself in Settings, under Profile");
    expect(text).not.toContain("contact us to request account deletion");
  });
});

describe("the terms and support page cover objectionable content (App Store guideline 1.2)", () => {
  test("the terms say there is no tolerance, how to report, and what happens within 24 hours", () => {
    expect(termsContent.updated).toBe("October 15, 2026");
    const section = termsContent.sections.find((entry) => entry.title === "Objectionable content and abuse");
    const text = section?.body.join(" ") ?? "";
    expect(text).toContain("no tolerance for objectionable or abusive content or behaviour");
    expect(text).toContain("report a note, an invitation, or a public page from inside the app");
    expect(text).toContain("block a person");
    expect(text).toContain("within 24 hours");
    expect(text).toContain("remove the accounts");
  });

  test("support says how to report and block, and where to unblock", () => {
    const section = supportContent.sections.find((entry) => entry.title === "Reporting and blocking");
    const text = section?.body.join(" ") ?? "";
    expect(text).toContain("Report or block");
    expect(text).toContain("context@supa.media");
    expect(text).toContain("unblock people in Settings, under Profile");
    expect(text).toContain("within 24 hours");
  });
});
