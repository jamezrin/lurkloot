import { describe, expect, it } from "vitest";
import config from "../wxt.config";

// The Firefox sources archive is rooted at the workspace, and WXT does not read
// .gitignore. Building it as an allowlist keeps untracked local files, such as
// the CLI's auth/credentials.json, out of an archive that gets published.
describe("Firefox sources archive", () => {
  const zip = config.zip ?? {};

  it("globs only the named build inputs, not the whole root", () => {
    expect(zip.sourcesRoot).toBe("../..");
    // WXT globs includeSources and defaults it to every file under the root.
    expect(zip.includeSources?.length).toBeGreaterThan(0);
    expect(zip.dotSources ?? false).toBe(false);
  });

  it("includes nothing from the workspace root but named files", () => {
    for (const pattern of zip.includeSources ?? []) {
      expect(pattern, pattern).not.toMatch(/^\*|^\{|^[^/]*\*\*/);
      expect(pattern, pattern).not.toMatch(/auth|credential|\.env/i);
    }
  });
});
