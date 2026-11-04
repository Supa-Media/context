/** Render the existing policy as a standalone public document for readers that do not execute the app. */
import { mkdir, writeFile } from 'node:fs/promises';
import { privacyContent } from '../apps/mobile/features/legal/content.ts';

const escape = value => value.replace(/[&<>"']/g, character => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[character]);
const policy = privacyContent;
const html = `<!doctype html>
<!-- Generated from features/legal/content.ts with: node scripts/build-public-privacy.mjs -->
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(policy.title)} | Context.LC</title>
<meta name="description" content="${escape(policy.intro)}">
<link rel="canonical" href="https://context.lc/legal/privacy/">
<style>
:root{color-scheme:light dark}body{margin:0;background:#f7f5f0;color:#1e2223;font:18px/1.7 system-ui,sans-serif}main{max-width:880px;margin:0 auto;padding:32px 24px 72px}nav{display:flex;gap:24px;flex-wrap:wrap;margin-bottom:56px}a{color:inherit}nav a:first-child{font-weight:700;margin-right:auto}h1{font-size:clamp(36px,7vw,64px);line-height:1.1;margin:12px 0 20px}h2{font-size:26px;line-height:1.3;margin:44px 0 16px}p{margin:0 0 20px}.updated,footer{color:#61686c}footer{margin-top:56px;border-top:1px solid #aab2b5;padding-top:24px}@media(prefers-color-scheme:dark){body{background:#161b1d;color:#edf0ed}.updated,footer{color:#acb5b7}}
</style>
</head>
<body><main>
<nav aria-label="Legal pages"><a href="/">Context.LC</a><a href="/legal/privacy/" aria-current="page">Privacy</a><a href="/terms">Terms</a></nav>
<header><h1>${escape(policy.title)}</h1><p class="updated">Last updated ${escape(policy.updated)}</p><p>${escape(policy.intro)}</p></header>
${policy.sections.map(section => `<section><h2>${escape(section.title)}</h2>\n${section.body.map(paragraph => `<p>${escape(paragraph)}</p>`).join('\n')}\n</section>`).join('\n')}
<footer><p>Context.LC is operated by Supa Media.</p><p>Questions: <a href="mailto:context@supa.media">context@supa.media</a></p></footer>
</main></body>
</html>
`;
await mkdir(new URL('../apps/mobile/public/legal/privacy/', import.meta.url), {recursive:true});
await writeFile(new URL('../apps/mobile/public/legal/privacy/index.html', import.meta.url), html);
console.log('Generated apps/mobile/public/legal/privacy/index.html from the existing policy.');
