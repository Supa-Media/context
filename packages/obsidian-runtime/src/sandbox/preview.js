// @ts-check
import { PREVIEW_LINKS_MAX, PREVIEW_TEXT_MAX } from "./message.js";

/**
 * The read preview: a plugin's markdown post-processor runs against a document built in here, and only preview text crosses.
 *
 * Moved verbatim out of `pluginSandboxDocument()` in ../sandbox.js; this is
 * source text for the sandboxed document, not code that runs in this realm.
 */
export const PREVIEW_JS = `  /*
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

`;
