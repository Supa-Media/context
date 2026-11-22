/**
 * `tex_dev` `test_chat`: the Lab's test chats under their own name (Dev2, 2026-11-22: two things were called a
 * sandbox, a pull request's preview and the Lab's test texts; "sandbox" now means only the preview).
 *
 * The action was `sandbox` and its id `sandboxId`. Both still answer, so an agent that learned the old names keeps
 * working, but every answer speaks the new ones: the id is `testChatId` and a test chat's Lab link is
 * `/lab?testchat=<id>`. Only this boundary renames; the Lab's route (`/tex-lab/sandbox`), its Durable Object
 * (`LabSandbox`) and `sandbox.js` keep their code names, which no person reads.
 */

/** The action's name, and the one it had. */
export const TEST_CHAT_ACTION = "test_chat";
export const OLD_TEST_CHAT_ACTION = "sandbox";

/** A call's arguments as the route takes them: `testChatId` is the route's `sandboxId`. */
export function testChatArgs(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) return args ?? {};
  if (!("testChatId" in args)) return args;
  const { testChatId, ...rest } = args;
  return rest.sandboxId === undefined ? { ...rest, sandboxId: testChatId } : rest;
}

const OLD_WORDS = [
  [/\bsandboxId\b/g, "testChatId"],
  [/\/lab\?sandbox=/g, "/lab?testchat="],
  [/\bsandbox (open|send|again|try|replay|step|card|wait|rows|get)\b/g, "test_chat $1"],
];

/** An answer in the new names: keys `sandboxId` become `testChatId`, and the hints and links in its text say so too. */
export function testChatAnswer(value) {
  if (typeof value === "string") return OLD_WORDS.reduce((text, [from, to]) => text.replace(from, to), value);
  if (Array.isArray(value)) return value.map(testChatAnswer);
  if (!value || typeof value !== "object") return value;
  const out = {};
  for (const [key, inner] of Object.entries(value)) out[key === "sandboxId" ? "testChatId" : key] = testChatAnswer(inner);
  return out;
}
