// @ts-check
/**
 * TFile/TFolder and the vault, metadataCache and workspace shims a plugin calls against.
 *
 * Moved verbatim out of `pluginSandboxDocument()` in ../sandbox.js; this is
 * source text for the sandboxed document, not code that runs in this realm.
 */
export const VAULT_API_JS = `  class TFile {
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
    /*
      The open note's view, while there is one. Asking is recorded even when the
      answer is null: a plugin that reached for an editor and was handed nothing
      is a failure the reader should be told about, and one that never reached
      is not.

      The type is honoured rather than ignored. A plugin asking for its own view
      class, or for anything else this shim does not draw, gets null — answering
      a MarkdownView to a question about somebody else's view is how a plugin
      ends up calling methods that are not there.
    */
    getActiveViewOfType(type) {
      viewAsked = true;
      if (activeEditor === null) return null;
      if (typeof type === 'function' && !(activeEditor.view instanceof type)) return null;
      return activeEditor.view;
    },
    getLeavesOfType() { return []; },
  };

`;
