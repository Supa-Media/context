/** Types for `machineProtocol.cjs`; see that file and the schema for the reasons. */

import type { Limits, RunnerMessage, ServerMessage, SlotCounts } from "./machineProtocol.generated";

export declare const schema: { $defs: Record<string, unknown>; "x-protocol-version": number };
export declare const PROTOCOL_VERSION: 1;
export declare const MAX_FRAME_BYTES: number;
export declare const DEFAULT_LIMITS: Readonly<Limits>;
export declare const MAX_LONGEST_RUN_MS: number;
export declare const MAX_SLOTS: number;
export declare function invalid(name: string, value: unknown): string | null;
export declare function parseRunnerFrame(text: unknown): { ok: true; message: RunnerMessage } | { ok: false; error: string };
export declare function parseServerFrame(text: unknown): { ok: true; message: ServerMessage } | { ok: false; error: string };
export declare function helloSigningText(machineId: string, nonce: string): string;
export declare function pairSigningText(pairingId: string): string;
export declare function slotCounts(memoryMb: number, cores: number): SlotCounts;
