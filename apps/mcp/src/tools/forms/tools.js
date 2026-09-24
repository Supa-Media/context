/** The form tools: `create_form`, `submit_form`, `update_submission`, `retract_submission`, `vote_form`. */

import {
  defaultFormId,
  mayChangeResponse,
  roleAtLeast,
  valuesFromPairs,
  whoReads,
} from "../formSupport.js";
import { effectiveVisibility } from "../../privacy/engine.js";
import { mayCollectResponsesAt, mutateFormResponses } from "./responses.js";
import {
  newResponseId,
  parseFormBlocks,
  renderFormBlock,
  responseStamp,
  validateSubmission,
} from "../../forms.js";
import { normalizePath } from "../../notes/paths.js";
import { toolError, toolText } from "../results.js";
import { toolWriteNote } from "../notes/write.js";

/**
 * Create a note that carries a form, from fields rather than from Markdown.
 *
 * ## The gap this closes
 *
 * Every form tool here answers a form; none of them makes one. An agent asked
 * for "an intake form for new clients" had to know the block's keys, its field
 * types, that `max` is mandatory on a `line`, that `layout` is declared rather
 * than inferred, and that the answers live in a second note — and then hand-write
 * all of it through `write_note`. That is a feature nobody discovers, which is
 * the same as a feature nobody has.
 *
 * ## It takes fields, never a block
 *
 * `renderFormBlock` writes the block and this parses what it wrote, so the
 * authority on what a form means stays `parseFormBlocks` — one parser, one
 * answer, and a value that would mean something else on the way back out is a
 * refusal rather than a second key.
 *
 * There is deliberately no *third* check re-rendering the parsed config and
 * comparing. It was written, and sabotaging it failed nothing: the renderer
 * refuses everything a form block cannot carry, and the parser refuses
 * everything else, so no input reaches it. A guard nobody has checked is not a
 * guard — `docs/decisions/testing.md` — so the property lives where it can be
 * proved, as a round-trip assertion over hostile fixtures in
 * `forms.test.mjs`, rather than as a branch here that never runs.
 *
 * ## The write is `write_note`'s, entirely
 *
 * Visibility, the team-publish confirmation, the encryption rule, the etag,
 * the activity line and the creation of the empty response file are that
 * function's and are not restated here — `mustCreate` is the single thing it
 * is asked to do differently, because a tool called "create" that silently
 * replaced somebody's note would be the worst kind of convenience.
 */
export async function toolCreateForm(store, scope, rules, overrides, args) {
  const path = normalizePath(args.path);
  if (!path || !path.endsWith(".md")) {
    return toolError("path must be a note path ending in .md");
  }
  const stem = path.slice(0, -3);
  const responses = normalizePath(args.responses || `${stem}-responses.md`);
  if (!responses || !responses.endsWith(".md")) {
    return toolError("responses must be a note path ending in .md");
  }
  if (responses === path) {
    return toolError(
      "the answers go in a note of their own, never on the form's own page: who may read them " +
        "is that note's own privacy rule, and there is no second access-control path here."
    );
  }

  const rendered = renderFormBlock({
    id: args.id || defaultFormId(stem),
    responses,
    layout: args.layout || "table",
    submit: args.submit || "member",
    edit_own: args.edit_own !== false,
    show_responses: args.show_responses === true,
    votes: args.votes === "named" ? "named" : "off",
    ...(typeof args.notify === "string" && args.notify ? { notify: args.notify } : {}),
    fields: args.fields,
  });
  if (rendered.error) return toolError(`that form cannot be written: ${rendered.error}`);

  const parsed = parseFormBlocks(rendered.text);
  if (!parsed.length || parsed[0].error) {
    return toolError(`that form is not valid: ${parsed[0]?.error ?? "it produced no block"}`);
  }
  const heading = typeof args.title === "string" && args.title.trim() ? args.title.trim() : null;
  const intro = typeof args.intro === "string" && args.intro.trim() ? args.intro.trim() : null;
  const content = [
    ...(heading ? [`# ${heading}`] : []),
    ...(intro ? [intro] : []),
    rendered.text,
  ].join("\n\n") + "\n";

  const written = await toolWriteNote(
    store,
    scope,
    rules,
    overrides,
    {
      path,
      content,
      visibility: args.visibility,
      confirm_team_publish: args.confirm_team_publish,
      summary: args.summary || `added the ${parsed[0].config.id} form`,
    },
    { mustCreate: true }
  );
  if (written.isError) return written;

  /*
   * Where the answers land, and who can read them, said plainly and once —
   * **and only to a caller the manifest would have told anyway.**
   *
   * The sentence itself is load-bearing: the response file inherits its folder,
   * and an agent that assumed "private because the form is private" would be
   * telling somebody their client intake is confidential when the folder
   * default says otherwise.
   *
   * But `responses` is a path the *caller* names, and this is a read of
   * `privacy.md` — a file a team connection cannot open (`read_note` answers
   * `not found`). Printed unconditionally it answered, one path per call, the
   * question that file is closed to: is this folder private, is it team, or is
   * it held to a group — and in the last case it read the group's own name
   * back, which is membership structure and the sharpest thing a rule carries.
   * No other surface at that tier discloses it; `scope_info`, `orient` and
   * `list_notes` each name neither a rule nor a group.
   *
   * `mayCollectResponsesAt` is already the predicate for "may this connection
   * collect here", and it is exactly the line: where it is true, a team caller
   * is looking at a `team` destination it could have established by writing
   * there, and an owner may read the manifest regardless. Where it is false
   * the collection did not happen, and `write_note` has already said so in
   * words that name no rule.
   */
  const mayCollect = mayCollectResponsesAt(scope, responses, rules, overrides);
  const answersVisibility = mayCollect
    ? effectiveVisibility(responses, rules, overrides)
    : null;
  const body = written.content?.[0]?.text ?? "";
  // Built only where it is going to be printed. Computing it regardless would
  // leave `The answers are held to null` sitting in a variable one edit away
  // from a caller, which is how a suppressed disclosure comes back.
  const destination = mayCollect
    ? `answers go to: ${responses} (${answersVisibility})\n${whoReads(answersVisibility)}`
    : `answers go to: ${responses}`;
  return toolText(
    `${body}\n\n${destination}` +
      `\nsubmitting: ${parsed[0].config.submit} and above` +
      /*
        Who gets told, said in the same breath as where the answers land, and
        said honestly: this worker cannot resolve a handle to a person, a
        membership or a mailbox, so it reports what the block asks for rather
        than claiming a delivery it has no way to confirm.
      */
      (parsed[0].config.notify
        ? `\nemails on every answer: ${parsed[0].config.notify} — a member of this context, at the ` +
          "address on their account, and only if they can read the answers note. The mail carries " +
          "the answers."
        : "") +
      (parsed[0].config.layout === "table"
        ? "\nlayout: table — one row per answer, so keep paragraph fields few"
        : "\nlayout: sections — one heading per answer") +
      /*
        The next step, said here rather than left to the agent to know.

        A form is only half of "collect this from people": the other half is a
        link they can be sent, and an agent that does not know `create_link`
        takes one is an agent that writes the block and stops. Said as the
        option it is — plenty of forms are for people who already have accounts
        — and only for a form that takes `member` answers, because a form
        restricted to editors cannot be answered through a link at all.
      */
      (parsed[0].config.submit === "member"
        ? "\n\nTo let people WITHOUT an account fill this in, publish it: create_link with " +
          "mode=collect on this note, or — if create_link is not in your tool list — write_note " +
          "with share=collect. Without one, only people who can already see this context can answer."
        : "")
  );
}

export async function toolSubmitForm(store, scope, rules, overrides, args) {
  return mutateFormResponses(store, scope, rules, overrides, args, "submit_form", (responses, { config, actor }) => {
    if (!roleAtLeast(actor.role, config.submit)) {
      return {
        refusal: toolError(
          `permission denied: this form takes responses from ${config.submit}s of this context and above.`
        ),
      };
    }
    const supplied = valuesFromPairs(args.values);
    if (supplied.error) return { refusal: toolError(supplied.error) };
    const checked = validateSubmission(config, supplied.values);
    if (checked.error) return { refusal: toolError(checked.error) };

    const taken = new Set(responses.map((response) => response.id));
    let id = newResponseId();
    while (taken.has(id)) id = newResponseId();

    const response = {
      id,
      by: actor.name,
      at: responseStamp(),
      values: checked.values,
      votes: [],
    };
    return {
      responses: [...responses, response],
      responseId: id,
      message: `submitted: ${id}\nform: ${config.id}\nrecorded as: ${actor.name}`,
    };
  });
}

export async function toolUpdateSubmission(store, scope, rules, overrides, args) {
  return mutateFormResponses(store, scope, rules, overrides, args, "update_submission", (responses, { config, actor }) => {
    const index = responses.findIndex((response) => response.id === args.response_id);
    if (index === -1) return { refusal: toolError("no such response on this form") };
    const existing = responses[index];
    const denied = mayChangeResponse(existing, config, actor, "edit");
    if (denied) return { refusal: denied };

    const supplied = valuesFromPairs(args.values);
    if (supplied.error) return { refusal: toolError(supplied.error) };
    const checked = validateSubmission(config, supplied.values);
    if (checked.error) return { refusal: toolError(checked.error) };

    const next = responses.slice();
    // `by`, `at` and the votes other people cast are not the submitter's to
    // rewrite: an edit changes the answers and nothing else.
    next[index] = { ...existing, values: checked.values };
    return {
      responses: next,
      responseId: existing.id,
      message: `updated: ${existing.id}\nform: ${config.id}`,
    };
  });
}

export async function toolRetractSubmission(store, scope, rules, overrides, args) {
  return mutateFormResponses(store, scope, rules, overrides, args, "retract_submission", (responses, { config, actor }) => {
    const existing = responses.find((response) => response.id === args.response_id);
    if (!existing) return { refusal: toolError("no such response on this form") };
    const denied = mayChangeResponse(existing, config, actor, "delete");
    if (denied) return { refusal: denied };
    return {
      responses: responses.filter((response) => response.id !== existing.id),
      responseId: existing.id,
      message: `retracted: ${existing.id}\nform: ${config.id}`,
    };
  });
}

export async function toolVoteForm(store, scope, rules, overrides, args) {
  return mutateFormResponses(store, scope, rules, overrides, args, "vote_form", (responses, { config, actor }) => {
    if (config.votes !== "named") {
      return { refusal: toolError("this form does not collect votes") };
    }
    if (!roleAtLeast(actor.role, config.submit)) {
      return {
        refusal: toolError(
          `permission denied: this form takes votes from ${config.submit}s of this context and above.`
        ),
      };
    }
    const index = responses.findIndex((response) => response.id === args.response_id);
    if (index === -1) return { refusal: toolError("no such response on this form") };

    const wants = args.vote === undefined ? "up" : args.vote;
    const existing = responses[index];
    const others = existing.votes.filter((voter) => voter !== actor.name);
    // Idempotent in both directions: voting twice is one vote, and taking back
    // a vote you never cast is not an error, it is the state you asked for.
    const votes = wants === "up" ? [...others, actor.name] : others;

    const next = responses.slice();
    next[index] = { ...existing, votes };
    return {
      responses: next,
      responseId: existing.id,
      message:
        `${wants === "up" ? "voted" : "vote withdrawn"}: ${existing.id}\n` +
        `form: ${config.id}\nvotes: ${votes.length}`,
    };
  });
}
