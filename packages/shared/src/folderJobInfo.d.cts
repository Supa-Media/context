/** Types for `folderJobInfo.cjs`; see that file for the rules and the reasons. */

import type { FolderJobs, RowRole } from "./folderRoles.cjs";

export type JobGroup = "needed" | "made" | "optional";
export type ShownJob = Exclude<RowRole, "meetings">;
export type InboxPart = "calendar" | "contacts" | "email" | "forms" | "google-chat" | "imessage" | "meetings" | "memories" | "sessions";

export interface FolderJobGuess {
  job: ShownJob;
  path: string;
  why: string;
}

export declare const SHOWN_JOBS: readonly ShownJob[];
export declare const JOB_GROUP: Readonly<Record<RowRole, JobGroup>>;
export declare const GROUP_LABEL: Readonly<Record<JobGroup, string>>;
export declare const JOB_LINE: Readonly<Record<RowRole, string>>;
export declare const INBOX_PARTS: readonly InboxPart[];
export declare const INBOX_PART_LABEL: Readonly<Record<InboxPart, string>>;
export declare function canGiveJob(job: string): boolean;
export declare function canRemoveJob(job: string): boolean;
export declare function topOnly(job: string): boolean;
export declare function isInboxPart(path: string, inboxPath: string | null): boolean;
export type TexPart = "attention" | "dreams" | "heartbeat" | "housekeeping" | "routines" | "skills" | "transcripts";
export declare const TEX_PARTS: readonly TexPart[];
export declare function isTexPart(path: string, texPath: string | null): boolean;
export declare function nameWords(name: string): string;
export declare function nameSays(name: string): { job: ShownJob; own: boolean } | null;
export declare function guessFolderJobs(
  folders: Iterable<{ path: string; role?: string | null }>,
  jobs: FolderJobs | null | undefined,
): FolderJobGuess[];
export declare function defaultFolderName(job: string): string | null;
export declare function jobNames(): string;
