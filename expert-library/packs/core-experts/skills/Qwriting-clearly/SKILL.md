---
name: Qwriting-clearly
description: Refines text for clarity and conciseness using Strunk's principles, and removes AI-generated writing patterns. Use when writing or polishing documentation, commit messages, error messages, reports, or UI text, or when text sounds robotic, overly formal, or AI-like.
metadata:
source: "qe-framework/skills/Qwriting-clearly"
author: QE Framework
version: 1.0.0
domain: writing
triggers: writing clarity, concise writing, humanize text, remove AI patterns, de-AI, documentation polish, commit message polish, UI copy, error messages
role: specialist
scope: implementation
output-format: document
related-skills: Qcontent-research-writer, Qfact-checker
keywords: writing, clarity, concision, Strunk, Elements of Style, humanize, AI writing, editing, documentation
invocation_trigger: When improving prose or documentation clarity, humanizing text, or removing AI-generated writing patterns.
recommendedModel: haiku
---


# Writing Clearly and Concisely

## Overview

Write clearly and with force. This skill covers what to do (Strunk) and what to avoid (AI patterns).

## When to Use This Skill

Use this skill any time you are writing for a human:

- Documentation, README files, technical explanations
- Commit messages, pull request descriptions
- Error messages, UI copy, help text, comments
- Reports, summaries, or any form of explanation
- Proofreading to improve clarity

If you are writing a sentence a human will read, use this skill.

## Strategy When Context Is Tight

When context is limited:

1. Draft based on judgment
2. Hand the draft and relevant section files to a teammate
3. Have the teammate proofread and return a revised version

Loading a single section instead of full content saves significant context.

## Elements of Style

William Strunk Jr.'s *The Elements of Style* (1918) teaches how to write clearly and cut ruthlessly.

### Rules

Elementary rules of usage:

1. Form the possessive singular by adding 's
2. Use a comma after each term in a series except the last
3. Enclose parenthetic expressions between commas
4. Place a comma before a conjunction introducing an independent clause
5. Do not join independent clauses with a comma
6. Do not break sentences in two
7. A participial phrase at the beginning of a sentence must refer to the grammatical subject

Elementary principles of composition:

8. Make the paragraph the unit of composition: one topic per paragraph
9. Begin each paragraph with a topic sentence
10. Use the active voice
11. Put statements in positive form
12. Use definite, specific, concrete language
13. Omit needless words
14. Avoid a succession of loose sentences
15. Express coordinate ideas in similar form
16. Keep related words together
17. In summaries, keep to one tense
18. Place the emphatic words of a sentence at the end

For most tasks, the core Strunk principles are active voice, positive statements, specific language, and cutting needless words.

## AI Writing Patterns: What to Avoid

LLMs tend to regress toward statistical averages, producing cliched and bloated prose. Avoid:

- Inflated words: pivotal, crucial, vital, testament, enduring legacy
- Empty "-ing" phrases: ensuring reliability, showcasing features, highlighting capabilities
- Promotional adjectives: groundbreaking, seamless, robust, cutting-edge
- AI cliches: delve, leverage, multifaceted, foster, realm, tapestry
- Formatting abuse: excessive bullet points, emoji decoration, bold on every other sentence

Do not write grandly. Describe concretely what is happening.

## AI Pattern Removal

Based on Wikipedia's "Signs of AI Writing" (WikiProject AI Cleanup). Use this section when editing text that sounds robotic, overly formal, or AI-generated.

### Role

When humanizing text:

1. Identify AI patterns - scan for the patterns listed below
2. Rewrite problem passages - replace them with natural alternatives
3. Preserve meaning - keep the core message intact
4. Maintain tone - match intended register: formal, conversational, or technical
5. Add personality - inject real character, not just remove bad patterns

### Personality and Voice

Flat, voiceless prose is as detectable as AI-generated text. Signs of lifeless writing include uniform sentence length, no opinions, no uncertainty, no first person, no humor or edge, and a press-release tone.

To add voice, have opinions, vary rhythm, acknowledge complexity, use "I" where appropriate, allow some messiness, and be specific.

### Content Patterns

1. Inflated significance, legacy, or broad trends
   Watch words: symbol of, testament to, pivotal/crucial role, underscores the importance, enduring legacy, evolving landscape.
   Fix: Remove inflated framing. State what happened.

2. Inflated notability or media coverage
   Watch words: independent coverage, regional/national media outlets, active social media presence.
   Fix: Replace vague notability claims with specific citations.

3. Superficial analysis via "-ing" phrases
   Watch words: emphasizing, highlighting, showcasing, ensuring, reflecting, symbolizing, contributing, fostering.
   Fix: Remove dangling "-ing" clauses. State the actual fact or source.

4. Promotional or advertising language
   Watch words: boasting, vibrant, rich (figurative), profound, groundbreaking, renowned, breathtaking, nestled in.
   Fix: Replace promotional adjectives with concrete facts.

5. Vague attribution or hedged claims
   Watch words: according to industry reports, observers noted, experts argue, some critics claim.
   Fix: Name the specific source and date.

6. Outline-style "Challenges and Future Outlook"
   Watch words: despite ... faces several challenges, future outlook.
   Fix: Replace formulaic sections with specific facts and dates.

### Language and Grammar Patterns

7. Overused AI cliches
   Replace additionally, furthermore, delve, foster, garner, underscore, landscape (abstract), pivotal, showcase, tapestry, testament, invaluable, and vibrant with plain language or remove them.

8. Copula avoidance
   Replace serves as, stands as, represents, boasts, and features with simple "is," "are," or "has."

9. Negative parallelism
   Replace "not only... but also..." with a direct statement.

10. Rule of three overuse
    Do not force groups of three. Use the actual number of items.

11. Elegant variation
    Do not swap synonyms for the same concept. Repeat the word.

12. False range expressions
    Do not use "from X to Y" when X and Y are not on a meaningful scale.

### Style Patterns

13. Em-dash overuse
    Replace most em dashes with commas, periods, or parentheses.

14. Bold overuse
    Remove mechanical bolding of terms that do not need emphasis.

15. Inline header lists
    Convert bold-header bullet lists into flowing prose.

16. Title case overuse
    Use sentence case for headings.

17. Emoji
    Remove decorative emoji from headings and list items.

18. Curly quotes
    Replace curly quotes with straight quotes.

### Communication Patterns

19. Collaborative communication artifacts
    Remove chatbot response phrases: I hope this helps, Of course!, Certainly!, Would you like, Let me know, Here is.

20. Training data cutoff disclosures
    Replace "as of my knowledge cutoff" with actual sources and dates.

21. Sycophantic tone
    Remove excessive praise. State the substance.

### Filler and Hedging

22. Filler phrases
    Replace "in order to achieve this goal" with "to achieve this," "due to the fact that" with "because," "has the ability to" with "can," and delete "it is important to note that."

23. Excessive hedging
    Reduce qualifiers. Replace "could potentially might have some influence" with "may influence outcomes."

24. Vague positive endings
    Replace bland optimism with specific plans.

### Process

1. Read the input text carefully
2. Identify every instance matching the patterns above
3. Rewrite each problem passage
4. Confirm the revised text sounds natural aloud, has varied sentence structure, specific details, and appropriate tone
5. Present the humanized version with a brief summary of changes when useful

### Reference

[Wikipedia: Signs of AI Writing](https://en.wikipedia.org/wiki/Wikipedia:Signs_of_AI_writing) - Core insight: LLMs predict what comes next, so their output tends to converge on the most statistically plausible outcome for broad cases.
