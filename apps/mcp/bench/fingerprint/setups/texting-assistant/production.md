---
job: texting-assistant
max_steps: 24
open_web: yes
modules:
  texts: [about-tex, rules, tools, working, sound-like-a-person, pictures, how-you-talk]
  group: [about-tex, rules, tools, working, sound-like-a-person, pictures, how-you-talk]
  job: [about-tex, rules, tools, working]
search:
  everywhere: true
skills:
  stand-in-skill: a stand-in skill line, so the skills index is built
---

A stand-in for production's setup (`@context-lc ai/production/texting-assistant.md`), in its shape and none of its
words, so the prompt fingerprints (`promptFingerprint.mjs`) build every prompt the code assembles around it. A change
to the live setup's words is a production edit, fingerprinted on its own.
Its models, efforts and reviewer are Tex's config's (`packages/shared/src/texConfig.json`), as production's are.
