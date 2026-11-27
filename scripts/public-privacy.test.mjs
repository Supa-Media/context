import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { privacyContent, termsContent } from '../apps/mobile/features/legal/content.ts';

const decode = text => text.replace(/&(amp|lt|gt|quot|#39);/g, (_, entity) => ({amp:'&',lt:'<',gt:'>',quot:'"','#39':"'"})[entity]);
for (const [slug, content] of [['privacy', privacyContent], ['terms', termsContent]]) {
  test(`the public ${slug} page contains every current paragraph in its initial HTML`, async () => {
    const html = await readFile(new URL(`../apps/mobile/public/legal/${slug}/index.html`, import.meta.url), 'utf8');
    const paragraphs = [...html.matchAll(/<p(?: [^>]*)?>([\s\S]*?)<\/p>/g)].map(match => decode(match[1]));
    assert.ok(html.includes(`<h1>${content.title}</h1>`));
    assert.ok(html.includes(`<link rel="canonical" href="https://context.lc/legal/${slug}/">`));
    for (const paragraph of [content.intro, ...content.sections.flatMap(section => section.body)]) assert.ok(paragraphs.includes(paragraph), `Missing current ${slug} paragraph: `+paragraph.slice(0,70));
    const headings = [...html.matchAll(/<h2>([\s\S]*?)<\/h2>/g)].map(match => decode(match[1]));
    for (const section of content.sections) assert.ok(headings.includes(section.title), `Missing ${slug} section: ${section.title}`);
    assert.ok(html.includes(content.updated));
    assert.doesNotMatch(html, /<script|<iframe|<input/i);
    assert.doesNotMatch(html, /noindex/i);
  });
}
