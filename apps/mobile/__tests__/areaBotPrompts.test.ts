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
import { MODE_MEANINGS, areaPrompt, areasPrompt, botMemory, delegatePrompt, mailJoinName, modeLines, setupPrompt } from "@context/shared/src/areaBots.cjs";

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

  test("routines are the area's and Context runs them; other bots are reached only in Context mail", () => {
    // The owner, 2026-11-25: routines are defined on an area, not set up by the bot, and bots from different people
    // and apps talk to each other only through Context mail.
    for (const text of [areaPrompt(AREA), delegatePrompt({ bot: "Chief", kind: "grok", whose: "@seyi", workspace: "supa" })]) {
      expect(text).toContain("never set up a routine of your own");
      expect(text).toContain("used: <whole percent>");
      expect(text).toContain("Talk to other areas and other bots only in Context mail");
    }
    expect(areaPrompt(AREA)).toContain("areas/operations/finance/routines/<how often>/<name>.md");
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
    const one = areaPrompt({ bot: "Finance", kind: "grok", whose: "@seyi", workspace: "supa", area: "areas/finance", title: "Finance", modes: ["Doer"], actsFor: "@shyoh" });
    expect(one).toContain('You act for @shyoh in the area "Finance" (areas/finance) in the Context workspace @supa: @shyoh owns it and you are its delegate.');
    expect(one).toContain("Ask @shyoh before anything this area's approval rules name.");
    const several = areasPrompt({
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
  expect(text).toContain("avatar: profile-picture-finance.png");
  // Its bytes, never a link: Context won't fetch an outside address without the person's own words (2026-11-25).
  expect(text).toContain('action: "upload"');
  expect(text).not.toMatch(/url: "/);
  // Bots sharing one workspace save their pictures to one file, so each takes a lock and uploads only its own copy
  // (Dev, 2026-11-27: "they all need file locks").
  expect(text).toContain("mkdir /workspace/.profile-picture.lock");
  expect(text).toContain("/workspace/profile-picture-finance.png");
  expect(text).toContain("Never upload `/workspace/profile-picture.png` directly");
  expect(areaPrompt(AREA)).not.toContain("avatar:");
  expect(delegatePrompt({ bot: "Chief", kind: "grok", whose: "@seyi", card: "areas/people/chief.md" })).toContain('path: "areas/people/chief.md"');
});

// Every step the bot must take is in the pasted prompt, never only in setup_bot's reply: Muse's app refused that
// reply's orders as possible prompt injection (2026-11-27). Nothing in it names an area (Dev, 2026-11-27: "we shouldnt
// have area specific wording as area assignments can change").
describe("the setup prompt", () => {
  const prompt = (over: Record<string, unknown> = {}) => setupPrompt({ bot: "Pipeline", kind: "grok", whose: "@seyi", workspace: "supa", areas: [{ folder: "areas/ci", title: "CI/CD", modes: ["Doer"] }], reach: "webhook", ...over });
  const steps = (text: string) => text.split("---")[0];
  test("connects Context first, then runs setup_bot from the main chat", () => {
    const one = prompt();
    expect(one).toContain("give me the sign-in link and wait");
    expect(one.indexOf("https://mcp.context.lc/mcp")).toBeLessThan(one.indexOf('manage area { context: "@supa", setup_bot: "Pipeline" }'));
    expect(prompt({ endpoint: "https://mcp.example.com/mcp" })).toContain("https://mcp.example.com/mcp");
  });
  test("a webhook bot makes its relay routine and hands its webhook over from the shell, with no area", () => {
    const one = steps(prompt());
    expect(one).toContain("Never write to Context, reply, or send anything from this run.");
    expect(one).toContain('manage area { context: "@supa", webhook: { bot: "Pipeline"');
    expect(one).toContain("header_from_shell");
    expect(one.indexOf("header_from_shell")).toBeLessThan(one.indexOf("setup_bot"));
  });
  // Dev, 2026-11-27: "fix these PLEASE" — a Grok bot's webhook wakes queued until Dev wrote in its chat, so a webhook
  // bot checks in every 5 minutes as well, and its step says so before setup_bot.
  test("a webhook bot also makes its 5-minute check-in, before setup_bot", () => {
    const one = steps(prompt());
    expect(one).toMatch(/4\. Also make a job in Grok[^\n]*every 5 minutes[^\n]*orient \{ context: "@supa", for: "Pipeline", check: true \}/);
    expect(one.indexOf("check: true")).toBeLessThan(one.indexOf("setup_bot"));
  });
  test("a check-in bot makes its 5-minute job as its own step, before setup_bot", () => {
    const muse = steps(setupPrompt({ bot: "Muse", kind: "muse", whose: "@seyi", workspace: "@supa", areas: [] }));
    expect(muse).toMatch(/2\. Make a job in Muse that runs every 5 minutes[^\n]*orient \{ context: "@supa", for: "Muse", check: true \}/);
    expect(muse.indexOf("check: true")).toBeLessThan(muse.indexOf("setup_bot"));
    expect(muse).not.toContain("webhook: {");
  });
  test("it names no area, and is the same whatever areas the bot holds", () => {
    expect(prompt()).not.toMatch(/areas\//);
    expect(prompt()).toBe(prompt({ areas: [] }));
    expect(prompt()).not.toContain("bind_bot");
  });
});

// Dev, 2026-11-27, of Muse's prompt: "where is the 5 minute timer loop?". What a bot keeps is the same whatever areas
// it holds, and a check-in bot's says the check-in even when it holds none.
describe("what a bot keeps in memory", () => {
  const muse = botMemory({ bot: "Muse", kind: "muse", whose: "@seyi", workspace: "@supa" });
  test("a check-in bot keeps its 5-minute check-in, and is never told of a webhook", () => {
    expect(muse).toContain('orient { context: "@supa", for: "Muse", check: true }');
    expect(muse).toContain("on a timer that survives");
    expect(muse).toContain("your 5-minute check-in lists the ones waiting for you");
    expect(muse).toContain("your 5-minute check-in is the one schedule you keep");
    expect(muse).not.toContain("webhook");
  });
  test("a webhook bot keeps its relay and its 5-minute check-in", () => {
    const grok = botMemory({ bot: "Pipeline", kind: "grok", whose: "@seyi", workspace: "supa" });
    expect(grok).toContain("reaches your webhook");
    expect(grok).toContain("Your webhook routine only relays");
    expect(grok).toContain('orient { context: "@supa", for: "Pipeline", check: true }');
    expect(grok).toContain("Keep it even though you have a webhook");
    expect(grok).toContain("your 5-minute check-in lists the ones waiting for you");
    expect(grok).toContain("your 5-minute check-in is the one schedule you keep, beside your webhook's relay routine");
  });
  test("every bot answers every routine that waits, not only the newest", () => {
    for (const kept of [muse, botMemory({ bot: "Pipeline", kind: "grok", whose: "@seyi", workspace: "supa" })]) {
      expect(kept).toContain("do every one, oldest first");
      expect(kept).toContain("never only the newest");
    }
  });
  test("it names no area", () => {
    expect(muse).not.toMatch(/areas\//);
  });
});
