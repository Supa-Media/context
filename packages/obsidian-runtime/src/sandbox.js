// @ts-check

/**
 * The document that executes one reviewed plugin bundle.
 *
 * The bundle never enters this string. The trusted host sends it only after the
 * frame has loaded, which means plugin text cannot break out of an HTML or
 * script delimiter while the sandbox is being constructed. The frame has an
 * opaque origin (`sandbox="allow-scripts"`, without `allow-same-origin`) and a
 * CSP that denies every ambient network and child-execution surface. All note
 * access therefore has to cross the small postMessage protocol below.
 */
export function pluginSandboxDocument() {
  return `<!doctype html>
<html><head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'none'; img-src data:; media-src 'none'; font-src 'none'; child-src 'none'; worker-src 'none'; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'">
</head><body><script>
(() => {
  'use strict';
  const VERSION = 1;
  let nonce = null;
  let instance = null;
  let counter = 0;
  const pending = new Map();
  let inFlightRequests = 0;
  const requestIdleWaiters = [];
  const disposers = [];
  const commands = new Map();
  // The note the console has open, as last told by the host. Path and etag
  // only: no content crosses this boundary, and a plugin that wants the body
  // asks for it through the same audited read as any other file.
  let activeFile = null;
  // name -> Set(callback). One registry for vault, metadata and workspace
  // events, keyed by the name Obsidian uses, so on() can return a real
  // reference with a working off() instead of the dead handle it used to.
  const listeners = new Map();
  function subscribe(name, callback) {
    if (typeof callback !== 'function') return { off() {} };
    if (!listeners.has(name)) listeners.set(name, new Set());
    listeners.get(name).add(callback);
    return { off() { const set = listeners.get(name); if (set) set.delete(callback); } };
  }
  function emit(name, ...args) {
    const set = listeners.get(name);
    if (!set) return;
    // A copy, because a handler that calls off() during dispatch would
    // otherwise mutate the set being iterated.
    for (const callback of [...set]) {
      try { callback(...args); } catch (_) {}
    }
  }
  const post = payload => {
    if (window.ReactNativeWebView && typeof window.ReactNativeWebView.postMessage === 'function') {
      window.ReactNativeWebView.postMessage(JSON.stringify(payload));
    } else {
      window.parent.postMessage(payload, '*');
    }
  };

  function send(type, fields) {
    if (nonce === null) return;
    post(Object.assign({ source: 'context-plugin-sandbox', version: VERSION, nonce, type }, fields || {}));
  }

  function request(operation) {
    const requestId = 'p_' + Date.now().toString(36) + '_' + (++counter).toString(36);
    inFlightRequests += 1;
    return new Promise((resolve, reject) => {
      pending.set(requestId, { resolve, reject });
      send('rpc', { request: { version: VERSION, requestId, operation } });
    }).finally(() => {
      inFlightRequests -= 1;
      if (inFlightRequests !== 0) return;
      while (requestIdleWaiters.length) requestIdleWaiters.shift()();
    });
  }

  function requestsIdle() {
    return inFlightRequests === 0
      ? Promise.resolve()
      : new Promise(resolve => requestIdleWaiters.push(resolve));
  }

  class TFile {
    constructor(path, stat) {
      this.path = path;
      this.name = path.split('/').pop() || path;
      const dot = this.name.lastIndexOf('.');
      this.basename = dot > 0 ? this.name.slice(0, dot) : this.name;
      this.extension = dot > 0 ? this.name.slice(dot + 1) : '';
      this.stat = stat || { ctime: 0, mtime: 0, size: 0 };
      this.parent = null;
    }
  }

  class TFolder {
    constructor(path) {
      this.path = path;
      this.name = path.split('/').pop() || path;
      this.children = [];
      this.parent = null;
    }
  }

  function file(path, row) {
    const value = new TFile(path, row && row.stat);
    if (row && typeof row.etag === 'string') value.etag = row.etag;
    return value;
  }

  const vault = {
    async getFiles() {
      const found = [];
      const folders = [''];
      while (folders.length) {
        const prefix = folders.shift();
        const result = await request({ kind: 'vault.list', prefix });
        const rows = Array.isArray(result) ? result : (result && result.entries) || [];
        for (const row of rows) {
          if (!row || typeof row.path !== 'string') continue;
          if (row.kind === 'folder') folders.push(row.path);
          else if (row.kind === 'file') found.push(file(row.path, row));
        }
      }
      return found;
    },
    getMarkdownFiles() { return this.getFiles().then(rows => rows.filter(one => one.extension === 'md')); },
    getAbstractFileByPath(path) { return path && !path.endsWith('/') ? file(path) : new TFolder(path || ''); },
    async read(target) {
      const result = await request({ kind: 'vault.read', path: target.path });
      if (target && result && typeof result.etag === 'string') target.etag = result.etag;
      return result && typeof result.text === 'string' ? result.text : '';
    },
    cachedRead(target) { return this.read(target); },
    async create(path, text) {
      const result = await request({ kind: 'vault.create', path, text });
      return file(path, result);
    },
    async modify(target, text) {
      if (!target || typeof target.etag !== 'string') throw new Error('Context requires the current file version before a plugin may modify it');
      const result = await request({ kind: 'vault.modify', path: target.path, text, expectedEtag: target.etag });
      if (result && typeof result.etag === 'string') target.etag = result.etag;
    },
    async rename(target, to) {
      if (!target || typeof target.etag !== 'string') throw new Error('Context requires the current file version before a plugin may rename it');
      await request({ kind: 'vault.rename', from: target.path, to, expectedEtag: target.etag });
      target.path = to;
    },
    async delete(target) {
      if (!target || typeof target.etag !== 'string') throw new Error('Context requires the current file version before a plugin may delete it');
      await request({ kind: 'vault.delete', path: target.path, expectedEtag: target.etag });
    },
    on(name, callback) { return subscribe('vault:' + name, callback); },
    off(name, callback) { const set = listeners.get('vault:' + name); if (set) set.delete(callback); },
  };

  const metadataCache = {
    async getFileCache(target) { return request({ kind: 'metadata.get', path: target.path }); },
    on(name, callback) { return subscribe('metadata:' + name, callback); },
    off(name, callback) { const set = listeners.get('metadata:' + name); if (set) set.delete(callback); },
  };

  const workspace = {
    on(name, callback) { return subscribe('workspace:' + name, callback); },
    off(name, callback) { const set = listeners.get('workspace:' + name); if (set) set.delete(callback); },
    getActiveFile() { return activeFile; },
    getActiveViewOfType() { return null; },
    getLeavesOfType() { return []; },
  };

  // Obsidian keeps these aliases for plugins written against its augmented
  // JavaScript realm. They change no authority; they only keep a plugin from
  // failing before its first capability-checked call.
  if (typeof Array.prototype.contains !== 'function') {
    Object.defineProperty(Array.prototype, 'contains', {
      value(value) { return this.includes(value); }, writable: true, configurable: true,
    });
  }
  if (typeof Array.prototype.first !== 'function') {
    Object.defineProperty(Array.prototype, 'first', {
      value() { return this.length === 0 ? undefined : this[0]; }, writable: true, configurable: true,
    });
  }
  if (typeof String.prototype.contains !== 'function') {
    Object.defineProperty(String.prototype, 'contains', {
      value(value) { return this.includes(value); }, writable: true, configurable: true,
    });
  }

  /*
    Obsidian augments HTMLElement itself, and a plugin calls these on whatever
    it is handed: statusBarItem.setText(...), containerEl.createEl('div', ...).
    Without them an element the shim returns is one a plugin cannot write to —
    which would make addStatusBarItem reachable and useless, the exact failure
    SUPPORTED_MEMBERS was split in two to stop claiming.

    Installed only where the realm has no such member already, so a browser that
    grows one of these names keeps its own.
  */
  const elementApi = {
    setText(value) { this.textContent = value === null || value === undefined ? '' : String(value); return this; },
    appendText(value) { this.appendChild(document.createTextNode(String(value))); return this; },
    setAttr(name, value) { this.setAttribute(String(name), String(value)); return this; },
    addClass(...names) { for (const name of names) this.classList.add(String(name)); return this; },
    removeClass(...names) { for (const name of names) this.classList.remove(String(name)); return this; },
    toggleClass(names, on) {
      for (const name of Array.isArray(names) ? names : [names]) this.classList.toggle(String(name), !!on);
      return this;
    },
    empty() { while (this.firstChild) this.removeChild(this.firstChild); return this; },
    detach() { this.remove(); return this; },
    createEl(tag, options) {
      const child = document.createElement(String(tag));
      const given = options || {};
      if (given.cls) child.addClass(...(Array.isArray(given.cls) ? given.cls : String(given.cls).split(' ').filter(Boolean)));
      if (given.text !== undefined) child.textContent = String(given.text);
      if (given.attr) for (const name of Object.keys(given.attr)) child.setAttribute(name, String(given.attr[name]));
      for (const name of ['href', 'type', 'placeholder', 'title', 'value']) {
        if (given[name] !== undefined) child[name] = given[name];
      }
      this.appendChild(child);
      return child;
    },
    createDiv(options) { return this.createEl('div', options); },
    createSpan(options) { return this.createEl('span', options); },
  };
  for (const name of Object.keys(elementApi)) {
    if (typeof HTMLElement.prototype[name] === 'function') continue;
    Object.defineProperty(HTMLElement.prototype, name, {
      value: elementApi[name], writable: true, configurable: true,
    });
  }

  /*
    AND THE SAME THREE AS GLOBALS, WHICH IS A SEPARATE FACT.

    Obsidian exposes createEl, createDiv and createSpan as globals as well as
    methods, and a plugin builds a *detached* element with the global form.
    YouVersion's read preview opens with exactly that:

        const popup = createDiv({ cls: 'preview-youversion' });

    Without them that line is a ReferenceError inside an async callback nobody
    awaits — so the request still goes out, the rejection is swallowed, and the
    preview simply never appears. A failure with no error anywhere is the shape
    this package keeps being bitten by, so the globals are part of the preview
    slice rather than a nicety beside it.

    Detached on purpose: the element is built, handed back, and never attached
    to this document by us. A plugin that wants it in a document puts it there.
  */
  function createEl(tag, options) {
    const host = document.createElement('div');
    const child = host.createEl(tag, options);
    host.removeChild(child);
    return child;
  }
  function createDiv(options) { return createEl('div', options); }
  function createSpan(options) { return createEl('span', options); }
  for (const [name, value] of [['createEl', createEl], ['createDiv', createDiv], ['createSpan', createSpan]]) {
    if (typeof window[name] === 'function') continue;
    Object.defineProperty(window, name, { value, writable: true, configurable: true });
  }

  /*
    THE STATUS BAR: THE TEXT CROSSES, THE ELEMENT DOES NOT.

    A plugin gets a real element and writes into it however it likes. What
    reaches the console is the text that ended up in it, and the console draws
    that with its own components in its own theme — so a plugin cannot style,
    position or script anything on the trusted side, and the sandbox stays the
    only place its DOM exists.

    Reported as a whole list on every change rather than an add and a remove.
    A guest that is torn down or throws mid-render never owes the host a removal
    message it might not send, so the console's copy cannot drift from this one.
    The host's parser carries the same reasoning from its side.

    The cap is interpolated from the host's own constant rather than written
    twice. Two numbers meant to agree, in one file, with nothing linking them is
    how the supported-members list drifted by twenty names.

    Kept out of the layout with display:none: nothing here is meant to be seen
    in the frame, which is 1x1 and invisible anyway, and a later change that
    makes a frame visible must not start drawing this by accident.
  */
  const statusRoot = document.createElement('div');
  statusRoot.style.display = 'none';
  const statusIds = new WeakMap();
  let statusCount = 0;
  let statusWatch = null;
  let statusSent = null;
  function reportStatusBar() {
    const items = [];
    for (const el of Array.from(statusRoot.children)) {
      const id = statusIds.get(el);
      if (typeof id !== 'string') continue;
      // Collapsed and bounded here as well as on the host: a status bar item
      // is a line in a card, and a plugin that puts a paragraph in one should
      // not be able to decide how tall somebody's console is.
      const text = String(el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 120);
      if (text === '') continue;
      items.push({ id, text });
      if (items.length >= ${STATUS_BAR_MAX}) break;
    }
    // The observer fires on any mutation, and plenty of them leave the text
    // exactly as it was: a plugin that empties an item and rebuilds it with the
    // same words has changed its DOM twice and said nothing. Sending only what
    // is new keeps a plugin re-rendering on a timer from re-rendering the
    // console with it.
    const encoded = JSON.stringify(items);
    if (encoded === statusSent) return;
    statusSent = encoded;
    send('status-bar', { items });
  }

  /*
    EDITOR SUGGESTIONS: A ROUND TRIP OVER ONE LINE, AND NOTHING ELSE CROSSES.

    registerEditorSuggest is how a plugin offers an in-editor completion —
    YouVersion Linker's whole primary interaction, the list you get from typing
    @ John 1:1. Obsidian mounts the suggester into its editor; Context cannot,
    because that puts third-party callbacks and DOM in the trusted realm, which
    docs/decisions/plugins.md rules out.

    So the interaction is inverted. The host asks *"here is the line and where
    the cursor is — do you want to suggest?"*; the guest runs the plugin's own
    onTrigger and getSuggestions against a one-line editor, renders each
    suggestion into an element **in here**, and reports what those elements say.
    The host draws its own list. On a pick, the plugin's selectSuggestion runs
    against the same one-line editor and the guest reports the line it produced
    — the *trusted editor* then makes that edit through its own editing path.

    Two consequences worth stating, because they are the reason this shape was
    chosen over the obvious one:

    - **A suggester needs no write grant.** The edit is the person typing, made
      by their own editor, undoable like anything else they typed. Nothing here
      touches vault.modify.
    - **The line is note content**, so the *host* decides whether a plugin may
      be asked at all. That gate is maySeeContent on the trusted side; the
      guest cannot be trusted to filter what it is handed.
  */
  const suggesters = [];
  const SUGGEST_MAX = 8;
  // The offer the last query produced: which suggester made it, the values it
  // returned, and the editor it was computed against. Replaced by the next
  // query, so an apply can only ever land on what is currently on screen.
  let offered = null;
  /*
    The dialog a plugin has open, if any: the modal itself and the values its
    last query produced. One at a time, replaced by the next open(), so a pick
    can only ever land on what is currently on screen — the rule offered keeps
    for the editor's own suggestions, applied to this.
  */
  let openModal = null;
  /*
    The plain text dialog a plugin has open, if any. Separate from openModal
    because they are different dialogs with different protocols — one asks the
    reader to choose, one only shows them something — and one variable for both
    would make close() have to guess which it was closing.
  */
  let openTextModal = null;
  const TEXT_MODAL_TITLE_MAX = 200;
  /*
    Enough for a passage, and a ceiling rather than a guess: what crosses is one
    postMessage per mutation of the dialog's own DOM, so a plugin that builds a
    large document into contentEl would otherwise send it repeatedly.
  */
  const TEXT_MODAL_TEXT_MAX = 8000;

  async function answerSuggest(message) {
    const line = typeof message.line === 'string' ? message.line : '';
    const ch = Math.max(0, Math.min(line.length, Number(message.ch) || 0));
    const editor = editorFor(line);
    const cursor = { line: 0, ch };
    offered = null;
    for (const suggester of suggesters) {
      let context = null;
      try { context = suggester.onTrigger(cursor, editor, activeFile); } catch (_) { context = null; }
      if (!context) continue;
      suggester.context = Object.assign({ editor, file: activeFile }, context);
      let values = [];
      try { values = await suggester.getSuggestions(suggester.context); } catch (_) { values = []; }
      if (!Array.isArray(values)) values = [];
      const items = [];
      for (const value of values.slice(0, SUGGEST_MAX)) {
        const el = document.createElement('div');
        try { suggester.renderSuggestion(value, el); } catch (_) {}
        const text = String(el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 200);
        items.push({ text });
      }
      offered = { suggester, values: values.slice(0, SUGGEST_MAX), editor, line };
      send('suggest-results', { seq: message.seq, items });
      return;
    }
    send('suggest-results', { seq: message.seq, items: [] });
  }

  async function applySuggest(message) {
    if (offered === null) return;
    const index = Number(message.index);
    const value = offered.values[index];
    if (value !== undefined) {
      // Awaited directly rather than through settleEditorWork: a selection is
      // one edit on one line, and the loop that exists for a command's network
      // round trips would make a keystroke wait on timers it does not need.
      // An async selectSuggestion still resolves here; a throwing one is the
      // plugin's failure and leaves the line as it was.
      try { await offered.suggester.selectSuggestion(value, {}); } catch (_) {}
    }
    send('suggest-applied', { seq: message.seq, line: offered.editor.getValue().slice(0, 4000) });
  }

  /*
    What the open dialog would show for this query.

    The same shape as answerSuggest: the plugin's own getSuggestions runs in
    here, each value is rendered into an element in here, and only the text
    those elements carry is sent. limit is the plugin's own if it set one,
    clamped, because a plugin asking for three hundred rows is still a list the
    console has to draw.
  */
  async function answerModal(message) {
    const query = typeof message.query === 'string' ? message.query.slice(0, 200) : '';
    const modal = openModal.modal;
    let values = [];
    try { values = await modal.getSuggestions(query); } catch (_) { values = []; }
    if (!Array.isArray(values)) values = [];
    const limit = Math.max(1, Math.min(SUGGEST_MAX, Number(modal.limit) || SUGGEST_MAX));
    values = values.slice(0, limit);
    const items = [];
    for (const value of values) {
      const el = document.createElement('div');
      try { modal.renderSuggestion(value, el); } catch (_) {}
      items.push({ text: String(el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 200) });
    }
    // Replaced wholesale, so a pick can only land on the list now on screen.
    openModal.values = values;
    send('suggest-modal-results', { seq: message.seq, items });
  }

  /*
    The reader chose one. onChooseSuggestion is the plugin's own, and it runs in
    here — that is where the plugin does its work, and it reaches the vault
    through the same grants as everything else.

    The dialog closes on a pick because Obsidian's does, and the guest reports
    that rather than leaving the console to assume it: a plugin that reopened
    from inside onChooseSuggestion would otherwise have its new dialog shut by
    the console's own tidy-up.
  */
  async function pickModal(message) {
    const index = Number(message.index);
    const value = openModal.values[index];
    const modal = openModal.modal;
    openModal = null;
    // Closed before chosen, which is Obsidian's order and matters here: a
    // plugin that reopens from inside onChooseSuggestion must not then have its
    // new dialog's onClose fired by this one's tidy-up.
    try { modal.onClose(); } catch (_) {}
    if (value !== undefined) {
      try { await modal.onChooseSuggestion(value, {}); } catch (_) {}
    }
    send('suggest-modal-picked', { seq: message.seq, reopened: openModal !== null });
  }

  /*
    THE READ PREVIEW: THE PROCESSOR RUNS IN HERE, ITS TEXT IS WHAT LEAVES.

    registerMarkdownPostProcessor is how a plugin decorates a note as it reads.
    YouVersion's registers one that finds every external bible.com link in the
    rendered markdown, fetches the verse over requestUrl, and attaches a tooltip
    carrying it.

    Obsidian hands the processor the real rendered document and lets it write
    into it. Context cannot: that is third-party DOM in the trusted realm, which
    docs/decisions/plugins.md rules out for the same reason it rules out
    registerEditorExtension. So the halves are split exactly as they are for
    suggestions.

    The host says which links the open note has. The guest builds a rendered
    document **in here** shaped the way Obsidian renders external links, runs
    the plugin's processor against it, waits for the realm to go quiet, and
    reports **the preview text each link ended up with**. The console draws its
    own tooltip from that text. No element, no handler, no markup crosses.

    ## What the guest cannot invent, and says so

    The document it builds carries the note's external links and nothing else —
    no headings, no paragraphs, no code, no embeds. That is enough for a
    processor that works on links and not enough for one that works on anything
    else, and the difference is reported as a limitation rather than discovered.
  */
  const processors = [];
  // Links per query and characters per preview, interpolated from the host's
  // own constants rather than written twice: two numbers meant to agree, in one
  // file, with nothing linking them is how the shim and the scanner drifted.
  // Roughly six seconds of waiting, in steps. A verse arrives over the brokered
  // egress path, which is a Worker, a container and a third-party site.
  const PREVIEW_TURNS = 60;
  const PREVIEW_STEP_MS = 100;

  function previewDocumentFor(links) {
    const root = document.createElement('div');
    root.className = 'markdown-preview-view markdown-rendered';
    const anchors = [];
    for (const link of links) {
      const paragraph = document.createElement('p');
      const anchor = document.createElement('a');
      /*
        Obsidian's own shape for an external link in rendered markdown, and each
        attribute is load-bearing rather than decoration. YouVersion takes
        anchors that carry external-link and whose text is not their own href —
        so a container missing the class runs the plugin and finds nothing,
        which from outside is indistinguishable from a plugin that does not
        work.
      */
      anchor.className = 'external-link';
      anchor.setAttribute('href', link.href);
      anchor.setAttribute('target', '_blank');
      anchor.setAttribute('rel', 'noopener');
      anchor.textContent = link.text;
      paragraph.appendChild(anchor);
      root.appendChild(paragraph);
      anchors.push({ href: link.href, anchor });
    }
    return { root, anchors };
  }

  /*
    WHAT COUNTS AS A PREVIEW, AND WHY IT IS A LADDER.

    A processor does not return its preview; it attaches it to the link. There
    are four ways to do that in this ecosystem, and the guest reads all four in
    order of how standard they are: the two accessible attributes first, then
    the data attribute a few plugins use, then tippy.js — which is what
    YouVersion bundles, and which records itself on the element it decorates.

    A plugin attaching a preview some other way gets none reported. That is
    stated in the limitation the console shows, because the alternative is a
    plugin that looks enabled and silently does nothing.

    Only text is read, never markup, and never the element itself.
  */
  function previewTextOf(anchor) {
    const labelled = anchor.getAttribute('aria-label')
      || anchor.getAttribute('title')
      || anchor.getAttribute('data-tooltip')
      || '';
    if (labelled.trim() !== '') return labelled;
    const tip = anchor._tippy;
    const content = tip && tip.props ? tip.props.content : null;
    if (typeof content === 'string') return content;
    return textOfNode(content, 0);
  }

  /*
    A line per element the plugin built, rather than one run of textContent.
    YouVersion's popup is two sibling spans with no whitespace between them, so
    textContent alone reads "...so loved the world.John 3:16 NIV". The structure
    is the plugin's own and keeping it costs nothing; inventing a separator
    where the plugin put none would be the host deciding how a plugin reads.
  */
  function textOfNode(node, depth) {
    if (!node || typeof node.textContent !== 'string') return '';
    // The plugin built this tree, so its depth is the plugin's choice and a
    // plain recursion is a stack it controls. Past the limit the subtree is
    // read flat rather than walked, which loses the line breaks and nothing
    // else — and never takes the guest down mid-answer.
    const children = node.children && (depth || 0) < 8
      ? Array.prototype.slice.call(node.children)
      : [];
    if (children.length === 0) return node.textContent;
    const parts = [];
    for (const child of children) {
      const text = textOfNode(child, (depth || 0) + 1);
      if (text.trim() !== '') parts.push(text);
    }
    return parts.join('\\n');
  }

  function boundPreview(text) {
    return String(text)
      .split('\\n')
      .map(line => line.replace(/\\s+/g, ' ').trim())
      .filter(line => line !== '')
      .join('\\n')
      .slice(0, ${PREVIEW_TEXT_MAX});
  }

  /*
    Obsidian lets a processor return a promise and waits on it. YouVersion's
    does not: it starts a requestUrl per link and attaches the tooltip whenever
    that answers, returning undefined immediately. So awaiting the call proves
    nothing, and the guest waits for its own realm to go quiet instead —
    bounded, and reporting whatever is attached when the wait ends rather than
    throwing, because a slow verse should cost that one preview and not the
    rest.
  */
  async function settlePreview(anchors) {
    let previous = null;
    for (let turn = 0; turn < PREVIEW_TURNS; turn += 1) {
      await requestsIdle();
      await new Promise(resolve => setTimeout(resolve, PREVIEW_STEP_MS));
      const current = JSON.stringify(anchors.map(entry => previewTextOf(entry.anchor)));
      if (inFlightRequests === 0 && current === previous) return;
      previous = current;
    }
  }

  async function answerPreview(message) {
    const given = Array.isArray(message.links) ? message.links.slice(0, ${PREVIEW_LINKS_MAX}) : [];
    const links = [];
    for (const one of given) {
      if (!one || typeof one.href !== 'string' || one.href === '') continue;
      links.push({ href: one.href, text: typeof one.text === 'string' ? one.text : '' });
    }
    if (processors.length === 0 || links.length === 0) {
      send('preview-results', { seq: message.seq, previews: [] });
      return;
    }
    const built = previewDocumentFor(links);
    /*
      The context Obsidian passes. sourcePath is the note the host says is open,
      which a processor may read; docId is this render and nothing else. The two
      methods exist so that a processor calling one does not throw — there is no
      child lifecycle here to add to, and no section of a source file to
      describe, and answering honestly with nothing beats a TypeError inside a
      callback whose rejection nobody sees.
    */
    const context = {
      docId: 'context-preview-' + (message.seq === undefined ? 0 : message.seq),
      sourcePath: activeFile === null ? '' : activeFile.path,
      frontmatter: null,
      addChild() {},
      getSectionInfo() { return null; },
    };
    for (const processor of processors) {
      try { await processor(built.root, context); } catch (_) {}
    }
    await settlePreview(built.anchors);
    const previews = [];
    for (const entry of built.anchors) {
      const text = boundPreview(previewTextOf(entry.anchor));
      if (text === '') continue;
      previews.push({ href: entry.href, text });
    }
    send('preview-results', { seq: message.seq, previews });
  }

  const app = { vault, metadataCache, workspace };

  class Plugin {
    constructor() { this.app = app; this.manifest = {}; }
    addCommand(command) {
      if (!command || typeof command.id !== 'string' || typeof command.name !== 'string') return;
      commands.set(command.id, command);
      // Whether it takes an editor, which decides whether the console may draw
      // it as pressable. Obsidian keeps editor commands out of its palette
      // unless an editor is focused; the host needs the same fact to do the
      // same thing, and only the guest can see which callback was supplied.
      send('registration', {
        kind: 'command',
        id: command.id,
        name: command.name,
        needsEditor: typeof command.editorCallback === 'function',
      });
    }
    addRibbonIcon(icon, title, callback) {
      const id = 'ribbon-' + commands.size;
      commands.set(id, { id, name: title, callback });
      send('registration', { kind: 'ribbon', id, name: String(title || icon || 'Plugin action') });
      return document.createElement('span');
    }
    addStatusBarItem() {
      const el = document.createElement('div');
      statusCount += 1;
      statusIds.set(el, 'status-' + statusCount);
      statusRoot.appendChild(el);
      if (statusWatch === null) {
        // One observer on the container rather than one per item, because the
        // removal of an item is a mutation of the container and an observer on
        // the item itself would never see it.
        statusWatch = new MutationObserver(reportStatusBar);
        statusWatch.observe(statusRoot, { childList: true, subtree: true, characterData: true });
      }
      return el;
    }
    registerEditorSuggest(suggester) {
      // Kept, not mounted. The trusted editor never receives this object, its
      // callbacks or its DOM: it asks the guest over suggest-query and draws
      // the answer itself. See the host for why that is the whole design.
      if (suggester && typeof suggester.onTrigger === 'function') suggesters.push(suggester);
    }
    registerMarkdownPostProcessor(processor) {
      // Kept, not mounted, for the reason registerEditorSuggest above is kept:
      // the trusted document never receives this callback and never receives
      // what it writes. It is run against a document built in here, on demand.
      if (typeof processor !== 'function') return processor;
      processors.push(processor);
      return processor;
    }
    registerEditorExtension() {}
    registerEvent(ref) { if (ref && typeof ref.off === 'function') disposers.push(() => ref.off()); }
    registerDomEvent(el, type, callback, options) {
      el.addEventListener(type, callback, options);
      disposers.push(() => el.removeEventListener(type, callback, options));
    }
    registerInterval(id) { disposers.push(() => clearInterval(id)); return id; }
    addSettingTab() {}
    async loadData() {
      const result = await request({ kind: 'settings.load' });
      if (!result || typeof result.json !== 'string') return {};
      return JSON.parse(result.json);
    }
    async saveData(value) {
      const current = await request({ kind: 'settings.load' });
      await request({ kind: 'settings.save', json: JSON.stringify(value || {}), expectedEtag: current && typeof current.etag === 'string' ? current.etag : null });
    }
    register(disposer) { if (typeof disposer === 'function') disposers.push(disposer); }
  }

  class Notice {
    constructor(message) { send('notice', { message: String(message).slice(0, 500) }); }
  }

  class Component { load() {}; unload() {} }
  /*
    AN EVENT BUS, IMPLEMENTED RATHER THAN DECLARED.

    Obsidian's Events is a plain emitter and several plugins extend it to make
    their own. Bible Reference does, at module scope, about eighty kilobytes
    into its bundle:

        var Pe = class n extends it.Events { ... static getInstance() ... }

    which is evaluated on load. A missing class there is extends undefined,
    thrown before onload, and the whole plugin gone — the same failure
    SuggestModal was added for, from a class nobody had thought to list.

    There is nothing to invert here and nothing to ask the console for: this is
    a map of callbacks inside the sandbox. The reference object on returns is
    what offref takes back, which is the contract the subclass above relies on —
    it collects refs and releases them together.

    A listener that throws must not stop the ones after it, and a plugin cannot
    be trusted not to throw; the same rule the disposer loop follows.
  */
  class Events {
    constructor() { this.__contextHandlers = new Map(); }
    on(name, callback, ctx) {
      const key = String(name);
      const ref = { name: key, callback, ctx };
      const list = this.__contextHandlers.get(key) || [];
      list.push(ref);
      this.__contextHandlers.set(key, list);
      return ref;
    }
    off(name, callback) {
      const key = String(name);
      const list = this.__contextHandlers.get(key);
      if (!list) return;
      this.__contextHandlers.set(key, list.filter(entry => entry.callback !== callback));
    }
    offref(ref) {
      if (!ref || typeof ref !== 'object') return;
      const list = this.__contextHandlers.get(ref.name);
      if (!list) return;
      this.__contextHandlers.set(ref.name, list.filter(entry => entry !== ref));
    }
    trigger(name, ...args) {
      const list = this.__contextHandlers.get(String(name));
      if (!list) return;
      // A copy, because a listener may register or release one while running.
      for (const entry of list.slice()) {
        try { entry.callback.apply(entry.ctx, args); } catch (_) {}
      }
    }
    tryTrigger(ref, args) {
      if (!ref || typeof ref.callback !== 'function') return;
      try { ref.callback.apply(ref.ctx, args || []); } catch (_) {}
    }
  }

  /*
    A DIALOG THE PLUGIN FILLS AND THE CONSOLE DRAWS.

    Same inversion as SuggestModal, one step simpler. contentEl and titleEl are
    real elements in here, so a plugin builds into them exactly as it would in
    Obsidian — including asynchronously, which Bible Reference's verse-of-the-day
    does: its onOpen awaits a fetch and only then calls contentEl.setText.

    So what crosses is text, and it crosses whenever the text changes rather
    than once when open() returns. A MutationObserver is what makes the async
    case work without polling and without the plugin having to tell us it
    finished — and without it this dialog would reliably show empty for the one
    plugin it was written for.

    Only textContent crosses. A plugin cannot put markup, a link, an image or a
    script in front of a reader, which is the same boundary the suggestion
    dialog keeps and for the same reason.

    Interactive controls built into contentEl do not work, and that is reported
    rather than hidden: a button drawn in here is a button in a document nobody
    sees. Read-only dialogs — a verse, a summary, an explanation — are what this
    serves, and they are most of them.
  */
  class Modal {
    constructor(appValue) {
      this.app = appValue;
      this.containerEl = createDiv();
      this.modalEl = this.containerEl.createDiv();
      this.titleEl = this.modalEl.createDiv();
      this.contentEl = this.modalEl.createDiv();
      this.__contextObserver = null;
    }
    setTitle(value) { this.titleEl.setText(value); this.__contextPush(); return this; }
    setContent(value) { this.contentEl.setText(value); this.__contextPush(); return this; }
    onOpen() {}
    onClose() {}
    open() {
      /*
        Retire whoever was open first. Its observer would otherwise keep running
        against a dialog nobody can see — __contextPush returns early once
        openTextModal moves on, so the callbacks are pure waste, and a plugin
        that opens a dialog per command would accumulate one each time.
      */
      if (openTextModal !== null && openTextModal !== this) openTextModal.__contextUnwatch();
      openTextModal = this;
      this.__contextWatch();
      // Sent before onOpen so a dialog whose content arrives over the network
      // appears immediately rather than after the round trip, which is what the
      // reader who pressed the command is waiting to see.
      this.__contextPush();
      try { Promise.resolve(this.onOpen()).then(() => this.__contextPush(), () => {}); } catch (_) {}
    }
    close() {
      // Unconditionally, before the early return: a modal that was replaced
      // rather than closed still owns an observer, and close() is a plugin's
      // only way to say it is finished with it.
      this.__contextUnwatch();
      if (openTextModal !== this) return;
      openTextModal = null;
      try { this.onClose(); } catch (_) {}
      send('text-modal', { open: false });
    }
    __contextWatch() {
      if (this.__contextObserver || typeof MutationObserver !== 'function') return;
      this.__contextObserver = new MutationObserver(() => this.__contextPush());
      this.__contextObserver.observe(this.modalEl, {
        childList: true, subtree: true, characterData: true,
      });
    }
    __contextUnwatch() {
      if (!this.__contextObserver) return;
      this.__contextObserver.disconnect();
      this.__contextObserver = null;
    }
    __contextPush() {
      if (openTextModal !== this) return;
      send('text-modal', {
        open: true,
        title: String(this.titleEl.textContent || '').slice(0, TEXT_MODAL_TITLE_MAX),
        text: String(this.contentEl.textContent || '').slice(0, TEXT_MODAL_TEXT_MAX),
      });
    }
  }


  class MarkdownView {}
  class ItemView {}
  class EditorSuggest { constructor(appValue) { this.app = appValue; } }

  /*
    A SUGGESTION DIALOG, BY THE SAME INVERSION AS registerEditorSuggest.

    Obsidian's SuggestModal builds and mounts its own dialog. Context cannot let
    it — that is third-party DOM in the trusted realm, which plugins.md rules
    out — so the halves are split exactly as they are for an editor suggestion,
    and for the same reasons: the plugin's getSuggestions and renderSuggestion
    run *in here*, against elements created in here, and only the resulting text
    crosses. The console draws its own dialog and sends back an index.

    **It exists at all because absent was worse than inverted.** class X extends
    api.SuggestModal {} is evaluated when a bundle loads, so a missing class was
    not a missing feature — it was extends undefined, thrown before onload, and
    the whole plugin gone. Bible Reference is the one that showed it: its inline
    verse suggester needs nothing that was not already built, and it never got to
    register it.

    onChooseSuggestion runs in here too, which is the point — that is where a
    plugin does its work, and it reaches the vault through the same grants
    everything else does.
  */
  class SuggestModal {
    constructor(appValue) {
      this.app = appValue;
      this.limit = SUGGEST_MAX;
      this.placeholder = '';
      this.instructions = [];
    }
    setPlaceholder(text) { this.placeholder = String(text == null ? '' : text).slice(0, 120); }
    setInstructions(list) {
      this.instructions = (Array.isArray(list) ? list : []).slice(0, 6).map((row) => ({
        command: String((row && row.command) || '').slice(0, 40),
        purpose: String((row && row.purpose) || '').slice(0, 120),
      }));
    }
    // Obsidian calls these on the plugin's behalf; a subclass may override
    // either. Empty here rather than absent so super.onOpen() works.
    onOpen() {}
    onClose() {}
    getSuggestions() { return []; }
    renderSuggestion() {}
    onChooseSuggestion() {}
    open() {
      openModal = { modal: this, values: [] };
      try { this.onOpen(); } catch (_) {}
      send('suggest-modal', {
        open: true,
        placeholder: this.placeholder,
        instructions: this.instructions,
      });
    }
    close() {
      if (openModal === null || openModal.modal !== this) return;
      openModal = null;
      try { this.onClose(); } catch (_) {}
      send('suggest-modal', { open: false, placeholder: '', instructions: [] });
    }
  }

  /*
    The fuzzy variant, which most plugins actually reach for. Obsidian wraps each
    item as { item, match } and calls getItemText / onChooseItem; the
    default filter here is a plain case-insensitive substring rather than a
    scoring one, because a wrong *order* is a worse answer that still looks
    right, and nothing here promises Obsidian's ranking.
  */
  class FuzzySuggestModal extends SuggestModal {
    getItems() { return []; }
    getItemText() { return ''; }
    onChooseItem() {}
    getSuggestions(query) {
      const needle = String(query || '').toLowerCase();
      const matches = [];
      for (const item of this.getItems()) {
        const text = String(this.getItemText(item) || '');
        if (needle === '' || text.toLowerCase().includes(needle)) matches.push({ item, match: { score: 0, matches: [] } });
      }
      return matches;
    }
    renderSuggestion(value, el) { el.textContent = String(this.getItemText(value && value.item)); }
    onChooseSuggestion(value, evt) { this.onChooseItem(value && value.item, evt); }
  }
  class PluginSettingTab { constructor(appValue, plugin) { this.app = appValue; this.plugin = plugin; } }
  class Setting { constructor() {} setName() { return this; } setDesc() { return this; } addText() { return this; } addToggle() { return this; } addDropdown() { return this; } addButton() { return this; } }
  function decodeBase64(value) {
    const binary = atob(String(value || ''));
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  }

  function requestUrlResponse(result) {
    const bytes = decodeBase64(result && result.bodyBase64);
    const text = new TextDecoder().decode(bytes);
    const headers = {};
    for (const row of result && Array.isArray(result.headers) ? result.headers : []) {
      if (row && typeof row.name === 'string' && typeof row.value === 'string') {
        headers[row.name.toLowerCase()] = row.value;
      }
    }
    let json = null;
    try { json = JSON.parse(text); } catch (_) {}
    return {
      status: result && Number.isInteger(result.status) ? result.status : 0,
      headers,
      arrayBuffer: bytes.buffer,
      json,
      text,
    };
  }

  /*
    YouVersion 1.8.1 imports these three modules while constructing an editor
    extension, before onload can register it. Context does not mount third-party
    extensions in the trusted editor yet, so these are deliberately inert
    compatibility objects inside the opaque guest, not the host's CodeMirror
    instances. They let the reviewed bundle load without pretending editor
    decorations or suggestions are implemented.
  */
  class CompatRangeSetBuilder {
    add() {}
    finish() { return []; }
  }
  class CompatWidgetType {}
  const codeMirrorModules = {
    '@codemirror/language': {
      syntaxTree() { return { iterate() {} }; },
    },
    '@codemirror/state': { RangeSetBuilder: CompatRangeSetBuilder },
    '@codemirror/view': {
      Decoration: { replace(spec) { return { spec }; } },
      ViewPlugin: { fromClass(extensionClass, spec) { return { extensionClass, spec }; } },
      WidgetType: CompatWidgetType,
    },
  };

  const api = {
    Plugin, Notice, Component, Events, Modal, MarkdownView, ItemView, EditorSuggest, SuggestModal,
    FuzzySuggestModal, PluginSettingTab, Setting,
    TFile, TFolder, Vault: function Vault() {}, Workspace: function Workspace() {},
    MetadataCache: function MetadataCache() {},
    normalizePath: value => String(value).replace(/\\\\/g, '/').replace(/^\\/+|\\/+$/g, ''),
    requestUrl: async options => {
      const input = typeof options === 'string' ? { url: options } : options;
      const result = await request({ kind: 'network.request', url: input.url, method: input.method || 'GET', headers: Object.entries(input.headers || {}).map(([name, value]) => ({ name, value: String(value) })), ...(input.body === undefined ? {} : { body: String(input.body) }) });
      return requestUrlResponse(result);
    },
  };

  function requireModule(name) {
    if (name === 'obsidian') return api;
    if (Object.prototype.hasOwnProperty.call(codeMirrorModules, name)) return codeMirrorModules[name];
    throw new Error('Context sandbox does not provide module: ' + String(name));
  }

  function editorFor(text) {
    let value = String(text);
    let revision = 0;
    const lines = () => value.split('\\n');
    const offset = position => {
      const all = lines();
      const line = Math.max(0, Math.min(all.length - 1, Number(position && position.line) || 0));
      const ch = Math.max(0, Math.min(all[line].length, Number(position && position.ch) || 0));
      let found = ch;
      for (let index = 0; index < line; index += 1) found += all[index].length + 1;
      return found;
    };
    return {
      lineCount() { return lines().length; },
      lastLine() { return lines().length - 1; },
      getLine(line) { return lines()[line] || ''; },
      getValue() { return value; },
      setValue(next) { value = String(next); revision += 1; },
      getRange(from, to) { return value.slice(offset(from), offset(to)); },
      replaceRange(replacement, from, to) {
        const start = offset(from);
        const end = offset(to || from);
        value = value.slice(0, start) + String(replacement) + value.slice(end);
        revision += 1;
      },
      revision() { return revision; },
    };
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

  async function unload() {
    try { if (instance && typeof instance.onunload === 'function') await instance.onunload(); } catch (_) {}
    while (disposers.length) { try { disposers.pop()(); } catch (_) {} }
    instance = null;
    commands.clear();
    listeners.clear();
    activeFile = null;
    // An unloaded plugin is inert, and a status bar that went on reporting
    // would be a line on the console from a plugin that is no longer running.
    suggesters.length = 0;
    offered = null;
    processors.length = 0;
    /*
      An unloaded plugin's dialogs are not answerable. openModal mattered
      already — a pick would have run onChooseSuggestion on a plugin that is no
      longer running — and openTextModal holds a live MutationObserver besides,
      which would go on firing against a document nobody sees.
      (No backticks: this whole file is inside a template literal.)
    */
    openModal = null;
    if (openTextModal !== null) { openTextModal.__contextUnwatch(); openTextModal = null; }
    if (statusWatch !== null) { statusWatch.disconnect(); statusWatch = null; }
    statusRoot.textContent = '';
    statusCount = 0;
    statusSent = null;
  }

  const receiveHostMessage = async event => {
    const message = event.data;
    if (!message || message.source !== 'context-plugin-host' || message.version !== VERSION) return;
    /*
      THE ONLY PART OF A HOST MESSAGE ITS SENDER CANNOT WRITE.

      The 'context-plugin-host' marker above is a string in the payload, so any
      window holding a handle to this frame can write it: opener.frames[i] then
      postMessage reaches a nested frame across origins by design, and an opaque
      origin does not change that. What such a sender cannot forge is
      event.source, which the user agent sets to the posting window.

      That matters because the claim below -- that a host-to-guest message can
      only ask the plugin to act inside its own realm -- stopped being true once
      the command path grew a read and a write of its own. A command now makes
      this guest issue vault.read against the open note and vault.modify back
      onto it, so a forged one is an unauthorized write to a customer's note,
      timed by whoever forged it.

      Nonce-ing this direction is still refused, for the reason given below: the
      plugin shares this realm and would read the nonce out of the event.

      event.source is absent on the React Native path, where the host injects
      into the document rather than posting between windows, so an absent source
      is accepted and a foreign one is refused. In a WebView window.parent is
      window, which is what an injected post carries anyway.
    */
    if (event.source && event.source !== window.parent) return;
    // RPC replies carry no sandbox nonce. A plugin can observe every event in
    // its own realm, so including the nonce here would reveal the value the
    // trusted host uses to reject forged status and registration messages.
    if (message.type === 'rpc-result') {
      const waiting = pending.get(message.response && message.response.requestId);
      if (!waiting) return;
      pending.delete(message.response.requestId);
      if (message.response.ok) waiting.resolve(message.response.result);
      else waiting.reject(new Error(message.response.error && message.response.error.message || 'Plugin operation failed'));
      return;
    }
    if (nonce === null) {
      if (message.type !== 'load' || typeof message.nonce !== 'string') return;
      nonce = message.nonce;
    }
    // Once loaded, host-to-guest messages omit the nonce. They can only ask the
    // plugin to act inside its own realm, so accepting a forged one grants no
    // authority; keeping the nonce off observable events preserves the trust
    // boundary for guest-to-host health and registration messages.
    if (message.type === 'command') {
      const command = commands.get(message.id);
      if (!command) return;
      try {
        if (typeof command.editorCallback === 'function') {
          if (activeFile === null) throw new Error('Open a note before running this command');
          // Pin the target before the first await. The owner may open another
          // note while a plugin's network work is in flight, and the result
          // still belongs to the note the command was invoked against.
          const target = activeFile;
          const before = await vault.read(target);
          const editor = editorFor(before);
          await command.editorCallback(editor, null);
          await settleEditorWork(editor);
          const after = editor.getValue();
          if (after !== before) await vault.modify(target, after);
        } else {
          const run = command.callback || command.checkCallback;
          if (typeof run === 'function') await run();
        }
        send('command-result', { id: message.id, ok: true });
      } catch (error) {
        send('command-result', { id: message.id, ok: false, error: String(error && error.message || error).slice(0, 500) });
      }
      return;
    }
    // A suggestion is only ever offered by a running plugin, and only over the
    // line the host handed in. An unloaded guest answers nothing at all rather
    // than an empty list, so the host can tell "no plugin" from "no match".
    if (message.type === 'suggest-query') {
      if (instance === null) return;
      await answerSuggest(message);
      return;
    }
    if (message.type === 'suggest-apply') {
      if (instance === null) return;
      await applySuggest(message);
      return;
    }
    // The dialog's two halves. Answered only while a plugin has one open: a
    // guest with no open modal says nothing, so the console can tell "closed"
    // from "no matches" — the same distinction the editor's suggester keeps.
    if (message.type === 'suggest-modal-query') {
      if (instance === null || openModal === null) return;
      await answerModal(message);
      return;
    }
    if (message.type === 'suggest-modal-pick') {
      if (instance === null || openModal === null) return;
      await pickModal(message);
      return;
    }
    if (message.type === 'suggest-modal-dismiss') {
      if (instance === null || openModal === null) return;
      // The reader closed it, so the plugin's own onClose runs and the guest
      // forgets the values. Not routed through close(), which would send the
      // console a message about a dialog the console just shut.
      const modal = openModal.modal;
      openModal = null;
      try { modal.onClose(); } catch (_) {}
      return;
    }
    if (message.type === 'text-modal-dismiss') {
      if (instance === null || openTextModal === null) return;
      // The reader closed it. Same shape as the suggestion dialog's dismissal:
      // the plugin's onClose runs and the observer stops, and it does not go
      // through close(), which would send the console a message about a dialog
      // the console has already shut.
      const modal = openTextModal;
      openTextModal = null;
      modal.__contextUnwatch();
      try { modal.onClose(); } catch (_) {}
      return;
    }
    // A preview carries the note's own links into the sandbox, so like a
    // suggestion it is the host that decides whether this plugin may be asked,
    // and an unloaded guest answers nothing at all rather than an empty list.
    if (message.type === 'preview-query') {
      if (instance === null) return;
      await answerPreview(message);
      return;
    }
    // An unloaded plugin is inert, and that has to include the state it is
    // handed: a guest that went on tracking the open note after unload would
    // hold a file the reader has closed, and hand it to whatever loaded next.
    if ((message.type === 'active-file' || message.type === 'vault-event') && instance === null) return;
    if (message.type === 'active-file') {
      // null is a real value here: nothing is open, and a plugin asking then
      // must get null rather than the last note somebody looked at.
      if (typeof message.path === 'string' && message.path !== '') {
        activeFile = file(message.path, typeof message.etag === 'string' ? { etag: message.etag } : null);
      } else {
        activeFile = null;
      }
      emit('workspace:file-open', activeFile);
      return;
    }
    if (message.type === 'vault-event') {
      // Only what Context itself changed — see the host. A rename carries both
      // paths because Obsidian's own handler signature takes the old one.
      const target = typeof message.path === 'string'
        ? file(message.path, typeof message.etag === 'string' ? { etag: message.etag } : null)
        : null;
      if (target === null) return;
      if (message.kind === 'rename') emit('vault:rename', target, String(message.from || ''));
      else if (message.kind === 'create') emit('vault:create', target);
      else if (message.kind === 'delete') emit('vault:delete', target);
      else if (message.kind === 'modify') emit('vault:modify', target);
      else return;
      if (message.kind !== 'delete') emit('metadata:changed', target);
      return;
    }
    if (message.type === 'unload') {
      await unload();
      send('unloaded');
      return;
    }
    if (message.nonce !== nonce) return;
    if (message.type !== 'load' || typeof message.mainJs !== 'string') return;
    try {
      const module = { exports: {} };
      const script = document.createElement('script');
      script.textContent = '(function(module,exports,require){\\n' + message.mainJs + '\\n})(window.__contextModule,window.__contextModule.exports,window.__contextRequire);';
      window.__contextModule = module;
      window.__contextRequire = requireModule;
      document.head.appendChild(script);
      script.remove();
      delete window.__contextModule;
      delete window.__contextRequire;
      const Exported = module.exports && (module.exports.default || module.exports);
      if (typeof Exported !== 'function') throw new Error('Plugin bundle did not export a plugin class');
      instance = new Exported(app, JSON.parse(message.manifestJson || '{}'));
      instance.app = app;
      instance.manifest = JSON.parse(message.manifestJson || '{}');
      if (typeof instance.onload === 'function') await instance.onload();
      send('loaded');
    } catch (error) {
      send('crashed', { code: 'PLUGIN_LOAD_FAILED', message: String(error && error.message || error).slice(0, 500) });
    }
  };
  // react-native-webview delivers host messages on window on iOS and on
  // document on Android. A browser delivers on window only.
  window.addEventListener('message', receiveHostMessage);
  document.addEventListener('message', receiveHostMessage);

  post({ source: 'context-plugin-sandbox', version: VERSION, type: 'ready' });
})();
</script></body></html>`;
}

/**
 * Whether the frame that just fired `load` is still the document we wrote.
 *
 * ## Why a count is the whole answer
 *
 * `sandbox="allow-scripts"` without `allow-same-origin` denies the frame the
 * parent's DOM, and the CSP above denies it `fetch`, workers, child frames,
 * forms, objects and every external asset. **Not one of them stops a document
 * navigating itself.** `allow-top-navigation` governs the *top-level* browsing
 * context, not a frame's own, and the CSP directive that would have covered it
 * — `navigate-to` — was removed from the specification and ships in no engine.
 * So the frame can stop being ours, and the host cannot ask it politely
 * whether it still is: reading `contentWindow.location` across an opaque
 * origin throws, and any answer the frame itself gave would be the untrusted
 * party vouching for itself.
 *
 * What the host *can* see is the `load` event, and that is exact rather than a
 * heuristic. `srcdoc` is written once, from a `useMemo` constant, and is never
 * re-set for the life of the element — so the first load is the document we
 * wrote and any later one is a document somebody else chose.
 *
 * A frame that is no longer ours must be handed nothing further: not the
 * sandbox nonce, not the bundle, and no answer to an `rpc` it sends. After a
 * navigation `event.source` still equals `frame.contentWindow`, so identity
 * alone stops distinguishing the successor from the original — this count is
 * what the host has instead.
 *
 * Native needs no equivalent because it refuses the navigation outright
 * (`originWhitelist` plus `onShouldStartLoadWithRequest`); a WebView can be
 * told what it may load, an iframe cannot.
 *
 * @param {number} loadCount How many `load` events this element has fired.
 */
export function sandboxFrameIsOurs(loadCount) {
  return loadCount === 1;
}

/**
 * How many suggestions one plugin may offer for one line.
 *
 * A completion menu is a list somebody arrows through under time pressure, not
 * a search result page; past a handful it stops being faster than typing. The
 * guest stops at this and the host truncates whatever arrives anyway, because a
 * cap the untrusted half applies to itself is not a cap.
 */
export const SUGGEST_MAX = 8;

/**
 * How many status bar items one plugin may put on its card.
 *
 * Obsidian imposes no limit and neither does the shim's own list — this is the
 * console's, because the items are drawn in a card beside the Stop button and a
 * plugin that added forty of them would push it off the screen. Enforced on
 * both sides: the guest stops reporting past this, and the host truncates
 * anything that arrives anyway, because the guest is the untrusted half and a
 * cap it applies to itself is not a cap.
 */
export const STATUS_BAR_MAX = 8;

/** How many instruction rows a dialog may put under its list. */
export const SUGGEST_MODAL_INSTRUCTIONS_MAX = 6;

/**
 * What a plain `Modal` may put on screen, bounded on the trusted side.
 *
 * The guest applies the same numbers to itself, and that is not where the cap
 * lives: a bound the untrusted half enforces is a bound it can drop. These are
 * the ones that decide what is drawn.
 */
export const TEXT_MODAL_TITLE_CAP = 200;
export const TEXT_MODAL_TEXT_CAP = 8000;

/**
 * How many links one preview query covers, and how long one preview may be.
 *
 * The link cap bounds what the *host* sends: a long note can hold hundreds of
 * external links, and asking a plugin to fetch every one of them on open is a
 * request neither the person nor the site they are hitting asked for. The first
 * two dozen is what somebody is actually reading.
 *
 * The text cap bounds what the *guest* sends back, and that half is the one
 * that matters for safety — a preview is entirely the plugin's words, drawn in
 * a tooltip over somebody's own note. Enforced on both sides for the reason
 * `STATUS_BAR_MAX` is: a cap the untrusted half applies to itself is not a cap.
 */
export const PREVIEW_LINKS_MAX = 24;
export const PREVIEW_TEXT_MAX = 400;

/**
 * Strictly recognize messages that may cross from the untrusted frame.
 * @param {unknown} value
 * @param {string} expectedNonce
 */
export function parsePluginSandboxMessage(value, expectedNonce) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = /** @type {Record<string, unknown>} */ (value);
  if (row.source !== "context-plugin-sandbox" || row.version !== 1) return null;
  if (row.type === "ready") return { type: "ready" };
  if (row.nonce !== expectedNonce) return null;
  switch (row.type) {
    case "loaded":
    case "unloaded":
      return { type: row.type };
    case "rpc":
      return row.request && typeof row.request === "object"
        ? { type: "rpc", request: row.request }
        : null;
    case "crashed":
      return typeof row.code === "string" && typeof row.message === "string"
        ? {
            type: "crashed",
            code: row.code.slice(0, 80),
            message: row.message.slice(0, 500),
          }
        : null;
    case "notice":
      return typeof row.message === "string"
        ? { type: "notice", message: row.message.slice(0, 500) }
        : null;
    /*
      The guest's answer to a host `command`.

      Nonce-checked above with everything else observable, and for the same
      reason: a forged result would report a command as run that never was, or
      report success for one that threw. `ok` is required to be a boolean
      rather than coerced — a message that simply omits it is malformed, and
      treating a missing field as failure would invent an outcome the guest
      never claimed.
    */
    case "command-result":
      return typeof row.id === "string" && typeof row.ok === "boolean"
        ? {
            type: "command-result",
            id: row.id.slice(0, 100),
            ok: row.ok,
            error: typeof row.error === "string" ? row.error.slice(0, 500) : null,
          }
        : null;
    /*
      Everything the plugin currently has in its status bar.

      **A whole list every time, not an add and a remove.** The alternative
      needs the guest to report a removal, and a guest that is torn down, throws
      mid-render, or simply forgets leaves a line on the console describing an
      item that no longer exists — the same stale-claim failure the
      registrations card was careful to avoid, one layer down. Replacing the
      list makes the console's copy unable to drift from the guest's.

      Truncated rather than refused, unlike a malformed entry. Nine items is a
      plugin being greedy and the eight before it are real; an entry without a
      string `text` is not something the shim can produce, so the message is
      dropped whole.
    */
    case "status-bar": {
      if (!Array.isArray(row.items)) return null;
      const items = [];
      for (const entry of row.items) {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
        const one = /** @type {Record<string, unknown>} */ (entry);
        if (typeof one.id !== "string" || typeof one.text !== "string") return null;
        if (items.length >= STATUS_BAR_MAX) continue;
        items.push({ id: one.id.slice(0, 60), text: one.text.slice(0, 120) });
      }
      return { type: "status-bar", items };
    }
    /*
      What the plugin offered for the line the host asked about.

      Text only, bounded twice like the status bar, and nonce-authenticated like
      every observable event: a forged list would put words into a completion
      menu the person is about to accept into their own note.

      `seq` is required and carried back unchanged. Typing is faster than a
      round trip, so a result that arrives after the line has moved on must be
      *droppable* — the host compares the sequence it asked with the one that
      came back and ignores anything stale. Without it a suggestion computed for
      a line nobody is on any more would be offered for the line they are.
    */
    case "suggest-results": {
      if (typeof row.seq !== "number" || !Array.isArray(row.items)) return null;
      const items = [];
      for (const entry of row.items) {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
        const one = /** @type {Record<string, unknown>} */ (entry);
        if (typeof one.text !== "string") return null;
        if (items.length >= SUGGEST_MAX) continue;
        items.push({ text: one.text.slice(0, 200) });
      }
      return { type: "suggest-results", seq: row.seq, items };
    }
    /*
      A plugin opened or closed its suggestion dialog.

      The console draws the dialog, so this is the plugin asking for one rather
      than announcing one it made. Nonce-authenticated like every observable
      event: a forged open would put a dialog carrying somebody else's
      placeholder in front of a reader, over a plugin's name.

      `placeholder` and the instruction rows are the plugin's own text, bounded
      here as well as in the guest — a cap the untrusted half applies to itself
      is not a cap, which is the rule `STATUS_BAR_MAX` already states.
    */
    case "suggest-modal": {
      if (typeof row.open !== "boolean") return null;
      const instructions = [];
      for (const entry of Array.isArray(row.instructions) ? row.instructions : []) {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
        const one = /** @type {Record<string, unknown>} */ (entry);
        if (typeof one.command !== "string" || typeof one.purpose !== "string") return null;
        if (instructions.length >= SUGGEST_MODAL_INSTRUCTIONS_MAX) continue;
        instructions.push({
          command: one.command.slice(0, 40),
          purpose: one.purpose.slice(0, 120),
        });
      }
      return {
        type: "suggest-modal",
        open: row.open,
        placeholder: typeof row.placeholder === "string" ? row.placeholder.slice(0, 120) : "",
        instructions,
      };
    }
    /*
      A plain text dialog, opened or closed.

      `Modal` has no query and no pick, so unlike `suggest-modal` there is
      nothing to route back — the console draws the title and the body and
      offers a way out. The text is re-sent on every mutation of the dialog's
      own DOM, because a plugin may fill it asynchronously and the one this was
      written for does.

      Bounded here as well as in the guest, for `suggest-modal`'s reason: a cap
      the untrusted half applies to itself is not a cap.
    */
    case "text-modal": {
      if (typeof row.open !== "boolean") return null;
      return {
        type: "text-modal",
        open: row.open,
        title: typeof row.title === "string" ? row.title.slice(0, TEXT_MODAL_TITLE_CAP) : "",
        text: typeof row.text === "string" ? row.text.slice(0, TEXT_MODAL_TEXT_CAP) : "",
      };
    }
    /*
      What the open dialog would show for the query the reader typed.

      The same shape and the same bounds as `suggest-results`, and `seq` carries
      the same weight: typing outruns the round trip, so a list computed for a
      query nobody is on any more must be droppable rather than drawn.
    */
    case "suggest-modal-results": {
      if (typeof row.seq !== "number" || !Array.isArray(row.items)) return null;
      const items = [];
      for (const entry of row.items) {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
        const one = /** @type {Record<string, unknown>} */ (entry);
        if (typeof one.text !== "string") return null;
        if (items.length >= SUGGEST_MAX) continue;
        items.push({ text: one.text.slice(0, 200) });
      }
      return { type: "suggest-modal-results", seq: row.seq, items };
    }
    /*
      The pick landed, and whether the plugin opened another dialog while
      handling it.

      `reopened` is not a convenience: `onChooseSuggestion` runs in the guest and
      may call `open()` again — a two-step flow picks a translation and then a
      verse — so a console that closed unconditionally on a pick would shut the
      dialog the plugin had just asked for. Required as a boolean rather than
      coerced, for `command-result`'s reason: a missing field would invent an
      answer the guest never gave.
    */
    case "suggest-modal-picked":
      return typeof row.seq === "number" && typeof row.reopened === "boolean"
        ? { type: "suggest-modal-picked", seq: row.seq, reopened: row.reopened }
        : null;
    /*
      The line the plugin's own selectSuggestion produced.

      The *trusted* editor makes this edit, through its own editing path, which
      is why a suggester needs no write grant: it is the person typing, and it
      undoes like anything else they typed. Bounded, because the guest wrote it.
    */
    case "suggest-applied":
      return typeof row.seq === "number" && typeof row.line === "string"
        ? { type: "suggest-applied", seq: row.seq, line: row.line.slice(0, 4000) }
        : null;
    /*
      What a plugin's markdown post-processor attached to each link.

      Text keyed to an href, bounded twice, nonce-authenticated like every
      other observable event. A forged one would put a plugin's words — or
      anybody's — into a tooltip over a person's own note, next to a link they
      wrote, with the plugin's name on it.

      The href is echoed rather than indexed, because the guest may answer for
      a subset: a processor that ignored a link reports nothing for it, and a
      positional list would silently shift every remaining preview onto the
      wrong link. `seq` is carried back unchanged for the same reason a
      suggestion's is — a note can be closed or edited while a verse is being
      fetched.
    */
    case "preview-results": {
      if (typeof row.seq !== "number" || !Array.isArray(row.previews)) return null;
      const previews = [];
      for (const entry of row.previews) {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
        const one = /** @type {Record<string, unknown>} */ (entry);
        if (typeof one.href !== "string" || typeof one.text !== "string") return null;
        if (previews.length >= PREVIEW_LINKS_MAX) continue;
        previews.push({ href: one.href.slice(0, 2000), text: one.text.slice(0, PREVIEW_TEXT_MAX) });
      }
      return { type: "preview-results", seq: row.seq, previews };
    }
    case "registration":
      return (row.kind === "command" || row.kind === "ribbon") &&
        typeof row.id === "string" &&
        typeof row.name === "string"
        ? {
            type: "registration",
            kind: row.kind,
            id: row.id.slice(0, 100),
            name: row.name.slice(0, 200),
            /*
              Absent means false, deliberately. A guest older than this field
              reports nothing, and reading that as "takes an editor" would
              disable every command on every card at once. False restores
              exactly the previous behaviour, and the guest still refuses the
              call itself, so the worst case is the error we already had.
            */
            needsEditor: row.needsEditor === true,
          }
        : null;
    default:
      return null;
  }
}
