/**
 * THE PROMPT A BOT IS GIVEN NAMES ITS AREA, WHERE IT WRITES, AND WHAT ITS MODES MEAN.
 *
 * The owner, 2026-11-25: a bot set up for an area gets "a copy this prompt" so
 * it knows it is for that area: its notes and goals in the area, projects in
 * the Projects folder but attached to the area, orient scoped to the area, and
 * its modes as The E-Myth means them. A person's delegate gets one that covers
 * every area they hold. The app's Copy prompt and the gateway's orient read
 * these words from one place (`packages/shared/src/areaBots.cjs`).
 */

import { describe, expect, test } from "@jest/globals";
import { MODE_MEANINGS, areaPrompt, delegatePrompt, mailJoinName, modeLines, setupPrompt } from "@context/shared/src/areaBots.cjs";

const AREA = { bot: "Finance", kind: "grok", whose: "@seyi", workspace: "@supa", area: "areas/operations/finance", title: "Finance", modes: ["Manager", "Doer"] };

describe("an area bot's prompt", () => {
  test("it says whose bot it is, which area it owns, and to orient in that area", () => {
    const text = areaPrompt(AREA);
    expect(text).toContain("You are Finance, @seyi's Grok bot.");
    expect(text).toContain('orient { context: "@supa", area: "areas/operations/finance" }');
  });

  test("notes and goals live in the area; projects live in Projects with an area line", () => {
    const text = areaPrompt(AREA);
    expect(text).toContain("your notes, goals and decisions, in areas/operations/finance/.");
    expect(text).toContain("put area: areas/operations/finance in its about.md");
  });

  test("mail is one note per sender in the area's mail folder", () => {
    const text = areaPrompt(AREA);
    expect(text).toContain("areas/operations/finance/mail/<sender>.md");
    expect(text).toContain('args: { join: "finance" }');
  });

  test("a webhook bot is told mail also reaches its webhook; one without checks on a timer", () => {
    expect(areaPrompt({ ...AREA, reach: "webhook" })).toContain("reaches your webhook");
    expect(areaPrompt({ ...AREA, reach: "mail" })).toContain("on a timer that survives");
  });

  test("it explains its own modes and leaves the others to whoever holds them", () => {
    const text = areaPrompt(AREA);
    expect(text).toContain(`- Manager: ${MODE_MEANINGS.Manager}`);
    expect(text).toContain(`- Doer: ${MODE_MEANINGS.Doer}`);
    expect(text).not.toContain(`- Visionary: ${MODE_MEANINGS.Visionary}`);
    expect(text).toContain("Visionary is not yours here: leave it to @seyi or whoever holds it.");
  });

  test("an area with no modes says nothing about them", () => {
    expect(areaPrompt({ ...AREA, modes: [] })).not.toContain("Your modes here");
  });
});

describe("what a mode means (the owner's E-Myth reading)", () => {
  test("a visionary sets course and does not check up on tasks", () => {
    expect(MODE_MEANINGS.Visionary).toMatch(/sets course and corrects it/);
    expect(MODE_MEANINGS.Visionary).toMatch(/Does not check up on tasks/);
  });
  test("a manager runs reviews, loops so nothing drops, and keeps projects filed", () => {
    expect(MODE_MEANINGS.Manager).toMatch(/code reviews, design reviews/);
    expect(MODE_MEANINGS.Manager).toMatch(/no task is dropped/);
    expect(MODE_MEANINGS.Manager).toMatch(/filed in the right place/);
  });
  test("a doer is the technician doing the work at the highest quality", () => {
    expect(MODE_MEANINGS.Doer).toMatch(/technician/);
  });
  test("modes come out in their usual order whatever order they were written", () => {
    expect(modeLines(["doer", "Visionary"]).slice(0, 2).map((line) => line.split(":")[0])).toEqual(["- Visionary", "- Doer"]);
  });
});

describe("a delegate's prompt", () => {
  test("a bot with no area yet orients for itself, to find every area it owns or acts in", () => {
    const text = delegatePrompt({ bot: "Chief", kind: "grok", whose: "@seyi", workspace: "supa" });
    expect(text).toContain("You are Chief, @seyi's Grok bot, in the Context workspace @supa.");
    expect(text).toContain('orient { context: "@supa", for: "Chief" }');
    for (const meaning of Object.values(MODE_MEANINGS)) expect(text).toContain(meaning);
  });

  test("an area's delegate acts for its person owner there, and asks them first", () => {
    // The owner, 2026-11-25: "1 delegate per area please".
    const one = setupPrompt({ bot: "Finance", kind: "grok", whose: "@seyi", workspace: "supa", areas: [{ folder: "areas/finance", title: "Finance", modes: ["Doer"], actsFor: "@shyoh" }] });
    expect(one).toContain('You act for @shyoh in the area "Finance" (areas/finance) in the Context workspace @supa: @shyoh owns it and you are its delegate.');
    expect(one).toContain("Ask @shyoh before anything this area's approval rules name.");
    const several = setupPrompt({
      bot: "Finance",
      kind: "grok",
      whose: "@seyi",
      areas: [
        { folder: "areas/finance", title: "Finance" },
        { folder: "areas/billing", title: "Billing", actsFor: "@shyoh" },
      ],
    });
    expect(several).toContain('"Billing" (areas/billing, for @shyoh, who owns it)');
    expect(several).toContain('"Finance" (areas/finance)');
    expect(several).toContain('for: "Finance"');
  });
});

test("a bot joins mail under a name mail accepts", () => {
  expect(mailJoinName("Chief of staff")).toBe("chief-of-staff");
  expect(mailJoinName("A very long bot name that goes on and on")).toBe("a-very-long-bot-name-tha");
  expect(mailJoinName("  ")).toBe("bot");
});

test("a bot with a card is told to put its own logo there, once", () => {
  const text = areaPrompt({ ...AREA, card: "areas/people/finance.md" });
  expect(text).toContain('path: "areas/people/finance.md"');
  expect(text).toContain("avatar: logo.png");
  // Its bytes, never a link: Context won't fetch an outside address without the person's own words (2026-11-25).
  expect(text).toContain('action: "upload"');
  expect(text).toContain('data: "<its base64>"');
  expect(text).not.toMatch(/url: "/);
  expect(areaPrompt(AREA)).not.toContain("avatar:");
  expect(delegatePrompt({ bot: "Chief", kind: "grok", whose: "@seyi", card: "areas/people/chief.md" })).toContain('path: "areas/people/chief.md"');
});

test("the setup prompt connects Context first, hands the secret over from the shell, then gives what to keep", () => {
  // The owner, 2026-11-25: "we cant assume that they have the mcp setup so that should be in every instruction".
  const one = setupPrompt({ bot: "Pipeline", kind: "grok", whose: "@seyi", workspace: "supa", areas: [{ folder: "areas/ci", title: "CI/CD", modes: ["Doer"] }], reach: "webhook" });
  expect(one.indexOf("https://mcp.context.lc/mcp")).toBeLessThan(one.indexOf("header_from_shell"));
  expect(one).toContain("give me the sign-in link and wait");
  expect(one).toContain('test_webhook: "Pipeline"');
  expect(one).toContain('orient { context: "@supa", area: "areas/ci" }');
  expect(one).not.toContain("avatar:");
  const several = setupPrompt({ bot: "Pipeline", kind: "grok", whose: "@seyi", areas: [{ folder: "areas/ci" }, { folder: "areas/pr" }], reach: "mail", card: "areas/people/pipeline.md", endpoint: "https://mcp.example.com/mcp" });
  expect(several).toContain("https://mcp.example.com/mcp");
  expect(several).toContain('for: "Pipeline"');
  expect(several).toContain("(areas/pr)");
  expect(several).toContain('path: "areas/people/pipeline.md"');
  expect(several).not.toContain("header_from_shell");
});
