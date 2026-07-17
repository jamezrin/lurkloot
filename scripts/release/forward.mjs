function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

const kinds = new Set(["normal", "hotfix"]);

export function assertForwardInputs({ kind, expectedMainSha, version }) {
  invariant(kinds.has(kind), "kind must be normal or hotfix");
  invariant(/^[0-9a-f]{40}$/.test(expectedMainSha ?? ""), "expected_main_sha must be a commit SHA");
  invariant(/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(version ?? ""), "version must be stable SemVer");
}

export function forwardBranch(version) {
  return `chore/forward-release-${version}`;
}

export function forwardMergeMessage({ kind, version }) {
  return `chore: forward ${kind} release ${version}`;
}

export function forwardPullRequest({ kind, version }) {
  return {
    title: `chore: forward release ${version}`,
    body: `Carries stable ${kind} release v${version} metadata and any production-only fixes from main into develop.`,
  };
}

export function forwardConflictIssue({ kind, version }) {
  return {
    title: `chore: forward release ${version} to develop`,
    body: `Automatic main → develop synchronization conflicted after ${kind} release v${version}. Create a branch from develop, merge main into it, resolve the conflicts without changing main, and open a PR back to develop before the next normal release.`,
  };
}

export function forwardSummary({ version, outcome, pr, issueUrl }) {
  if (outcome === "exists") {
    return `## Release v${version} forward merge\n\nSynchronization branch already exists${pr ? ` as PR #${pr}` : ""}; leaving it unchanged.\n`;
  }
  if (outcome === "conflict") {
    return `## Release v${version} needs manual forward merge\n\nAutomatic merge conflicted. Follow ${issueUrl} before the next normal release.\n`;
  }
  return `## Release v${version} forward merge\n\nOpened or refreshed PR #${pr} from main into develop.\n`;
}
