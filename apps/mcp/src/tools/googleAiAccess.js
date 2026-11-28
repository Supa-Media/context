import { AI_ACCESS_STEP } from "../../../../packages/shared/src/texContract/googleAiAccess.cjs";
export { AI_ACCESS_STEP };

/** One line naming the accounts that wait for Allow AI access, or none. */
export function aiAccessLine(addresses, what) {
  const named = Array.isArray(addresses) ? addresses.filter((address) => typeof address === "string" && address !== "") : [];
  if (named.length === 0) return null;
  return `AI access isn't allowed yet for ${named.join(", ")}, so its ${what} wasn't read. ${AI_ACCESS_STEP}`;
}
