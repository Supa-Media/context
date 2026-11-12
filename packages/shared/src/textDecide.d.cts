/** Types for `textDecide.cjs`; see that file for what decide and the last look ask and how answers are read. */

export type Style = "quiet" | "attentive" | "followAlong" | "helpful" | "direct";
export declare const STYLES: readonly Style[];
export declare const MAX_TRANSCRIPT: number;
export declare const MAX_CANDIDATES: number;
export declare const MAX_WAITING_ASKS: number;
export declare const WAIT_SECOND_LEVELS: number;
export declare const STALE_AT: number;
export declare const MAX_DRAFT: number;
export declare const FITS_AT: number;
export declare const CHAT_MARKS: string;
export declare const FOR_TEX_RULE: string;
export declare const WHY: Readonly<Record<string, string>>;
export type JudgeExample = { chat: "group" | "one"; setting?: string; lines: string[]; text: string; verdict: "respond" | "react" | "quiet" | "wait"; emoji?: string; why: string };
export declare const JUDGE_EXAMPLES: readonly JudgeExample[];
export declare const EXAMPLES_TEXT: string;
export declare const REACT_EMOJI: Readonly<Record<string, { readonly emoji: string; readonly when: string }>>;

/** `{ state, questions }`: what the decision model reads and the typed questions it answers. */
export interface DecisionRequest {
  state: string;
  questions: Record<string, unknown>;
}
export type DecisionAnswers = Record<string, unknown>;

export interface DecideBody {
  chat: string;
  style: Style;
  transcript: string;
  candidates: string[];
  running: boolean;
  waitingAsks: string[];
  newest: string;
  /** Groups: the line the chat is on, so the row is found by the same hash. */
  line?: string;
  /** 1:1: the person's number, so their personal workspace is metered. */
  sender?: string;
  /** Groups: the chat's ledger key (`chat:<groupKey>`), where the gateway keeps the judge's verdict. */
  ledger?: string;
}

export type DecideResult =
  | {
      ok: true;
      act: "silent" | "react" | "answer" | "wait";
      covers: string[];
      midTurn?: "fold" | "queue" | "restart";
      stale: string[];
      movedOn: boolean;
      confidence: number;
      emoji?: string;
      waitSeconds?: number;
      /** One of `WHY`'s keys: why the judge chose what it did. */
      why?: string;
    }
  | { ok: false; reason: "capped" | "off" | "unavailable"; cause: string };

export interface RecheckBody extends DecideBody {
  draft: string;
  draftFor: string;
}
export type RecheckResult = { ok: true; fits: boolean; confidence: number } | { ok: false; reason: "capped" | "off" | "unavailable"; cause: string };

export declare function readDecideBody(body: Record<string, unknown>): DecideBody | null;
/** `facts`: lines the gateway knows about the chat now (its running jobs), shown to the judge as `<now>`. */
export declare function decideRequest(body: DecideBody, options?: { facts?: readonly string[] }): DecisionRequest;
export declare function readDecideAnswers(body: DecideBody, answers: DecisionAnswers): DecideResult;
export declare function readRecheckBody(body: Record<string, unknown>): RecheckBody | null;
export declare function recheckRequest(body: RecheckBody): DecisionRequest;
export declare function readRecheckAnswers(answers: DecisionAnswers): RecheckResult;
