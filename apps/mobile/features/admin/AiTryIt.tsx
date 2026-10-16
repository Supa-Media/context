import type { Id } from "@context/convex/_generated/dataModel";
import type { TestCase } from "./testList";

/** Board 13's Try it: chat with a setup as yourself, its rules checked on every reply. Written by the coordinator. */
export function AiTryIt(_props: {
  workspaceId: Id<"workspaces">;
  job: string;
  /** The setups to try, live first: their note paths. */
  setups: readonly { name: string; path: string }[];
  /** The case open beside it: its rules are checked on every reply, and its question starts the chat. */
  testCase: TestCase | null;
  /** Turn the exchange into a new case in the open test list. */
  onSaveAsCase: (exchange: { question: string; answer: string }) => void;
}) {
  return null;
}
