// @ts-check
/**
 * A plugin's own settings pane, described as rows the console draws and driven back through Setting/PluginSettingTab.
 *
 * Moved verbatim out of `pluginSandboxDocument()` in ../sandbox.js; this is
 * source text for the sandboxed document, not code that runs in this realm.
 */
export const SETTINGS_JS = `  /*
    A PLUGIN'S OWN SETTINGS PANE, BY THE SAME INVERSION AS THE DIALOGS.

    display() runs in here, against a real containerEl, and builds exactly what
    it would build in Obsidian. What crosses is a DESCRIPTION of the controls —
    a kind, a name, a description, a current value, a list of options — and the
    console draws its own. A change comes back as an index and a value, and the
    plugin's own onChange runs in here.

    So no markup reaches the trusted realm, which matters more here than
    anywhere else in this file: the pane this was written against opens with a
    sponsor iframe and a tracking image, set through innerHTML. Neither can
    cross a boundary that carries text and control descriptions.

    ## Order comes from the DOM, not from a list

    Setting appends its own element to containerEl on construction, and the
    describe walk goes over containerEl's children. So a heading the plugin
    wrote with createEl between two Settings lands between them, without
    anything having to track interleaving. It is the plugin's own document
    order because it IS the plugin's own document order.

    ## Why it is lazy

    display() may fetch, and for this plugin it does. Nothing here runs until a
    reader asks for the pane, which is also why addSettingTab only records.
  */
  /*
    Caps on what one settings pane may put on screen, applied here and again on
    the trusted side. A cap the untrusted half enforces alone is not a cap —
    the rule STATUS_BAR_MAX already states, and the reason every one of these
    has a twin in parsePluginSandboxMessage.
  */
  const SETTING_TEXT_MAX = 200;
  const SETTING_DESC_MAX = 600;
  const SETTING_VALUE_MAX = 400;
  const SETTING_OPTIONS_MAX = 60;
  const SETTING_ROWS_MAX = 120;

  /**
   * A plugin's string, bounded and stripped of anything that can redraw a line.
   *
   * These end up beside Context's own words on Context's own screen, so the
   * same category strip the plugin report applies to a manifest applies here:
   * control and format characters, line and paragraph separators, and the bidi
   * block. A settings row that can reverse the text after it is a row that can
   * make another row read as something it is not.
   */
  function str(value, maximum) {
    return String(value === null || value === undefined ? '' : value)
      /*
        Doubled, and that is not style: this whole file is the body of a
        template literal, so a single-backslash escape here is resolved by
        the literal and the sandbox receives the CHARACTER rather than the
        escape. The first version emitted a regex with a real NUL in it and
        the guest died on "Invalid regular expression: missing /" before
        onload, taking the whole plugin with it — this package's oldest failure
        shape wearing a new hat. normalizePath above doubles its own for the
        same reason. (No backticks in here: template literal.)
      */
      .replace(/[\\u0000-\\u001f\\u007f-\\u009f\\u200b-\\u200f\\u2028\\u2029\\u202a-\\u202e\\u2066-\\u2069]/g, ' ')
      .slice(0, maximum);
  }

  /** Every Setting built, keyed by the element it put in its container. */
  const settingsByElement = new WeakMap();

  const settingTabs = [];
  /** Controls the open pane has published, by index. Replaced on every describe. */
  let paneControls = [];
  /** The tab currently being drawn, if any, and its observer. */
  let openPane = null;
  /** The observer on the open pane, so a re-display is noticed without polling. */
  let paneWatch = null;
  /** What display() threw, if it did, so the pane can say it stopped part-way. */
  let paneError = null;

  class Setting {
    constructor(containerEl) {
      /*
        A container is not optional in practice — every real caller passes
        this.containerEl — but a Setting built without one must not throw and
        take the whole display() with it. It gets a detached element and is
        simply never walked.
      */
      this.settingEl = containerEl && typeof containerEl.createDiv === 'function'
        ? containerEl.createDiv()
        : createDiv();
      this.settingEl.setAttr('data-context-setting', '1');
      this.nameText = '';
      this.descText = '';
      this.tooltipText = '';
      this.heading = false;
      this.disabled = false;
      /** The controls this row carries, in the order they were added. */
      this.controls = [];
      settingsByElement.set(this.settingEl, this);
    }
    setName(value) { this.nameText = str(value, SETTING_TEXT_MAX); return this; }
    setDesc(value) { this.descText = str(value, SETTING_DESC_MAX); return this; }
    setTooltip(value) { this.tooltipText = str(value, SETTING_DESC_MAX); return this; }
    setHeading() { this.heading = true; return this; }
    setClass() { return this; }
    setDisabled(value) { this.disabled = !!value; return this; }
    /*
      Each add* hands the plugin a control object, runs its callback
      immediately — which is where setValue and onChange are wired, exactly as
      in Obsidian — and keeps the result. The callback may throw; one bad row
      must not take the pane down, so it is caught and the row still appears
      with whatever it had managed to set.
    */
    addToggle(build) { return this.__contextAdd('toggle', { value: false }, build); }
    addText(build) { return this.__contextAdd('text', { value: '', placeholder: '' }, build); }
    addTextArea(build) { return this.__contextAdd('text', { value: '', placeholder: '', multiline: true }, build); }
    addSearch(build) { return this.__contextAdd('text', { value: '', placeholder: '' }, build); }
    addDropdown(build) { return this.__contextAdd('dropdown', { value: '', options: [] }, build); }
    addButton(build) { return this.__contextAdd('button', { label: '' }, build); }
    addExtraButton(build) { return this.__contextAdd('button', { label: '' }, build); }
    addSlider(build) { return this.__contextAdd('slider', { value: 0, min: 0, max: 100, step: 1 }, build); }
    __contextAdd(kind, seed, build) {
      const control = makeSettingControl(kind, seed);
      this.controls.push(control);
      if (typeof build === 'function') {
        try { build(control.api); } catch (_) {}
      }
      return this;
    }
  }

  /**
   * One control on a Setting row: the object a plugin is handed, and the state
   * the console is told about.
   *
   * The plugin's own onChange lives here and runs here. Nothing about it
   * crosses; what crosses is the kind, the value and the options.
   */
  function makeSettingControl(kind, seed) {
    const state = { kind, disabled: false, ...seed };
    let onChange = null;
    let onClick = null;
    const api = {
      setValue(value) {
        state.value = kind === 'toggle' ? !!value : kind === 'slider' ? Number(value) || 0 : str(value, SETTING_VALUE_MAX);
        return api;
      },
      getValue() { return state.value; },
      setPlaceholder(value) { state.placeholder = str(value, SETTING_TEXT_MAX); return api; },
      setDisabled(value) { state.disabled = !!value; return api; },
      setTooltip() { return api; },
      setIcon() { return api; },
      setCta() { return api; },
      setWarning() { return api; },
      setButtonText(value) { state.label = str(value, SETTING_TEXT_MAX); return api; },
      setName(value) { state.label = str(value, SETTING_TEXT_MAX); return api; },
      addOption(value, label) {
        if (state.options && state.options.length < SETTING_OPTIONS_MAX) {
          state.options.push({ value: str(value, SETTING_VALUE_MAX), label: str(label, SETTING_TEXT_MAX) });
        }
        return api;
      },
      addOptions(record) {
        for (const key of Object.keys(record || {})) api.addOption(key, record[key]);
        return api;
      },
      setLimits(min, max, step) {
        state.min = Number(min) || 0;
        state.max = Number(max) || 0;
        state.step = Number(step) || 1;
        return api;
      },
      setDynamicTooltip() { return api; },
      onChange(handler) { if (typeof handler === 'function') onChange = handler; return api; },
      onClick(handler) { if (typeof handler === 'function') onClick = handler; return api; },
      // Obsidian's text control exposes its input element. A plugin reaches for
      // it to set an attribute or a type; handing back a real detached element
      // keeps that from throwing, and nothing drawn on it is ever read.
      inputEl: createEl('input'),
      selectEl: createEl('select'),
      toggleEl: createDiv(),
      buttonEl: createEl('button'),
      sliderEl: createEl('input'),
      containerEl: createDiv(),
    };
    return { state, api, fire: value => {
      if (state.kind === 'button') { if (onClick) onClick({}); return; }
      api.setValue(value);
      if (onChange) onChange(state.value);
    } };
  }

  /**
   * What the open pane looks like, as rows the console can draw.
   *
   * Walks containerEl's own children in document order. A child that a Setting
   * registered becomes that Setting's rows; a heading element becomes a
   * heading; anything else contributes its text and nothing else. That last
   * case is why this is a walk rather than a list of Settings: a pane opens
   * with prose and section headings the plugin wrote directly, and dropping
   * them would leave the controls with nothing to explain them.
   *
   * paneControls is rebuilt here, and that is what a change is addressed
   * against. So an index can only ever name a control in the pane as it was
   * last described — the rule the suggestion dialog keeps for its own values.
   */
  function describePane(tab) {
    const rows = [];
    const controls = [];
    const children = tab.containerEl ? Array.from(tab.containerEl.children) : [];
    for (const child of children) {
      if (rows.length >= SETTING_ROWS_MAX) break;
      // A control the plugin hid is one it has decided does not apply. Drawing
      // it anyway would offer a setting the plugin itself refuses to show.
      if (child.hasAttribute && child.hasAttribute(HIDDEN_ATTR)) continue;
      const setting = settingsByElement.get(child);
      if (setting) {
        if (setting.heading && setting.controls.length === 0) {
          rows.push({ kind: 'heading', level: 2, text: setting.nameText });
          continue;
        }
        for (const control of setting.controls) {
          const index = controls.length;
          controls.push(control);
          rows.push({
            kind: control.state.kind,
            index,
            name: setting.nameText,
            desc: setting.descText || setting.tooltipText,
            disabled: !!(setting.disabled || control.state.disabled),
            value: control.state.value,
            label: control.state.label || '',
            placeholder: control.state.placeholder || '',
            options: (control.state.options || []).map(one => ({ value: one.value, label: one.label })),
          });
        }
        /*
          A Setting with a name and no control is a label the plugin wrote
          through the Setting API rather than through createEl. It is still
          something a reader needs to see, so it becomes a note rather than
          vanishing because it happened to carry no input.
        */
        if (setting.controls.length === 0 && (setting.nameText || setting.descText)) {
          rows.push({ kind: 'note', text: [setting.nameText, setting.descText].filter(Boolean).join(' — ') });
        }
        continue;
      }
      const tag = String(child.tagName || '').toLowerCase();
      const heading = /^h([1-6])$/.exec(tag);
      const text = str(child.textContent, SETTING_DESC_MAX).trim();
      if (heading) {
        if (text) rows.push({ kind: 'heading', level: Number(heading[1]), text });
        continue;
      }
      /*
        Everything else contributes its words and nothing else. The pane this
        was written against opens with a sponsor iframe and a tracking image,
        both set through innerHTML: an iframe carries no text and disappears
        here, and the anchor around the image carries its label and arrives as
        plain words. Neither the frame, the image, nor the link survives, which
        is the whole point of describing rather than forwarding.
      */
      if (text) rows.push({ kind: 'note', text });
    }
    paneControls = controls;
    return rows;
  }

  /**
   * Run the plugin's display() and report what it drew.
   *
   * display() may be async and may fetch, so the rows are pushed when it
   * settles as well as immediately — the same pair Modal.open() uses, and for
   * the same plugin. The observer then covers the third case: a pane that
   * calls this.display() again from its own event handler, which is exactly
   * how the one this was built against redraws after a toggle.
   */
  async function openSettingsPane() {
    const tab = settingTabs[0];
    if (!tab) return;
    openPane = tab;
    try { tab.containerEl.empty(); } catch (_) {}
    watchPane(tab);
    let pending;
    /*
      A display() that throws part-way leaves a pane with some of its settings
      and no sign that the rest are missing — which is worse than an error,
      because it looks like the plugin simply has fewer options. So the failure
      is carried on the pane and drawn, rather than swallowed.
    */
    paneError = null;
    try {
      pending = tab.display();
    } catch (e) {
      pending = null;
      paneError = str(e && e.message, SETTING_DESC_MAX);
    }
    pushPane();
    try {
      await Promise.resolve(pending);
    } catch (e) {
      paneError = str(e && e.message, SETTING_DESC_MAX);
    }
    pushPane();
  }

  function pushPane() {
    if (openPane === null) return;
    send('settings-pane', { open: true, rows: describePane(openPane), error: paneError });
  }

  function watchPane(tab) {
    if (paneWatch !== null || typeof MutationObserver !== 'function') return;
    paneWatch = new MutationObserver(() => pushPane());
    paneWatch.observe(tab.containerEl, { childList: true, subtree: true, characterData: true });
  }

  function unwatchPane() {
    if (paneWatch === null) return;
    paneWatch.disconnect();
    paneWatch = null;
  }

  function closeSettingsPane() {
    const tab = openPane;
    openPane = null;
    paneControls = [];
    paneError = null;
    unwatchPane();
    if (tab && typeof tab.hide === 'function') {
      try { tab.hide(); } catch (_) {}
    }
  }

  /**
   * A reader worked one of the controls.
   *
   * The index names a control in the pane AS LAST DESCRIBED, and nothing else:
   * describePane rebuilds paneControls every time it runs, so an index past
   * the end is a change aimed at a pane that is no longer on screen and does
   * nothing. The plugin's own onChange then runs in here, where it can reach
   * the vault only through the grants everything else uses.
   */
  async function changeSettingsPane(message) {
    if (openPane === null) return;
    const control = paneControls[message.index];
    if (!control) return;
    try { await Promise.resolve(control.fire(message.value)); } catch (_) {}
    /*
      Pushed after the handler, because a plugin commonly saves and then
      re-reads its own settings — and because a handler that refuses a value
      must be able to put the old one back on screen. The observer covers a
      redraw; this covers a value that changed without the DOM changing.
    */
    pushPane();
  }

  class PluginSettingTab {
    constructor(appValue, plugin) {
      this.app = appValue;
      this.plugin = plugin;
      this.containerEl = createDiv();
    }
    display() {}
    hide() {}
  }
`;
