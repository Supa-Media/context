import {
  CONVEX_REFERENCE,
  DECRYPT_CALL,
  RUN_CALL,
  SCHEDULE_CALL,
} from "./source";

/**
 * What one piece of source does, as far as the credential graph cares: does it
 * call the decrypt, which registered functions does it call, which does it
 * only schedule, and what did it do that cannot be followed at all.
 *
 * `problems` are fail-closed findings. Every one of them becomes a violation on
 * each registered function whose reach includes the text it was found in, so a
 * pattern the analyzer cannot see through fails the suite rather than being
 * assumed safe.
 */
export interface Facts {
  decrypt: boolean;
  calls: Set<string>;
  schedules: Set<string>;
  problems: Set<string>;
}

export function emptyFacts(): Facts {
  return {
    decrypt: false,
    calls: new Set(),
    schedules: new Set(),
    problems: new Set(),
  };
}

export function mergeFacts(into: Facts, from: Facts, suffix = ""): void {
  into.decrypt ||= from.decrypt;
  for (const call of from.calls) into.calls.add(call);
  for (const scheduled of from.schedules) into.schedules.add(scheduled);
  for (const problem of from.problems) into.problems.add(problem + suffix);
}

/**
 * The patterns in `source.ts` are `/g` regexes, which carry `lastIndex` between
 * calls. Reading one text while another read of the same object is mid-loop
 * would silently skip matches, so every read here gets its own copy.
 */
function fresh(pattern: RegExp): RegExp {
  return new RegExp(pattern.source, pattern.flags);
}

/**
 * The four readings the graph makes of a registered function's export block,
 * applied to any text: an export block, or the body of a helper reached
 * through an import. One implementation, so a helper is held to exactly the
 * rules the function that calls it is held to.
 *
 * Scheduling is not calling — see the long comment in `graph.ts` — and the
 * exemption is positional: only the reference in the scheduler's argument slot
 * is a schedule, and the same function named anywhere else is a call.
 */
export function textFacts(text: string, knownNodes: ReadonlySet<string>): Facts {
  const facts = emptyFacts();
  facts.decrypt = DECRYPT_CALL.test(text);

  let match: RegExpExecArray | null;
  const scheduledSpans: [number, number][] = [];
  const schedule = fresh(SCHEDULE_CALL);
  while ((match = schedule.exec(text)) !== null) {
    const argument = match[1];
    const start = match.index + match[0].length - argument.length;
    scheduledSpans.push([start, start + argument.length]);
    if (!/^internal\./.test(argument)) {
      facts.problems.add(
        `schedules ${argument || "<unparsed>"}, which is not a statically resolvable internal function reference — a scheduled target must be nameable, or the credential-reachability graph cannot see what was queued`,
      );
    }
  }
  const isScheduledReference = (index: number) =>
    scheduledSpans.some(([start, end]) => index >= start && index < end);

  const reference = fresh(CONVEX_REFERENCE);
  while ((match = reference.exec(text)) !== null) {
    const target = match[1].slice(1);
    if (!knownNodes.has(target)) continue;
    if (isScheduledReference(match.index)) facts.schedules.add(target);
    else facts.calls.add(target);
  }

  // Every `ctx.runX` must name a statically resolvable function, or the graph
  // is a fiction.
  const run = fresh(RUN_CALL);
  while ((match = run.exec(text)) !== null) {
    const argument = match[1];
    if (!/^(internal|api)\./.test(argument)) {
      facts.problems.add(
        `calls ctx.run…(${argument || "<unparsed>"}), which cannot be resolved statically — the credential-reachability graph cannot see through it`,
      );
    }
  }
  return facts;
}
