---
name: handoff
description: >
  Project-wide multi-agent handoff skill. Use at the START of any task to read existing
  handoff notes and inherit context, and at the END of any task to write a structured
  handoff note for the next agent. Trigger on: "handover", "handoff", "write a handoff
  note", "pass to next agent", "read handoff notes", "pick up from where we left off",
  "what did the last agent do", "继续上次的工作", "写交接记录", "交接给下一个agent",
  or any time an agent starts a multi-step task and needs to establish shared context.
---

# Handoff Skill — Multi-Agent Context Continuity

This skill manages project-wide context across agents and sessions using a structured
file-based handoff system under `conversations/`.

---

## Directory layout

```
conversations/
  {YYMMDD}-{slug}/                       ← one directory per task thread
    {DDhhmm}-{model-family}-{verb}-{noun}.md   ← one note per agent session
```

| Field        | Format                                         | Example                                 |
| ------------ | ---------------------------------------------- | --------------------------------------- |
| `YYMMDD`     | date the thread started (`date +%y%m%d`)       | `260530`                                |
| `slug`       | 2–5 word kebab-case task description           | `ch1-diagnosis`, `chapter4-draft`       |
| `DDhhmm`     | day+hour+minute of writing (24h, no separator) | `301502` = 30th, 15:02                  |
| `model-family` | the model family running this session        | `claude`, `gpt`, `gemini`, `deepseek`, `kimi` |
| `verb`       | one action word: what you did                  | `diagnosed`, `drafted`, `fixed`         |
| `noun`       | 1–2 kebab-case words: what was acted on        | `ch4`, `figures`, `bibliography`        |

---

## Mode A — Context ingestion (start of a task)

**Do this before any substantive work when context from a prior session may exist.**

1. `ls conversations/` — list all thread directories. The ISO-date prefix makes them
   chronologically sortable; take the **most recently created** folder.
2. **Assess relevance**: compare the folder slug with the current task description.
   Consider them matching when the slug keywords substantially overlap with what the
   user is now asking to do (e.g., slug `ch4-draft` ↔ task "work on chapter 4 figures"
   → match; slug `ch4-draft` ↔ task "fix bibliography" → mismatch).
3. **If matching** — read ALL `.md` files in that thread, sorted lexicographically by
   filename (`DDhhmm` order is chronological). Report to the user: which thread, what
   decisions are locked in, what is pending, any blockers. The handoff note (Mode B)
   will go into **this same folder**.
4. **If not matching** (or `conversations/` is empty) — automatically create
   `conversations/{today}-{slug}/` using `date +%y%m%d` for the date and a 2–5 word
   kebab-case slug derived from the current task. Inform the user of the new folder.
   No prior context to read; proceed directly to Mode B when work is done.

---

## Mode B — Handoff note writing (end of task or explicit handoff request)

**Do this when finishing work, switching agents, or hitting a natural stopping point.**

1. **Pick the directory — and re-check that it matches what you actually did.** Start
   from whichever folder was determined in Mode A. Then compare that folder's slug
   against **what this note is really about**. A single session can drift across
   several unrelated tasks; don't dump everything into the first folder. If the work
   you are now writing up no longer matches the folder slug (e.g. the session opened in
   `ch4-draft` but you ended up fixing the bibliography), create a fresh
   `conversations/{today}-{new-slug}/` for it and write the note there instead — same
   relevance rule as Mode A step 2–4. Do **not** ask the user which folder to use; the
   slug comparison decides.
2. **Generate the filename**: run `date +%d%H%M` to get `DDhhmm`. Combine:
   `{DDhhmm}-{model-family}-{verb}-{noun}.md`
3. **Pick `{model-family}`**: use the **model family name** in lowercase — the underlying model, not the tool or host that invoked it. If Claude Code is running a DeepSeek model, write `deepseek`, not `claude`.
   - Claude family → `claude`
   - GPT family → `gpt`
   - Gemini family → `gemini`
   - DeepSeek family → `deepseek`
   - Kimi / Moonshot family → `kimi`
   - Unknown → use the provider name from the model ID (e.g. `mistral`, `llama`)
4. **Pick `{verb}`**: one word, from the table below or your own.
5. **Pick `{noun}`**: 1–2 kebab-case words naming what was acted on.
   Examples: `ch4`, `figures`, `bibliography`, `ch1-gaps`, `ref-bib`.
6. **Write the note** using the template in the next section.
7. **Confirm** the full file path to the user.

### Verb vocabulary

| Situation                     | Verb         |
| ----------------------------- | ------------ |
| Completed a diagnostic review | `diagnosed`  |
| Drafted or rewrote content    | `drafted`    |
| Fixed a bug or error          | `fixed`      |
| Left review comments only     | `reviewed`   |
| Work in progress, passing on  | `continue`   |
| Blocked, needs human decision | `blocked`    |
| Task fully complete           | `complete`   |
| Next agent should verify      | `verify`     |
| Researched and summarized     | `researched` |
| Refactored structure          | `refactored` |

---

## Handoff note template

**Write the handoff note in the same language the user has been using in their prompts.**
If the user writes to you in Chinese, write the note in Chinese; if in English, write in
English; and so on. The template below is in English — translate the section headings to
the user's language when needed, but keep proper nouns (file paths, identifiers, commands,
tool names) as-is.

```markdown
# Handoff Note — {DDhhmm} · {model-family} · {verb}-{noun}

## Inherited context

<!-- What you read from earlier handoff notes; key decisions already locked in -->

## Work done this session

- [x] Completed item 1
- [x] Completed item 2
- [ ] Unfinished item (if any)

## Current state

<!-- Which files changed, which commands were run, what state things are in now -->

| File             | Change |
| ---------------- | ------ |
| path/to/file.tex | …      |

## Open tasks for the next agent

1. Highest-priority action (specific, executable)
2. Next action
3. …

## Key decisions

| Decision       | Rationale                       |
| -------------- | ------------------------------- |
| Chose option A | Reviewer flagged problem X in B |

## Blockers

- (none) — or describe the specific blocker and what's needed to clear it

## Suggested next step

One sentence: the first thing the next agent should do on picking this up.
```

---

## Rules

1. **Never overwrite** an existing note — `DDhhmm` timestamp ensures uniqueness.
   If you need a second note in the same minute, append `-2` to the noun: `301502-claude-drafted-ch4-2.md`.
2. **Slug stability** — once a thread directory is created, don't rename it even if scope shifts.
3. **Cross-references** — reference prior notes by relative path:
   `见 conversations/260530-ch1-diagnosis/300915-deepseek-diagnosed-ch1.md`
4. **Completeness over brevity** — the Open Tasks section must be specific enough that a fresh
   agent with no prior conversation history can act on it. Avoid "continue the work" — name
   exact files and what to do to them.
5. **Decision rationale** — record _why_ a decision was made, not just what it was. This
   prevents the next agent from undoing a deliberate choice.
6. **Read before write** — always run Mode A before Mode B in the same session, so the
   new note reflects accumulated context.
7. **Auto-route without asking** — when no explicit "new thread" or "continue" instruction
   is given, determine the folder via Mode A relevance assessment, then re-confirm it at
   write time (Mode B step 1) against what the note is actually about. If the session
   drifted to a different task, the note goes in its own folder. Do not ask the user
   which folder to use; the slug comparison is sufficient to decide.

---

## Example session flow

```
User: "Let's work on chapter 4."

Agent (Mode A):
  → ls conversations/
  → most recent: 260531-supervisor-review/
  → slug "supervisor-review" vs task "chapter 4" → mismatch
  → automatically creates conversations/260601-ch4-draft/
  → reports: "No matching thread found. Started new thread: conversations/260601-ch4-draft/"

... agent works on chapter 4 ...

Agent (Mode B):
  → date +%d%H%M → "011502"
  → writes conversations/260601-ch4-draft/011502-claude-drafted-ch4.md
  → reports: "Handoff note written to conversations/260601-ch4-draft/011502-claude-drafted-ch4.md"


User: "Keep working on chapter 4 figures."

Agent (Mode A):
  → ls conversations/
  → most recent: 260601-ch4-draft/
  → slug "ch4-draft" vs task "chapter 4 figures" → match
  → reads 011502-claude-drafted-ch4.md
  → reports: "Continuing in 260601-ch4-draft. Previous: drafted section 4.2,
    figures pending for DependBench pipeline."

... agent works on figures ...

Agent (Mode B):
  → date +%d%H%M → "011748"
  → writes conversations/260601-ch4-draft/011748-claude-drafted-figures.md
  → reports: "Handoff note written to conversations/260601-ch4-draft/011748-claude-drafted-figures.md"
```
