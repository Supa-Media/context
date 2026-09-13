/**
 * A ```` ```form ```` fence, drawn as a form you can fill in.
 *
 * This is the half of markdown forms a person sees. The other half — the
 * grammar, the validation, the response renderer — is `apps/mcp/src/forms.js`,
 * and **it is imported rather than reimplemented**. Nothing here knows what
 * keys a block accepts or how long a `line` may be; it asks. A second grammar
 * living in the editor would drift from the one the gateway and the control
 * plane enforce, and the drift would show up as a form that fills in happily
 * and is refused on submit, which is the worst place to find out.
 *
 * That import reaches across the workspace (`apps/mcp` from `apps/mobile`) and
 * is deliberate: `forms.js` is pure, zero-dependency, Workers-safe JavaScript
 * with no DOM and no store, the monorepo root is already a Metro watch folder,
 * and `apps/convex/functions/lib/formOps.ts` reaches for exactly the same file
 * for exactly the same reason. Three surfaces, one grammar.
 *
 * ## When the form is drawn rather than shown as source
 *
 * **`state.readOnly`, and nothing else.** That is the eye in the note's
 * trailing group, and it is also every note a `member` opens, since the editor
 * is already read-only for a role that cannot write.
 *
 * The rule falls out of `livePreview.ts`'s central one — you cannot edit syntax
 * you cannot see — rather than being an exception to it. Everywhere else that
 * rule is served by revealing markup when the caret touches it, and a form
 * cannot do that: filling in a field *is* putting a caret somewhere, so a form
 * that reveals on selection is a form that turns back into a code fence the
 * instant you try to use it. Read mode has no caret to reveal for
 * (`revealSelection` returns nothing when `readOnly`), so the two rules stop
 * competing: editing shows you the source, reading shows you the form.
 *
 * ## A block that does not parse says so, and stays readable
 *
 * The owner's words: "if the formatting is off then we just show like, hey, we
 * can't display because the formatting is off". So a broken block draws a card
 * naming the reason and the line — never a half-built form with the fields it
 * managed to read, which is the same "inert rather than half-working" rule
 * `docs/decisions/forms.md` states for the gateway. The source is one press of
 * the eye away, which is the only place it can be fixed.
 */

import { syntaxTree } from "@codemirror/language";
import { Facet, type EditorState } from "@codemirror/state";
import { WidgetType } from "@codemirror/view";
import type { SyntaxNode } from "@lezer/common";
import {
  FORM_FENCE_LANG,
  parseFormBlocks,
  parseResponsesFile,
  validateSubmission,
} from "../../../../mcp/src/forms.js";

export { FORM_FENCE_LANG };

/* -------------------------------------------------------------------------- */
/*                         what the grammar hands back                        */
/* -------------------------------------------------------------------------- */

/** One declared field, as `parseFormBlocks` normalizes it. */
export interface FormField {
  readonly name: string;
  readonly type: "line" | "text" | "select" | "number" | "date" | "checkbox";
  readonly required: boolean;
  readonly max?: number;
  readonly min?: number;
  readonly options?: readonly string[];
}

/** One parsed block. The shape `forms.js` produces, named for TypeScript. */
export interface FormConfig {
  readonly id: string;
  readonly responses: string;
  readonly layout: "table" | "sections";
  readonly submit: "member" | "editor" | "owner";
  readonly edit_own: boolean;
  readonly show_responses: boolean;
  readonly votes: "named" | "off";
  readonly fields: readonly FormField[];
}

interface ParsedBlock {
  config?: FormConfig;
  error?: string;
  line: number;
}

interface ParsedResponse {
  readonly id: string;
  readonly by: string;
  readonly at: string;
  readonly values: Readonly<Record<string, string>>;
  readonly votes: readonly string[];
}

/**
 * A fence in the buffer that will be drawn, and what it parsed to.
 *
 * `from`/`to` span both ```` ``` ```` lines, because that is the range the
 * widget stands in for — the same span `HtmlPreview` uses and for the same
 * reason.
 *
 * `source` is the whole fence verbatim and is what `eq` compares on. Holding
 * the text rather than the parsed config is what lets a widget survive a
 * keystroke elsewhere in the note with the answers somebody has typed still in
 * their boxes: CodeMirror keeps the existing DOM when `eq` says the widget has
 * not changed, and a config object is a fresh identity every parse.
 */
export interface FormFence {
  readonly from: number;
  readonly to: number;
  readonly source: string;
  readonly config: FormConfig | null;
  /** Why it cannot be drawn as a form, or `null`. */
  readonly error: string | null;
  /** The line the fence opens on, 1-based, for the error card. */
  readonly line: number;
}

/* -------------------------------------------------------------------------- */
/*                        the surface that can submit                         */
/* -------------------------------------------------------------------------- */

/** What a filled-in form sends. Field names and answers, nothing else. */
export interface FormSubmission {
  readonly formId: string;
  readonly values: ReadonlyArray<{ field: string; value: string }>;
}

/** What comes back, already phrased for the person who pressed the button. */
export interface FormOutcome {
  readonly ok: boolean;
  readonly message: string;
}

export interface FormResponsesOutcome {
  readonly ok: boolean;
  readonly text?: string;
  readonly message: string;
}

export interface FormVote {
  readonly formId: string;
  readonly responseId: string;
  readonly vote: "up" | "none";
}

export interface FormResponseUpdate {
  readonly formId: string;
  readonly responseId: string;
  readonly values: ReadonlyArray<{ field: string; value: string }>;
}

export interface FormResponseRetract {
  readonly formId: string;
  readonly responseId: string;
}

/**
 * The host's half: how a submission leaves this editor.
 *
 * A facet rather than an argument threaded through `decorationsFor`, because
 * the decorations are a pure function of the state and a facet **is** state —
 * so the widget can reach its host without any pass in this file learning to
 * carry one. `null` is a real and supported value: the landing page's demo
 * console has nowhere to send a submission, and a form there draws with its
 * button disabled and says so rather than pretending.
 */
export interface FormHostContext {
  /** Send one submission. Never called with values that fail validation here. */
  submit(submission: FormSubmission): Promise<FormOutcome>;
  /** Read the declared sister file. A refusal reveals nothing about its existence. */
  readResponses?: (responsesPath: string) => Promise<FormResponsesOutcome>;
  /** Add or remove the signed-in person's named vote. */
  vote?: (vote: FormVote) => Promise<FormOutcome>;
  /** Replace the answers on a response, subject to the server's ownership check. */
  update?: (change: FormResponseUpdate) => Promise<FormOutcome>;
  /** Delete a response, subject to the server's ownership check. */
  retract?: (change: FormResponseRetract) => Promise<FormOutcome>;
}

export interface FormHostRef {
  current: FormHostContext | null;
  /** Incremented when the editor replaces one note with another document. */
  generation?: number;
}

export const formHost = Facet.define<FormHostRef, FormHostRef | null>({
  // The first wins rather than the last, so a surface that configures one host
  // cannot have it replaced by an extension added after it.
  combine: (values) => (values.length > 0 ? values[0] : null),
});

/* -------------------------------------------------------------------------- */
/*                            finding the fences                              */
/* -------------------------------------------------------------------------- */

/** The first word of a fence's info string, lower-cased, or `null`. */
function fenceTag(
  doc: { sliceString: (from: number, to: number) => string },
  fence: SyntaxNode,
): string | null {
  const info = fence.getChild("CodeInfo");
  if (info === null) return null;
  const first = doc.sliceString(info.from, info.to).trim().split(/\s+/)[0];
  return first === undefined || first === "" ? null : first.toLowerCase();
}

/**
 * Every `form` fence that should be drawn right now.
 *
 * Pure over the state, like every pass in `livePreview.ts`, and returning `[]`
 * whenever the note is editable — see the module comment for why that is the
 * whole of the reveal rule here.
 *
 * A fence that does not start at the margin is left as text, for the reason
 * `htmlPreviews` gives: a block widget replaces whole lines, and one indented
 * inside a list item does not occupy them.
 *
 * The block is parsed by handing `forms.js` **the fence alone**, not the note.
 * Parsing the note would work and would be wrong by one index the moment a
 * second form appears: `parseFormBlocks` returns blocks in document order and
 * matching them back to tree nodes means counting, which is a second traversal
 * that can disagree with the first. One fence in, one block out, no counting.
 */
export function formFences(state: EditorState, frontEnd = 0): FormFence[] {
  if (!state.readOnly) return [];
  const fences: FormFence[] = [];
  syntaxTree(state).iterate({
    from: 0,
    to: state.doc.length,
    enter(node) {
      if (node.from < frontEnd) return;
      if (node.name !== "FencedCode") return;
      const fence = node.node;
      if (fenceTag(state.doc, fence) !== FORM_FENCE_LANG) return;
      if (
        state.doc.lineAt(fence.from).from !== fence.from ||
        state.doc.lineAt(fence.to).to !== fence.to
      ) {
        return;
      }
      const source = state.doc.sliceString(fence.from, fence.to);
      const line = state.doc.lineAt(fence.from).number;
      fences.push({ ...readFence(source), from: fence.from, to: fence.to, line });
    },
  });
  return fences;
}

/**
 * One fence's text → its config or the reason it is not one.
 *
 * Exported because it is the whole of this file that can be tested without a
 * DOM or a mounted editor, and because it is the seam the differential test
 * uses: what this calls a valid form and what the control plane will accept
 * have to be the same judgement, and they are the same function.
 */
export function readFence(source: string): {
  source: string;
  config: FormConfig | null;
  error: string | null;
} {
  const blocks = parseFormBlocks(source) as ParsedBlock[];
  const block = blocks[0];
  if (block === undefined) {
    // The tree says this is a `form` fence and the grammar found no block in
    // it, which one case produces: a fence closed on the same line it opened.
    return { source, config: null, error: "the form block is empty" };
  }
  if (block.error !== undefined || block.config === undefined) {
    return { source, config: null, error: block.error ?? "this block is not a form" };
  }
  return { source, config: block.config, error: null };
}

/* -------------------------------------------------------------------------- */
/*                                 the widget                                 */
/* -------------------------------------------------------------------------- */

/** The answers currently in the boxes, as the wire wants them. */
function answersFrom(
  config: FormConfig,
  inputs: Map<string, HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>,
): { field: string; value: string }[] {
  const values: { field: string; value: string }[] = [];
  for (const field of config.fields) {
    const input = inputs.get(field.name);
    if (input === undefined) continue;
    if (field.type === "checkbox") {
      values.push({
        field: field.name,
        value: (input as HTMLInputElement).checked ? "yes" : "no",
      });
      continue;
    }
    values.push({ field: field.name, value: input.value });
  }
  return values;
}

/** `[{field, value}]` → `{field: value}`, which is what the validator takes. */
function asRecord(values: ReadonlyArray<{ field: string; value: string }>): Record<string, string> {
  const record: Record<string, string> = {};
  for (const entry of values) record[entry.field] = entry.value;
  return record;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * A form, drawn from its own declaration, that submits.
 *
 * ## Nothing here interprets the note as markup
 *
 * Every string that reaches the DOM — a field name, a select option, the parse
 * error — goes through `textContent`. There is no `innerHTML` in this file and
 * no sanitizer either, for the reason `previewDocument` gives about *its*
 * approach being different: a diagram fence is markup by definition and needs a
 * sandbox, a form block is a small typed grammar and its values are text. A
 * form named `<img onerror=…>` is refused by `FIELD_NAME_RE` long before it
 * gets here, and a select option containing the same is drawn as those
 * characters.
 *
 * ## Why it is interactive when the preview beside it is not
 *
 * `HtmlPreviewWidget` sets `pointer-events: none` so a press falls through to
 * the fence underneath — its whole purpose is to be a picture you can click
 * into and edit. This is the opposite: it exists to be used, its source is
 * reachable by leaving read mode, and `ignoreEvent` returns `true` so a press
 * inside it never moves the caret out from under the person typing.
 */
export class FormWidget extends WidgetType {
  private readonly hostGeneration: number;

  constructor(
    private readonly fence: FormFence,
    private readonly host: FormHostRef | null,
  ) {
    super();
    this.hostGeneration = host?.generation ?? 0;
  }

  /*
    Compared on the fence's text alone — never on the host, and never on the
    parsed config. Load-bearing rather than an optimisation: the decoration set
    is rebuilt on every transaction, and a widget that reported itself new would
    be torn down and rebuilt with every answer in it thrown away. Somebody
    typing a bug report into a `text` field would lose it on the first keystroke
    that reached the document.
  */
  eq(other: FormWidget): boolean {
    return (
      other.fence.source === this.fence.source &&
      other.hostGeneration === this.hostGeneration
    );
  }

  toDOM(): HTMLElement {
    const wrap = el("div", "cm-lp-form");
    if (this.fence.config === null) {
      wrap.classList.add("cm-lp-form-broken");
      wrap.append(
        el("div", "cm-lp-form-broken-title", "This form can’t be displayed"),
        el(
          "div",
          "cm-lp-form-broken-why",
          `The formatting is off: ${this.fence.error ?? "unknown"} (block at line ${this.fence.line}).`,
        ),
        el(
          "div",
          "cm-lp-form-hint",
          "Press the eye to edit the block and fix it.",
        ),
      );
      return wrap;
    }
    return this.drawForm(wrap, this.fence.config);
  }

  private drawForm(wrap: HTMLElement, config: FormConfig): HTMLElement {
    const inputs = new Map<string, HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>();

    wrap.append(this.drawHead(config));

    /*
      The fields in their own box rather than loose in the card, so the card can
      carry a header and a footer with rules between them. The gap is here and
      not as a margin on each row, or the first and last rows fight the box's
      own padding — see the stylesheet.
    */
    const fields = el("div", "cm-lp-form-fields");
    for (const field of config.fields) {
      fields.append(this.drawField(field, config, inputs));
    }
    wrap.append(fields);

    const foot = el("div", "cm-lp-form-foot");
    const button = el("button", "cm-lp-form-submit", "Submit");
    button.type = "button";
    const status = el("div", "cm-lp-form-status");
    // Announced rather than merely drawn: the outcome of a press is the one
    // thing here somebody using a screen reader has no other way to learn.
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    foot.append(button, status);
    wrap.append(foot);

    const say = (message: string, kind: "ok" | "bad" | "quiet"): void => {
      status.textContent = message;
      status.classList.toggle("cm-lp-form-status-ok", kind === "ok");
      status.classList.toggle("cm-lp-form-status-bad", kind === "bad");
      status.classList.toggle("cm-lp-form-status-quiet", kind === "quiet");
    };

    let editingId: string | null = null;
    const edit = (response: ParsedResponse): void => {
      editingId = response.id;
      for (const field of config.fields) {
        const input = inputs.get(field.name);
        if (input === undefined) continue;
        const value = response.values[field.name] ?? "";
        if (input instanceof HTMLInputElement && input.type === "checkbox") {
          input.checked = value === "true";
        } else {
          input.value = value;
          input.dispatchEvent(new Event("input"));
        }
        input.disabled = false;
      }
      button.disabled = false;
      button.textContent = "Save changes";
      say("Editing your response.", "quiet");
      inputs.values().next().value?.focus();
    };

    const reloadResponses = this.drawResponses(wrap, config, edit);

    if (this.host === null) {
      button.disabled = true;
      say("This preview can’t send responses.", "quiet");
      return wrap;
    }

    button.addEventListener("click", () => {
      const host = this.host?.current ?? null;
      if (host === null) {
        say("This preview can’t send responses.", "quiet");
        return;
      }
      const values = answersFrom(config, inputs);
      /*
        Checked here with the *same function* the control plane checks with, so
        "required" and "too long" are answered in the box rather than after a
        round trip — and answered in identical words, because there is one
        implementation of the answer. This is a courtesy, never the guard: the
        real one runs in `formOps.ts` behind the credential barrier, where a
        caller who never loaded this file still meets it.
      */
      const checked = validateSubmission(config, asRecord(values)) as {
        values?: Record<string, string>;
        error?: string;
      };
      if (checked.error !== undefined) {
        say(checked.error, "bad");
        return;
      }

      const responseId = editingId;
      const operation =
        responseId === null
          ? host.submit({ formId: config.id, values })
          : host.update?.({ formId: config.id, responseId, values }) ??
            Promise.resolve({ ok: false, message: "Editing is unavailable here." });
      button.disabled = true;
      say(responseId === null ? "Sending…" : "Saving…", "quiet");
      operation
        .then((outcome) => {
          say(outcome.message, outcome.ok ? "ok" : "bad");
          if (!outcome.ok) {
            button.disabled = false;
            return;
          }
          editingId = null;
          button.textContent = "Submit";
          /*
            The boxes are cleared and the button stays off after a success. A
            form that comes back ready to send again invites the double-press
            that a slow network makes feel necessary, and the response file has
            no idempotency key to save it — two presses are two rows.
          */
          for (const [, input] of inputs) {
            if (input instanceof HTMLInputElement && input.type === "checkbox") {
              input.checked = false;
            } else {
              input.value = "";
            }
            input.disabled = true;
          }
          void reloadResponses();
        })
        .catch((error: unknown) => {
          button.disabled = false;
          say(error instanceof Error ? error.message : "That didn’t send.", "bad");
        });
    });

    return wrap;
  }

  /**
   * The strip that says what this box is and where what you type into it goes.
   *
   * **The destination is the part worth the row.** `responses:` is in the
   * block, so an author sees it; a reader gets a form with a Submit button and
   * no way at all to find out which note their answer lands in — and in a
   * shared workspace that is the one thing they might reasonably want to check
   * before typing. It is the same fact `docs/decisions/forms.md` rests the
   * whole design on ("responses live in a sister file"), and it was invisible
   * on the only surface where it matters.
   *
   * Plain text rather than a link, deliberately. Following one means resolving
   * a path against the open note and navigating, which is `noteLinks`' job and
   * reaches this widget through a ref it has not got. A link that looks
   * followable and is not is worse than the name on its own, so the name is
   * what is drawn — the file is one press of the eye away in the block itself.
   */
  private drawHead(config: FormConfig): HTMLElement {
    const head = el("div", "cm-lp-form-head");
    head.append(el("span", "cm-lp-form-kind", `Form · ${config.id}`));

    const dest = el("span", "cm-lp-form-dest", "Answers go to ");
    dest.append(el("span", "cm-lp-form-dest-path", config.responses));
    head.append(dest);
    return head;
  }

  /**
   * Draw the sister response file only when an ordinary note read succeeds.
   *
   * A missing section does not mean "no responses". It means this viewer
   * cannot read the response note, whether because it is private, missing, or
   * offline. Those cases stay deliberately indistinguishable. Once the read
   * succeeds, the shared parser decides whether the file is valid and every
   * submitted string reaches the DOM through textContent.
   */
  private drawResponses(
    wrap: HTMLElement,
    config: FormConfig,
    edit: (response: ParsedResponse) => void,
  ): () => Promise<void> {
    if (!config.show_responses) return async () => {};
    const section = el("div", "cm-lp-form-responses");
    const host = this.host;
    let generation = 0;
    const read = async (): Promise<void> => {
      const request = ++generation;
      const current = host?.current ?? null;
      if (current?.readResponses === undefined) {
        section.remove();
        return;
      }
      let outcome: FormResponsesOutcome;
      try {
        outcome = await current.readResponses(config.responses);
      } catch {
        if (request === generation) section.remove();
        return;
      }
      if (request !== generation) return;
      if (!outcome.ok || outcome.text === undefined) {
        section.remove();
        return;
      }
      const parsed = parseResponsesFile(outcome.text, config) as {
        responses?: ParsedResponse[];
        error?: string;
      };
      section.replaceChildren(el("div", "cm-lp-form-responses-title", "Responses"));
      if (parsed.error !== undefined || parsed.responses === undefined) {
        section.append(
          el(
            "div",
            "cm-lp-form-responses-status",
            `Responses can’t be displayed: ${parsed.error ?? "the response file is unreadable"}.`,
          ),
        );
        return;
      }
      if (parsed.responses.length === 0) {
        section.append(el("div", "cm-lp-form-responses-status", "No responses yet."));
        return;
      }
      section.append(this.responsesTable(config, parsed.responses, read, edit));
    };

    if (host?.current?.readResponses !== undefined) {
      section.append(el("div", "cm-lp-form-responses-status", "Loading responses…"));
      wrap.append(section);
      void read();
    }
    return read;
  }

  private responsesTable(
    config: FormConfig,
    responses: readonly ParsedResponse[],
    reload: () => Promise<void>,
    edit: (response: ParsedResponse) => void,
  ): HTMLDivElement {
    const scroll = el("div", "cm-lp-form-responses-scroll");
    const table = document.createElement("table");
    table.className = "cm-lp-form-responses-table";
    const head = document.createElement("thead");
    const headings = document.createElement("tr");
    for (const label of [
      ...config.fields.map((field) => field.name.replace(/_/g, " ")),
      "By",
      "At",
    ]) {
      headings.append(el("th", "", label));
    }
    if (config.votes === "named") headings.append(el("th", "", "Votes"));
    if (config.edit_own) headings.append(el("th", "", "Actions"));
    head.append(headings);
    table.append(head);

    const body = document.createElement("tbody");
    for (const response of responses) {
      const row = document.createElement("tr");
      for (const field of config.fields) {
        row.append(el("td", "", response.values[field.name] ?? ""));
      }
      row.append(el("td", "", response.by), el("td", "", response.at));
      if (config.votes === "named") {
        const cell = document.createElement("td");
        const voters = el(
          "div",
          "cm-lp-form-voters",
          response.votes.length === 0 ? "No votes" : response.votes.join(", "),
        );
        cell.append(voters);
        const vote = this.host?.current?.vote;
        if (vote !== undefined) {
          const controls = el("div", "cm-lp-form-vote-controls");
          const add = el("button", "cm-lp-form-vote", "Upvote");
          const remove = el(
            "button",
            "cm-lp-form-vote cm-lp-form-vote-remove",
            "Remove vote",
          );
          add.type = remove.type = "button";
          const run = async (next: "up" | "none"): Promise<void> => {
            add.disabled = remove.disabled = true;
            const outcome = await (this.host?.current?.vote?.({
              formId: config.id,
              responseId: response.id,
              vote: next,
            }) ?? Promise.resolve({ ok: false, message: "Voting is unavailable." }));
            if (outcome.ok) await reload();
            else {
              voters.textContent = outcome.message;
              add.disabled = remove.disabled = false;
            }
          };
          add.addEventListener("click", () => void run("up"));
          remove.addEventListener("click", () => void run("none"));
          controls.append(add, remove);
          cell.append(controls);
        }
        row.append(cell);
      }
      if (config.edit_own) {
        const cell = document.createElement("td");
        const controls = el("div", "cm-lp-form-response-controls");
        if (this.host?.current?.update !== undefined) {
          const change = el("button", "cm-lp-form-response-action cm-lp-form-edit", "Edit");
          change.type = "button";
          change.addEventListener("click", () => edit(response));
          controls.append(change);
        }
        const retract = this.host?.current?.retract;
        if (retract !== undefined) {
          const remove = el(
            "button",
            "cm-lp-form-response-action cm-lp-form-delete",
            "Delete",
          );
          remove.type = "button";
          let confirmed = false;
          remove.addEventListener("click", () => {
            if (!confirmed) {
              confirmed = true;
              remove.textContent = "Confirm delete";
              return;
            }
            remove.disabled = true;
            void retract({ formId: config.id, responseId: response.id })
              .then((outcome) => {
                if (outcome.ok) void reload();
                else {
                  remove.disabled = false;
                  remove.textContent = outcome.message;
                }
              })
              .catch((error: unknown) => {
                remove.disabled = false;
                remove.textContent =
                  error instanceof Error ? error.message : "That response wasn’t deleted.";
              });
          });
          controls.append(remove);
        }
        cell.append(controls);
        row.append(cell);
      }
      body.append(row);
    }
    table.append(body);
    scroll.append(table);
    return scroll;
  }

  private drawField(
    field: FormField,
    config: FormConfig,
    inputs: Map<string, HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>,
  ): HTMLElement {
    const row = el("div", "cm-lp-form-row");
    const id = `cm-form-${config.id}-${field.name}`;

    /*
      The label and the character count share one line above the box. The count
      used to sit under it, which put the limit *after* the control it applies
      to — you found out how much room you had by running out of it — and cost
      a whole row per field in a card that is already a stack of rows.
    */
    const top = el("div", "cm-lp-form-top");

    const label = el("label", "cm-lp-form-label");
    label.htmlFor = id;
    label.textContent = field.name.replace(/_/g, " ");
    if (field.required) {
      const mark = el("span", "cm-lp-form-required", "· required");
      label.append(" ", mark);
    }
    top.append(label);
    row.append(top);

    const input = buildInput(field);
    input.id = id;
    input.className = "cm-lp-form-input";
    if (field.required) input.setAttribute("aria-required", "true");
    inputs.set(field.name, input);
    row.append(input);

    /*
      The limit is shown, not only enforced. `max` is required on `line` and
      `text` precisely so the person filling one in knows the room they have,
      and `maxlength` alone is a box that silently stops accepting characters.
    */
    if ((field.type === "line" || field.type === "text") && field.max !== undefined) {
      const count = el("div", "cm-lp-form-count", `0 / ${field.max}`);
      const update = (): void => {
        // Code points, matching the validator's `[...value].length` — an emoji
        // is one character to somebody typing and two to `String.length`.
        count.textContent = `${[...input.value].length} / ${field.max}`;
      };
      input.addEventListener("input", update);
      // Onto the label's line, beside the name it is a limit on.
      top.append(count);
    }
    return row;
  }
}

function buildInput(
  field: FormField,
): HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement {
  switch (field.type) {
    case "text": {
      const area = document.createElement("textarea");
      area.rows = 4;
      if (field.max !== undefined) area.maxLength = field.max;
      return area;
    }
    case "select": {
      const select = document.createElement("select");
      /*
        An empty first option unless the field is required, so "no answer" is a
        position somebody can choose rather than one they can only reach by
        never touching the control. A required select has no such position and
        starts on its first real option.
      */
      if (!field.required) select.append(new Option("—", ""));
      for (const option of field.options ?? []) select.append(new Option(option, option));
      return select;
    }
    case "checkbox": {
      const box = document.createElement("input");
      box.type = "checkbox";
      return box;
    }
    case "number": {
      const number = document.createElement("input");
      number.type = "number";
      if (field.min !== undefined) number.min = String(field.min);
      if (field.max !== undefined) number.max = String(field.max);
      return number;
    }
    case "date": {
      const date = document.createElement("input");
      date.type = "date";
      return date;
    }
    default: {
      const line = document.createElement("input");
      line.type = "text";
      if (field.max !== undefined) line.maxLength = field.max;
      return line;
    }
  }
}
