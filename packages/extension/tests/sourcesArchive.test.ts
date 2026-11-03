import { describe, expect, it } from "vitest";
import config from "../wxt.config";

// The Firefox sources archive is rooted at the workspace, and WXT does not read
// .gitignore. Building it as an allowlist keeps untracked local files, such as
// the CLI's auth/credentials.json, out of an archive that gets published.
describe("Firefox sources archive", () => {
  const zip = config.zip ?? {};

  it("excludes everything and includes build inputs back", () => {
    expect(zip.sourcesRoot).toBe("../..");
    expect(zip.excludeSources).toEqual(["**"]);
  });

  it("includes nothing from the workspace root but named files", () => {
    for (const pattern of zip.includeSources ?? []) {
      expect(pattern, pattern).not.toMatch(/^\*|^\{|^[^/]*\*\*/);
      expect(pattern, pattern).not.toMatch(/auth|credential|\.env/i);
    }
  });
});
