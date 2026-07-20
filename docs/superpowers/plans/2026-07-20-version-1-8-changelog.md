# Version 1.8.0 Changelog Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an undated, customer-facing version 1.8.0 entry based only on changes merged into `origin/develop` after version 1.7.0.

**Architecture:** Prepend one entry to the existing JSON changelog, preserving its newest-first ordering and established `improved` vocabulary. No runtime code or schema changes are required.

**Tech Stack:** JSON, Astro, pnpm

## Global Constraints

- Include only changes merged into `origin/develop`.
- Present the settings migration framework as improved reliability between version upgrades.
- Leave the version 1.8.0 entry undated until release preparation.
- Exclude dependency updates, release-pipeline changes, and unmerged work.

---

### Task 1: Add the version 1.8.0 changelog entry

**Files:**
- Modify: `packages/site/src/changelog.json`

**Interfaces:**
- Consumes: the existing changelog object shape with `version`, `changes`, optional `date`, and change objects containing `kind` and `text`.
- Produces: an undated version 1.8.0 entry at index zero with three `improved` items.

- [ ] **Step 1: Prepend the entry**

Add this object before version 1.7.0:

```json
{
  "version": "1.8.0",
  "changes": [
    {
      "kind": "improved",
      "text": "Reorganized Settings to make options easier to navigate, and refreshed the footer attribution links."
    },
    {
      "kind": "improved",
      "text": "Renamed “Watch Queue” to “Idle Watchlist” to make its purpose clearer."
    },
    {
      "kind": "improved",
      "text": "Settings now migrate more reliably between version upgrades, preserving your preferences as configuration evolves."
    }
  ]
}
```

- [ ] **Step 2: Validate the JSON structure**

Run: `node -e 'JSON.parse(require("node:fs").readFileSync("packages/site/src/changelog.json", "utf8"))'`

Expected: exit code 0 with no output.

- [ ] **Step 3: Build the site**

Run: `pnpm build:site`

Expected: exit code 0 and Astro reports the site build completed.

- [ ] **Step 4: Inspect the final diff**

Run: `git diff --check && git diff -- packages/site/src/changelog.json`

Expected: no whitespace errors; the diff contains exactly the new undated version 1.8.0 entry before version 1.7.0.

- [ ] **Step 5: Commit the changelog**

```bash
git add packages/site/src/changelog.json docs/superpowers/plans/2026-07-20-version-1-8-changelog.md
git commit -m "docs(site): add version 1.8.0 changelog"
```
