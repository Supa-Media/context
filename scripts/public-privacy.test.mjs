import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { privacyContent } from '../apps/mobile/features/legal/content.ts';

const decode = text => text.replace(/&(amp|lt|gt|quot|#39);/g, (_, entity) => ({amp:'&',lt:'<',gt:'>',quot:'"','#39':"'"})[entity]);
test('the public policy contains every current disclosure in its initial HTML', async () => {
 const html = await readFile(new URL('../apps/mobile/public/privacy.html', import.meta.url), 'utf8');
 const paragraphs = [...html.matchAll(/<p(?: [^>]*)?>([\s\S]*?)<\/p>/g)].map(match => decode(match[1]));
 assert.ok(html.includes('<h1>Privacy Policy</h1>'));
 for (const paragraph of [privacyContent.intro, ...privacyContent.sections.flatMap(section => section.body)]) assert.ok(paragraphs.includes(paragraph), 'Missing current policy paragraph: '+paragraph.slice(0,70));
 for (const section of privacyContent.sections) assert.ok(html.includes('<h2>'+section.title+'</h2>'));
 assert.ok(html.includes(privacyContent.updated));
 assert.doesNotMatch(html, /<script|<iframe|<input/i);
});
