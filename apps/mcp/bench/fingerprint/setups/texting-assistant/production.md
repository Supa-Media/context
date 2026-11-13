---
job: texting-assistant
models:
  main: anthropic/claude-haiku-5-5
  advisor: anthropic/claude-opus-5-5
  fallback: "@cf/zai-org/glm-4.7-flash"
  effort: medium
  advisor_effort: high
max_steps: 24
reply_judge: haiku
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
