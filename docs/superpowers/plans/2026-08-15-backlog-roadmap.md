# Backlog Roadmap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Apply the approved dependency-aware assignments for nine scheduler issues to the public Lurkloot GitHub Project.

**Architecture:** Resolve every issue to its existing Project #2 item, update only the approved project fields through GitHub's ProjectV2 API, and then read all nine items back as a compact verification table. Project item IDs are treated as opaque live identifiers; issue numbers are the stable lookup keys.

**Tech Stack:** GitHub CLI `gh`, GitHub ProjectV2 GraphQL/API, `jq`.

## Global Constraints

- Target `jamezrin` Project #2 (`PVT_kwHOAFrIcs4BeaR4`).
- Change only Status, Priority, Size, Iteration, Start date, Target date, Area, and Platform.
- Do not change issue bodies, labels, milestones, assignees, repository state, or project configuration.
- Do not duplicate existing project items.
- Use exact assignments from `docs/superpowers/specs/2026-08-15-backlog-roadmap-design.md`.
- Verify every field by reading the live project after mutation.

---

### Task 1: Resolve live project identifiers

**Files:**
- Read: `docs/superpowers/specs/2026-08-15-backlog-roadmap-design.md`
- Create transiently: `/tmp/lurkloot-project-fields.json`
- Create transiently: `/tmp/lurkloot-project-items.json`

**Interfaces:**
- Consumes: issue numbers 336, 337, 339, 361, 382, 391, 392, 394, and 395.
- Produces: one unique ProjectV2 item ID per issue plus live field and option IDs.

- [ ] **Step 1: Refresh project metadata**

```bash
gh project field-list 2 --owner jamezrin --format json > /tmp/lurkloot-project-fields.json
gh project item-list 2 --owner jamezrin --limit 200 --format json > /tmp/lurkloot-project-items.json
```

- [ ] **Step 2: Verify all nine issues resolve exactly once**

Use `jq` to count items by `content.number`. Abort without mutation if any requested issue has a count other than one.

### Task 2: Apply approved roadmap fields

**Files:**
- Read: `/tmp/lurkloot-project-fields.json`
- Read: `/tmp/lurkloot-project-items.json`

**Interfaces:**
- Consumes: unique item IDs and exact roadmap assignment table.
- Produces: live project items carrying the approved project metadata.

- [ ] **Step 1: Apply Status, Priority, Size, Area, and Platform**

For every issue, call `gh project item-edit` with Project #2's corresponding single-select field and option IDs. Apply the values exactly as specified; do not infer alternatives.

- [ ] **Step 2: Apply Start date and Target date**

Use `gh project item-edit --date YYYY-MM-DD` for both date fields on every issue.

- [ ] **Step 3: Apply iterations only to the approved items**

Assign Iteration 2 to #391 and #392 and Iteration 3 to #336. Leave iteration unset for #337, #339, #361, #382, #394, and #395.

### Task 3: Verify the live roadmap

**Files:**
- Recreate transiently: `/tmp/lurkloot-project-items-after.json`

**Interfaces:**
- Consumes: mutated Project #2.
- Produces: a nine-row verification table suitable for the user handoff.

- [ ] **Step 1: Read Project #2 again**

```bash
gh project item-list 2 --owner jamezrin --limit 200 --format json > /tmp/lurkloot-project-items-after.json
```

- [ ] **Step 2: Compare all approved values**

Assert exact status, priority, size, area, platform, start date, target date, and iteration for each issue. Report and stop on any mismatch rather than claiming completion.

- [ ] **Step 3: Present the action plan**

Return the project link, the critical chain `#392 → #336 → #339 → #394 → #395 → #337`, parallel #391, and tracking roles for #361/#382.
