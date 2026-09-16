---
name: writing-plans
description: Use when you have a spec or requirements for a multi-step task, before touching code
---

# Writing Plans

<!-- Adapted from obra/superpowers (MIT, (c) 2025 Jesse Vincent).
     Execution handoffs repointed from superpowers' execution skills to /duet:wrap. -->

## Overview

Write comprehensive implementation plans assuming the engineer has zero context for our codebase and questionable taste. Document everything they need to know: which files to touch for each task, code, testing, docs they might need to check, how to test it. Give them the whole plan as bite-sized tasks. DRY. YAGNI. TDD. Frequent commits.

Assume they are a skilled developer, but know almost nothing about our toolset or problem domain. Assume they don't know good test design very well.

**Announce at start:** "I'm using the writing-plans skill to create the implementation plan."

**Context:** If working in an isolated worktree, create it before execution begins.

**Save plans to:** `<project root>/docs/plans/YYYY-MM-DD-<feature-name>.md`

That is the **project's** docs directory, not a user-level one. Resolve the
project root explicitly rather than trusting the current working directory:

```bash
git rev-parse --show-toplevel
```

and write the plan under that. Never write a plan to `~/docs/`, `~/.claude/`,
or anywhere outside the repository. The plan is a project artifact — it belongs
in the repo, committed alongside the code it describes, where the next person
(or the next you) will find it. A plan in your home directory is invisible to
everyone including the audit gate, which only starts a cycle for plans written
inside the project.

### Approval happens in plan mode, before anything is written

**Enter plan mode to present the plan.** Call `EnterPlanMode`, lay the plan out
there, and use `ExitPlanMode` to put it up for approval. That gives your human
partner the accept/reject UI rather than a wall of text they have to respond to
in prose, and it keeps the plan revisable — reject, discuss, present again, as
many rounds as it takes. Nothing is written to disk during any of this.

**Only write the plan file after they accept.** In order:

1. `EnterPlanMode` → present → `ExitPlanMode` → they accept
2. *Then* write `docs/plans/YYYY-MM-DD-<name>.md`
3. Writing that file starts duet's cycle and re-closes the gate on source edits
4. `/duet:wrap` → the plan goes to the auditor
5. Once the audit passes, build the task list and implement

Saving the plan is the act that means "this plan is agreed" — it is what the
duet hook watches for. A file written before acceptance starts a gated cycle
around a plan nobody signed off on, and unpicking that is more annoying than
waiting. So: accept first, write second, always.
- (User preferences for plan location override this default)

### Research agents are available — use them

Three read-only subagents exist for exactly this stage, and none of them are
blocked by duet's gate:

| agent | for | dispatch when |
|-------|-----|---------------|
| `duet-prior-art` | surveying what already exists | starting anything in a domain you have not built in before |
| `duet-scout` | codebase exploration | you need ground truth about what exists here, where it lives, how it connects |
| `duet-researcher` | web research — verify or survey | a fact is load-bearing, or you need to understand an unfamiliar domain |
| `duet-summarizer` | condensing long material | a spec, a huge file or a pile of docs is too long to hold alongside everything else |

**On a new project, dispatch `duet-prior-art` before you propose an approach.**
Somebody has almost always tried this before, and the shape of their attempts
is worth more than any amount of reasoning from first principles. It comes back
with what exists, what those attempts do well, what they abandoned and why, and
— most valuably — the wall that several independent projects all hit. A plan
that treats that wall as a minor step is already wrong, and you would rather
find that out now than in week three.

Dispatch them with the `Task` tool. Fan several out at once when the questions
are independent — they are cheap Sonnet calls and they run in parallel.

**Reach for them before asserting a fact you have not checked.** The failure
mode this guards against is specific: confidently recalling a version number, a
rate limit or a free-tier boundary that *was* true once. Those are the facts
most likely to be wrong and least likely to feel wrong. `duet-researcher`
searches; you should not answer from memory.

**Tell `duet-summarizer` what the summary is for.** A summary of the same spec
looks different depending on whether it feeds an estimate, an implementation or
an audit, and it will ask if you do not say.

## Scope Check

If the spec covers multiple independent subsystems, it should have been broken into sub-project specs during brainstorming. If it wasn't, suggest breaking this into separate plans — one per subsystem. Each plan should produce working, testable software on its own.

## File Structure

Before defining tasks, map out which files will be created or modified and what each one is responsible for. This is where decomposition decisions get locked in.

- Design units with clear boundaries and well-defined interfaces. Each file should have one clear responsibility.
- You reason best about code you can hold in context at once, and your edits are more reliable when files are focused. Prefer smaller, focused files over large ones that do too much.
- Files that change together should live together. Split by responsibility, not by technical layer.
- In existing codebases, follow established patterns. If the codebase uses large files, don't unilaterally restructure - but if a file you're modifying has grown unwieldy, including a split in the plan is reasonable.

This structure informs the task decomposition. Each task should produce self-contained changes that make sense independently.

## Task Right-Sizing

A task is the smallest unit that carries its own test cycle and is worth a
fresh reviewer's gate. When drawing task boundaries: fold setup,
configuration, scaffolding, and documentation steps into the task whose
deliverable needs them; split only where a reviewer could meaningfully
reject one task while approving its neighbor. Each task ends with an
independently testable deliverable.

## Bite-Sized Task Granularity

**Each step is one action (2-5 minutes):**
- "Write the failing test" - step
- "Run it to make sure it fails" - step
- "Implement the minimal code to make the test pass" - step
- "Run the tests and make sure they pass" - step
- "Commit" - step

## Plan Document Header

**Every plan MUST start with this header:**

```markdown
# [Feature Name] Implementation Plan

> **For agentic workers:** REQUIRED NEXT STEP: Hand this plan to `/duet:wrap`, which seals it into an audited context bundle and dispatches it across Claude and Codex workers. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** [One sentence describing what this builds]

**Architecture:** [2-3 sentences about approach]

**Tech Stack:** [Key technologies/libraries]

**Spec:** [path to the spec/design doc this plan implements — the plan
argues from the spec, so the spec travels with it; executors read both]

## Global Constraints

[The spec's project-wide requirements — version floors, dependency limits,
naming and copy rules, platform requirements — one line each, with exact
values copied verbatim from the spec. Every task's requirements implicitly
include this section.]

---
```

## Task Structure

````markdown
### Task N: [Component Name]

**Files:**
- Create: `exact/path/to/file.py`
- Modify: `exact/path/to/existing.py:123-145`
- Test: `tests/exact/path/to/test.py`

**Interfaces:**
- Consumes: [what this task uses from earlier tasks — exact signatures]
- Produces: [what later tasks rely on — exact function names, parameter
  and return types. A task's implementer sees only their own task; this
  block is how they learn the names and types neighboring tasks use.]

- [ ] **Step 1: Write the failing test**

```python
def test_specific_behavior():
    result = function(input)
    assert result == expected
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/path/test.py::test_name -v`
Expected: FAIL with "function not defined"

- [ ] **Step 3: Write minimal implementation**

```python
def function(input):
    return expected
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/path/test.py::test_name -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add tests/path/test.py src/path/file.py
git commit -m "feat: add specific feature"
```
````

## No Placeholders

Every step must contain the actual content an engineer needs. These are **plan failures** — never write them:
- "TBD", "TODO", "implement later", "fill in details"
- "Add appropriate error handling" / "add validation" / "handle edge cases"
- "Write tests for the above" (without actual test code)
- "Similar to Task N" (repeat the code — the engineer may be reading tasks out of order)
- Steps that describe what to do without showing how (code blocks required for code steps)
- References to types, functions, or methods not defined in any task

## Self-Review

After writing the complete plan, look at the spec with fresh eyes and check the plan against it. This is a checklist you run yourself — not a subagent dispatch.

**1. Spec coverage:** Skim each section/requirement in the spec. Can you point to a task that implements it? List any gaps.

**2. Placeholder scan:** Search your plan for red flags — any of the patterns from the "No Placeholders" section above. Fix them.

**3. Type consistency:** Do the types, method signatures, and property names you used in later tasks match what you defined in earlier tasks? A function called `clearLayers()` in Task 3 but `clearFullLayers()` in Task 7 is a bug.

If you find issues, fix them inline. No need to re-review — just fix and move on. If you find a spec requirement with no task, add the task.

## Execution Handoff

Only reach this section once the plan is approved and saved.

Do not offer an execution choice. There is one path, and the plan has not been
audited yet, so picking an execution style now would be deciding something that
is not yours to decide at this point.

Say:

**"Plan complete and saved to `docs/plans/<filename>.md`. Hand it to
`/duet:wrap` to seal it into an audited bundle and dispatch it."**

`/duet:wrap` reads the plan as written, routes each task to a Sonnet subagent
or a GPT worker, and puts the whole thing in front of an independent auditor
before any of it runs.

Do not start executing tasks yourself. A hook refuses edits until the plan
clears its audit, and working around that defeats the point of writing the plan
down in the first place.
