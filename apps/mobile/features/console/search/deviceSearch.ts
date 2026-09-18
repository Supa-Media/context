import { formatCount } from "../format";
import {
  DEVICE_SEARCH_UNAVAILABLE,
  mirrorShortfall,
  type DeviceSearchReason,
} from "../../offline/mirrorCopy";
import type { DeviceSearchAnswer } from "../../offline/mirrorSearch";
import type { MirrorStatus } from "../../offline/mirrorStatus";
import type { BlendedAnswer, BlendedResult, BlendedSource } from "./results";

/**
 * The search page's answer when it comes from the copies on this device.
 *
 * Pure, beside `results.ts`, for that file's reason: what matters here is
 * which sentence somebody reads, and that is pinned in plain node. The page's
 * hook (`useBlendedSearch`) decides *when* the device answers — offline, or
 * when the control plane's fan-out failed — with the palette's rule
 * (`useContextSearch`); this decides what that answer is.
 *
 * ## Blended the way the control plane blends
 *
 * `files.searchContexts` fuses ranks, never scores, because a score is a fact
 * about one corpus (`docs/decisions/search.md`, "A blended search over several
 * contexts fuses ranks"). The device's scores are not comparable across
 * contexts either — they count occurrences in notes of different sizes — so
 * the same `1 / (60 + rank)` ladder is used, and a context's first result
 * beats any context's third, offline as online.
 *
 * ## Honest about what was not searched
 *
 *  - A context with **nothing on the device** is not a source that answered
 *    "no matches": it is left out of `sources` and named in the notice.
 *  - A context whose copy is **partial**, or whose list was capped, makes the
 *    total a floor — the rule every count in this product follows.
 *  - **Encrypted notes** are counted, because their titles are on screen
 *    elsewhere and somebody looking for one should learn why it is not here.
 */

/** A context the page searched, as the device search needs to name it. */
export interface DeviceSearchContext {
  workspaceId: string;
  slug: string;
  displayName: string;
}

/** One context's answer from the device, and what its mirror says about itself. */
export interface DeviceSourceAnswer {
  context: DeviceSearchContext;
  /** `null` — no mirror on this device at all. */
  answer: DeviceSearchAnswer | null;
  status: MirrorStatus | undefined;
}

/** The constant in reciprocal-rank fusion — the control plane's own. */
const RRF_K = 60;

function copyIsWhole(source: DeviceSourceAnswer): boolean {
  return source.status?.state === "synced";
}

export function blendDeviceAnswers(sources: readonly DeviceSourceAnswer[]): BlendedAnswer {
  const scored: { row: BlendedResult; score: number; order: number }[] = [];
  const answered: BlendedSource[] = [];
  let matchCount = 0;
  let floor = false;

  sources.forEach((source, order) => {
    const { context, answer } = source;
    if (answer === null || !answer.mirrored) {
      // Not searched, so not a source — and the page's total cannot be exact.
      floor = true;
      return;
    }
    const capped = answer.matchCount > answer.hits.length;
    const sourceFloor = capped || !copyIsWhole(source);
    floor ||= sourceFloor;
    matchCount += answer.matchCount;
    answered.push({
      workspaceId: context.workspaceId,
      slug: context.slug,
      displayName: context.displayName,
      state: "ok",
      matchCount: answer.matchCount,
      matchCountIsFloor: sourceFloor,
    });
    answer.hits.forEach((hit, rank) => {
      scored.push({
        row: {
          workspaceId: context.workspaceId,
          slug: context.slug,
          displayName: context.displayName,
          path: hit.path,
          title: hit.title,
          snippet: hit.snippets[0] ?? "",
        },
        score: 1 / (RRF_K + rank + 1),
        order,
      });
    });
  });

  scored.sort((a, b) => b.score - a.score || a.order - b.order);
  return {
    results: scored.map((each) => each.row),
    matchCount,
    matchCountIsFloor: floor,
    cursor: null,
    sources: answered,
    searchableCount: sources.length,
  };
}

function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

/**
 * The line above the page's results when they came from the device.
 *
 * One sentence for where they came from, one per context that is not all
 * here, and one for what was skipped. A browser that keeps no copy at all
 * gets the palette's own sentence for that, so the two surfaces say it alike.
 */
export function deviceSearchPageNotice(
  reason: DeviceSearchReason,
  sources: readonly DeviceSourceAnswer[],
): string {
  if (sources.length > 0 && sources.every((source) => source.answer === null)) {
    return DEVICE_SEARCH_UNAVAILABLE;
  }
  const parts = [
    reason === "offline"
      ? "Searched the copies on this device."
      : "Search could not reach your contexts, so this searched the copies on this device.",
  ];
  let encrypted = 0;
  for (const source of sources) {
    const { context, answer } = source;
    if (answer === null) continue;
    if (!answer.mirrored) {
      parts.push(`@${context.slug}: nothing is on this device yet.`);
      continue;
    }
    encrypted += answer.encryptedSkipped;
    const short = mirrorShortfall(source.status);
    if (short !== null) parts.push(`@${context.slug}: ${lowerFirst(short)}`);
  }
  if (encrypted > 0) {
    parts.push(
      encrypted === 1
        ? "1 encrypted note was not searched."
        : `${formatCount(encrypted)} encrypted notes were not searched.`,
    );
  }
  return parts.join(" ");
}
