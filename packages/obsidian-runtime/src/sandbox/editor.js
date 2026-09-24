// @ts-check
/**
 * The one-line/whole-note editor shim: editorFor, settling a plugin's async work, and withActiveEditor's read/run/settle/write-back.
 *
 * Moved verbatim out of `pluginSandboxDocument()` in ../sandbox.js; this is
 * source text for the sandboxed document, not code that runs in this realm.
 */
export const EDITOR_JS = `  /**
   * The document a plugin edits, with a caret it can write at.
   *
   * ## Why there is a caret at all
   *
   * Obsidian's Editor has one, and the whole of "insert this here" is written
   * against it: onChooseSuggestion ends in replaceRange(text, editor.getCursor())
   * and an editorCallback ends in replaceSelection(text). Neither existed here,
   * so both were a TypeError inside a handler nobody awaits — nothing on screen,
   * nothing in the log, the exact shape of "I click the verse and nothing
   * happens".
   *
   * ## Where it starts, and why that is honest rather than a guess
   *
   * At the position the host named, and at the END OF THE DOCUMENT when it
   * named none. The console's real caret lives in a CodeMirror view in the
   * trusted realm; the two places a plugin writes from — a command pressed on
   * the plugins pane and a dialog it opened — are both places where the reader
   * is not in the note at all, so there is no caret to carry. Appending is the
   * one answer that is always visible and never silently overwrites something
   * they were looking at.
   *
   * A suggestion is the case where the host DOES know: it is answering for a
   * line somebody is typing, and it passes that offset in.
   */
  function editorFor(text, startCh) {
    let value = String(text);
    let revision = 0;
    const lines = () => value.split('\\n');
    const clamp = at => Math.max(0, Math.min(value.length, Number.isFinite(at) ? at : value.length));
    const offset = position => {
      const all = lines();
      const line = Math.max(0, Math.min(all.length - 1, Number(position && position.line) || 0));
      const ch = Math.max(0, Math.min(all[line].length, Number(position && position.ch) || 0));
      let found = ch;
      for (let index = 0; index < line; index += 1) found += all[index].length + 1;
      return found;
    };
    const positionAt = at => {
      const before = value.slice(0, clamp(at)).split('\\n');
      return { line: before.length - 1, ch: before[before.length - 1].length };
    };
    /*
      Anchor and head as offsets rather than positions, because every edit moves
      them: an offset survives a change above it by arithmetic, where a
      {line, ch} would have to be re-derived and would silently drift.
    */
    let anchor = clamp(startCh === undefined ? value.length : Number(startCh));
    let head = anchor;
    /*
      Where the caret lands after a change. A replacement entirely after it
      leaves it alone, one before it shifts it by the difference, and one that
      covers it leaves it at the end of what was inserted — which is where
      somebody who just inserted a verse expects to carry on typing.

      An insertion exactly AT the caret counts as covering it, deliberately:
      that is what typing does, and a caret left in front of the text it just
      inserted would make a plugin's second insertion land before its first.
    */
    const moved = (at, start, end, length) => {
      if (at < start) return at;
      if (at >= end) return at + (length - (end - start));
      return start + length;
    };
    const splice = (start, end, replacement) => {
      const text = String(replacement === undefined || replacement === null ? '' : replacement);
      value = value.slice(0, start) + text + value.slice(end);
      anchor = moved(anchor, start, end, text.length);
      head = moved(head, start, end, text.length);
      revision += 1;
    };
    const editor = {
      lineCount() { return lines().length; },
      lastLine() { return lines().length - 1; },
      getLine(line) { return lines()[line] || ''; },
      setLine(line, text) {
        const start = offset({ line, ch: 0 });
        splice(start, start + (lines()[line] || '').length, text);
      },
      getValue() { return value; },
      setValue(next) {
        value = String(next);
        anchor = clamp(anchor);
        head = clamp(head);
        revision += 1;
      },
      getRange(from, to) { return value.slice(offset(from), offset(to)); },
      replaceRange(replacement, from, to) {
        const start = offset(from);
        const end = offset(to || from);
        splice(Math.min(start, end), Math.max(start, end), replacement);
      },
      /*
        Obsidian's own vocabulary for the caret and the selection. 'from' and
        'to' are the ends in document order, 'anchor' and 'head' are where the
        selection started and where it is being dragged to, and a bare
        getCursor() is the head — which is what a plugin inserting at the caret
        means by it.
      */
      getCursor(which) {
        if (which === 'from') return positionAt(Math.min(anchor, head));
        if (which === 'to') return positionAt(Math.max(anchor, head));
        if (which === 'anchor') return positionAt(anchor);
        return positionAt(head);
      },
      setCursor(position, ch) {
        const at = typeof position === 'number' ? offset({ line: position, ch: ch || 0 }) : offset(position);
        anchor = at;
        head = at;
      },
      setSelection(from, to) {
        anchor = offset(from);
        head = to === undefined ? anchor : offset(to);
      },
      getSelection() { return value.slice(Math.min(anchor, head), Math.max(anchor, head)); },
      somethingSelected() { return anchor !== head; },
      listSelections() { return [{ anchor: positionAt(anchor), head: positionAt(head) }]; },
      replaceSelection(replacement) {
        splice(Math.min(anchor, head), Math.max(anchor, head), replacement);
      },
      posToOffset(position) { return offset(position); },
      offsetToPos(at) { return positionAt(at); },
      // Obsidian's Editor answers getDoc() with something carrying the same
      // methods; a plugin written against CodeMirror's shape reaches for it and
      // then calls replaceRange on what comes back.
      getDoc() { return editor; },
      focus() {},
      blur() {},
      hasFocus() { return false; },
      refresh() {},
      revision() { return revision; },
    };
    return editor;
  }

  async function settleEditorWork(editor) {
    let previous = -1;
    for (let turn = 0; turn < 20; turn += 1) {
      await requestsIdle();
      await new Promise(resolve => setTimeout(resolve, 0));
      const current = editor.revision();
      if (inFlightRequests === 0 && current === previous) return;
      previous = current;
    }
    throw new Error('Plugin command did not settle');
  }

  /**
   * Run one piece of the plugin's work with the open note in front of it.
   *
   * Read, run, settle, write back — the shape the editorCallback path already
   * had, lifted out so a dialog choice and a plain command get it too. What it
   * adds is the view: while run() is on the stack, getActiveViewOfType answers
   * with an editor over the bytes just read, so a plugin that inserts at the
   * cursor inserts into the note the reader has open.
   *
   * The file is pinned before the first await. The owner may open another note
   * while a plugin's network work is in flight, and the result belongs to the
   * note the work started on.
   *
   * required is the editorCallback case: a command that takes an editor has
   * nothing to do without one, so no note open is its error rather than a
   * quieter run. Everything else runs regardless — a command that only shows a
   * notice must not start failing because nothing is open — and reports
   * afterwards whether the plugin went looking for an editor it did not get.
   *
   * Returns null when there was nothing to report, or one of a closed set of
   * reasons the caller can turn into a sentence. The strings a plugin or a
   * refusal produces stay in here: the console says what it means itself.
   */
  async function withActiveEditor(run, required) {
    /*
      Whether the plugin asked for a view is a question about THIS piece of
      work, so the flag is saved and restored: a command that opens a dialog
      and a pick made inside it are two runs, and the first one's asking must
      not answer for the second.
    */
    const wasAsked = viewAsked;
    viewAsked = false;
    const previous = activeEditor;
    let target = activeFile;
    /*
      THE VERSION THIS RUN READ, PINNED BESIDE THE TEXT IT READ.

      vault.read stamps the etag onto the TFile and vault.modify takes it back
      off, which is the right shape for a plugin holding a file and no idea
      what an etag is — and the wrong one here, because activeFile is ONE
      object shared by every run. Two pieces of this plugin's work overlap the
      moment one of them awaits: a ribbon press while a command is fetching, or
      a pick inside a dialog that command opened, which is why viewAsked above
      is saved and restored rather than simply cleared. The second run to
      finish re-stamped the file with the etag its own write produced, and the
      first then wrote with a version it had never read. The conditional write
      was satisfied, the second run's edit was gone, and nothing anywhere said
      so — a lost write with no error, which is the one failure mode this
      product does not get to have.

      So the read is made here rather than through vault.read: the text and the
      etag come off ONE result object, with no shared state between them.

      Taking the pin off target.etag AFTER the await instead would close the
      case above just as well, and the test for it cannot tell the two apart —
      measured, that version reddens nothing. It is not what is written here,
      for a reason that is an argument rather than a demonstration: another
      run's read can stamp that field in the microtask between this read
      resolving and the next line running, and a pinned value whose provenance
      is still the shared object is the same class of mistake one layer down.
      One result object costs nothing and has no such window.

      The stamp onto the shared file is kept, because plugin code that reads
      the open note through Context and then modifies it itself still expects
      to find a version there.
    */
    let pinnedEtag = target !== null && typeof target.etag === 'string' ? target.etag : null;
    let before = null;
    /** Why there is no editor, when the read is what took it away. */
    let denied = null;
    if (target !== null) {
      try {
        const opened = await request({ kind: 'vault.read', path: target.path });
        before = opened && typeof opened.text === 'string' ? opened.text : '';
        if (opened && typeof opened.etag === 'string') pinnedEtag = opened.etag;
        if (typeof pinnedEtag === 'string') target.etag = pinnedEtag;
      } catch (error) {
        if (required) throw error;
        // A plugin with no read grant still gets to run; it simply has no
        // editor, and this is only said below if it went looking for one.
        before = null;
        target = null;
        denied = reasonFor(error);
      }
    }
    if (required && before === null) throw new Error('Open a note before running this command');
    const editor = before === null ? null : editorFor(before);
    activeEditor = editor === null
      ? null
      : { file: target, editor, view: new MarkdownView(app, target, editor) };
    let reason = null;
    try {
      /*
        What the plugin's own code throws travels on rather than becoming a
        reason. The caller knows what to do with it — a command reports the
        message on its own card, the way it always has — and flattening it here
        would throw away the one sentence that says what broke. Only the read
        and the write-back, which are Context's half of this, become a word.

        A throw also skips the write-back, which is the editorCallback path's
        existing rule: half of an edit a plugin abandoned is not an edit
        anybody asked for.
      */
      await run(editor);
      if (editor !== null && (required || editor.revision() > 0)) await settleEditorWork(editor);
      if (editor !== null) {
        const after = editor.getValue();
        if (after !== before) {
          // The pinned version, never the file's current one — see above.
          const version = { path: target.path, etag: pinnedEtag };
          try {
            await vault.modify(version, after);
            if (typeof version.etag === 'string') target.etag = version.etag;
          } catch (error) {
            if (required) throw error;
            reason = reasonFor(error);
          }
        }
      }
      // Nowhere to write is a failure only for a plugin that went looking.
      if (reason === null && editor === null && viewAsked) {
        reason = denied === null ? 'no-note' : denied;
      }
    } finally {
      activeEditor = previous;
      viewAsked = wasAsked;
    }
    return reason;
  }

  /*
    Why a piece of work did not land, as one of three words rather than as
    whatever string came back.

    CAPABILITY_DENIED is the one worth telling apart: it is not a malfunction,
    it is the owner not having turned this plugin's write on, and it is the one
    the reader can do something about. Everything else is the plugin failing,
    and the message it failed with belongs in the console's log rather than in
    a banner the plugin would then be writing.
  */
  function reasonFor(error) {
    return error && error.code === 'CAPABILITY_DENIED' ? 'not-allowed' : 'failed';
  }

`;
