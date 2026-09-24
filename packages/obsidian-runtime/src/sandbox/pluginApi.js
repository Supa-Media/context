// @ts-check
/**
 * The app object plus the Plugin, Notice, Component and Events classes a plugin bundle is built against.
 *
 * Moved verbatim out of `pluginSandboxDocument()` in ../sandbox.js; this is
 * source text for the sandboxed document, not code that runs in this realm.
 */
export const PLUGIN_API_JS = `  const app = { vault, metadataCache, workspace };

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
    /*
      Recorded, not run. display() may fetch — the pane this was built against
      does — so nothing here happens until a reader asks for the pane. One tab
      per plugin is what Obsidian allows and what this keeps.
    */
    addSettingTab(tab) {
      if (tab && typeof tab.display === 'function') {
        settingTabs.length = 0;
        settingTabs.push(tab);
        send('settings-tab', { present: true });
      }
    }
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

`;
