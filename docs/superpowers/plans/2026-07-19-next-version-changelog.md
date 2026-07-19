# Version 1.7.0 Changelog Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the approved, customer-facing version 1.7.0 entry to the website changelog.

**Architecture:** Prepend one undated entry to the existing JSON changelog, preserving its newest-first ordering and `new`/`improved` kind schema. Validate both the Astro site and the Markdown release-note renderer without changing application code.

**Tech Stack:** JSON, Astro, Node.js, pnpm

## Global Constraints

- Version must be exactly `1.7.0`.
- Do not set a release date; release preparation assigns it.
- Include only the three approved customer-facing changes.
- Exclude release-pipeline, dependency, and repository-documentation changes.

---

### Task 1: Add and verify the version 1.7.0 changelog entry

**Files:**
- Modify: `packages/site/src/changelog.json`

**Interfaces:**
- Consumes: `ChangelogEntry` JSON shape from `packages/site/src/changelog.ts`
- Produces: an undated `1.7.0` entry consumed by the changelog page and release-note renderer

- [ ] **Step 1: Confirm the release-note renderer rejects the missing entry**

Run:

```bash
node scripts/release/cli.mjs notes --version 1.7.0 --out /tmp/lurkloot-1.7.0-notes.md
```

Expected: FAIL with `no changelog entry for 1.7.0`.

- [ ] **Step 2: Prepend the approved entry**

Add this object before the existing `1.6.0` entry in `packages/site/src/changelog.json`:

```json
{
  "version": "1.7.0",
  "changes": [
    {
      "kind": "new",
      "text": "Added automatic claiming for completed Kick daily challenges, with separate per-platform controls for Kick challenges and Twitch channel points."
    },
    {
      "kind": "new",
      "text": "Lurkloot now avoids farming rewards that cannot be completed before their deadline, with an adjustable safety margin."
    },
    {
      "kind": "improved",
      "text": "Twitch now starts progressing toward the next reward sooner after a claim instead of waiting for the next scheduled cycle."
    }
  ]
}
```

- [ ] **Step 3: Build and test the site**

Run:

```bash
pnpm --filter @lurkloot/site test
```

Expected: Astro builds successfully and all site tests pass.

- [ ] **Step 4: Render and inspect the release notes**

Run:

```bash
node scripts/release/cli.mjs notes --version 1.7.0 --out /tmp/lurkloot-1.7.0-notes.md
sed -n '1,120p' /tmp/lurkloot-1.7.0-notes.md
```

Expected: PASS with two bullets under `## New`, one bullet under `## Improved`, and no `## Fixed` section.

- [ ] **Step 5: Commit the changelog**

```bash
git add packages/site/src/changelog.json docs/superpowers/plans/2026-07-19-next-version-changelog.md
git commit -m "docs(site): add version 1.7.0 changelog"
```
