// @ts-check
/**
 * Compatibility patches Obsidian's augmented realm expects: Array/String prototype helpers and the HTMLElement/global createEl family.
 *
 * Moved verbatim out of `pluginSandboxDocument()` in ../sandbox.js; this is
 * source text for the sandboxed document, not code that runs in this realm.
 */
export const COMPAT_JS = `  // Obsidian keeps these aliases for plugins written against its augmented
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
  /**
   * What hide() marks an element with. (No backticks: template literal.)
   *
   * An attribute rather than only a style, because describePane has to be
   * able to ask — reading a computed style on a detached element that was
   * never in a document is not a question with a reliable answer.
   */
  const HIDDEN_ATTR = 'data-context-hidden';

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
    /*
      Obsidian's own visibility helpers, and a settings pane is where they get
      used: this one builds every control up front and hides the ones that do
      not apply, so without these display() threw half-way through and the
      reader got a pane silently missing most of its settings.

      A hidden element is skipped by describePane, which matters more than the
      style: a control the plugin deliberately hid must not be drawn, or Context
      offers a setting the plugin has decided is not applicable.
    */
    hide() { this.setAttr(HIDDEN_ATTR, '1'); this.style.display = 'none'; return this; },
    show() { this.removeAttribute(HIDDEN_ATTR); this.style.removeProperty('display'); return this; },
    toggleVisibility(on) { return on ? this.show() : this.hide(); },
    isShown() { return !this.hasAttribute(HIDDEN_ATTR); },
    getText() { return this.textContent; },
    addClasses(names) { return this.addClass(...(Array.isArray(names) ? names : [names])); },
    removeClasses(names) { return this.removeClass(...(Array.isArray(names) ? names : [names])); },
    setCssStyles(styles) {
      for (const name of Object.keys(styles || {})) {
        try { this.style[name] = styles[name]; } catch (_) {}
      }
      return this;
    },
    setCssProps(props) {
      for (const name of Object.keys(props || {})) {
        try { this.style.setProperty(name, String(props[name])); } catch (_) {}
      }
      return this;
    },
    insertAfter(node) {
      if (this.parentNode) this.parentNode.insertBefore(node, this.nextSibling);
      return node;
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

`;
