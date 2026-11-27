import test from "node:test";
import assert from "node:assert/strict";
import {
  assertReleaseAssets,
  cliArchiveBase,
  cliArchiveName,
  cliExecutableTarget,
  cliExecutableTargets,
  desktopInstallerName,
  desktopInstallerNames,
  desktopInstallerTarget,
  desktopInstallerTargets,
  desktopUpdates,
  updaterAssetNames,
  updaterManifest,
  candidateMarker,
  candidateTag,
  expectedReleaseAssets,
  isGeneratedReleaseHead,
  parseCandidateMarker,
  releasePolicy,
  selectReleaseLabel,
  validatePromotion,
} from "./pipeline.mjs";

test("selects exactly one recognized release label", () => {
  assert.equal(selectReleaseLabel(["docs", "release/minor"]), "release/minor");
  assert.equal(selectReleaseLabel(["docs"]), undefined);
  assert.throws(
    () => selectReleaseLabel(["release/patch", "release/minor"]),
    /only one release label can be specified/,
  );
});

test("recognizes only generated stable release heads", () => {
  assert.equal(isGeneratedReleaseHead("release/1.6.0"), true);
  assert.equal(isGeneratedReleaseHead("release/v1.6.0"), false);
  assert.equal(isGeneratedReleaseHead("release/minor"), false);
  assert.equal(isGeneratedReleaseHead("hotfix/login"), false);
});

test("derives preparation and orphan actions from live labels", () => {
  assert.deepEqual(
    releasePolicy({
      labels: ["release/minor"],
      head: "develop",
      tags: ["v1.5.0"],
    }),
    {
      action: "prepare",
      bump: "minor",
      label: "release/minor",
      version: "1.6.0",
    },
  );
  assert.deepEqual(releasePolicy({ labels: [], head: "develop", tags: ["v1.5.0"] }), {
    action: "orphan",
  });
  assert.deepEqual(
    releasePolicy({ labels: ["release/minor"], head: "release/1.6.0", tags: ["v1.5.0"] }),
    {
      action: "ignore",
    },
  );
});

test("candidate ownership markers round trip", () => {
  const context = { pr: 132, version: "1.6.0", head: "release/1.6.0" };
  const marker = candidateMarker(context);
  assert.match(marker, /^<!-- lurkloot-release-candidate:/);
  assert.deepEqual(parseCandidateMarker(`Candidate\n\n${marker}\n`), context);
  assert.equal(parseCandidateMarker("ordinary release body"), undefined);
  assert.equal(candidateTag("1.6.0"), "v1.6.0");
});

test("uses only the final trailing candidate ownership marker", () => {
  const spoofed = candidateMarker({ pr: 999, version: "1.6.0", head: "release/1.6.0" });
  const canonical = candidateMarker({ pr: 132, version: "1.6.0", head: "release/1.6.0" });
  assert.deepEqual(parseCandidateMarker(`${spoofed}\nnotes\n${canonical}\n`), {
    pr: 132,
    version: "1.6.0",
    head: "release/1.6.0",
  });
  assert.equal(parseCandidateMarker(`${canonical}\nuser-controlled suffix`), undefined);
});

test("validates a concurrent minor candidate after a patch release", () => {
  assert.deepEqual(
    validatePromotion({
      stableVersion: "1.5.1",
      version: "1.6.0",
      label: "release/minor",
    }),
    { bump: "minor", version: "1.6.0" },
  );
  assert.throws(
    () => validatePromotion({ stableVersion: "1.6.0", version: "1.5.1", label: "release/patch" }),
    /expected 1\.6\.1/,
  );
});

test("expected release assets are the extension builds, the CLI archives, the desktop installers and checksums", () => {
  assert.deepEqual(expectedReleaseAssets("1.6.0"), [
    "SHA256SUMS",
    "lurkloot-1.6.0-chrome.crx",
    "lurkloot-1.6.0-chrome.zip",
    "lurkloot-1.6.0-firefox-sources.zip",
    "lurkloot-1.6.0-firefox.zip",
    "lurkloot-cli-1.6.0-linux-x64.tar.gz",
    "lurkloot-cli-1.6.0-linux-arm64.tar.gz",
    "lurkloot-cli-1.6.0-macos-arm64.tar.gz",
    "lurkloot-cli-1.6.0-macos-x64.tar.gz",
    "lurkloot-cli-1.6.0-windows-x64.zip",
    "lurkloot-desktop-1.6.0-linux-x64.AppImage",
    "lurkloot-desktop-1.6.0-linux-x64.deb",
    "lurkloot-desktop-1.6.0-linux-arm64.AppImage",
    "lurkloot-desktop-1.6.0-linux-arm64.deb",
    "lurkloot-desktop-1.6.0-macos-arm64.dmg",
    "lurkloot-desktop-1.6.0-macos-arm64.app.tar.gz",
    "lurkloot-desktop-1.6.0-macos-x64.dmg",
    "lurkloot-desktop-1.6.0-macos-x64.app.tar.gz",
    "lurkloot-desktop-1.6.0-windows-x64.msi",
    "lurkloot-desktop-1.6.0-windows-x64-setup.exe",
    "lurkloot-desktop-1.6.0-windows-x64-portable.zip",
  ]);
});

test("each desktop installer target is found by its platform and architecture", () => {
  const windows = desktopInstallerTarget("win32", "x64");
  assert.deepEqual(
    windows.installers.map((installer) => desktopInstallerName("1.6.0", windows, installer)),
    [
      "lurkloot-desktop-1.6.0-windows-x64.msi",
      "lurkloot-desktop-1.6.0-windows-x64-setup.exe",
      "lurkloot-desktop-1.6.0-windows-x64-portable.zip",
    ],
  );
  assert.equal(desktopInstallerTarget("darwin", "x64").id, "macos-x64");
  assert.throws(
    () => desktopInstallerTarget("linux", "ia32"),
    /no desktop installer target for linux-ia32/,
  );
  assert.throws(() => desktopInstallerNames("v1.6.0"));
  // Every desktop target has a CLI executable to bundle as its sidecar.
  for (const target of desktopInstallerTargets) {
    assert.equal(cliExecutableTarget(target.platform, target.arch).id, target.id);
  }
});

test("each CLI executable target is found by its platform and architecture", () => {
  assert.equal(cliExecutableTarget("darwin", "arm64").id, "macos-arm64");
  assert.equal(cliExecutableTarget("win32", "x64").archive, "zip");
  assert.equal(
    cliArchiveBase("1.6.0", cliExecutableTarget("linux", "x64")),
    "lurkloot-cli-1.6.0-linux-x64",
  );
  assert.throws(
    () => cliExecutableTarget("linux", "ia32"),
    /no lurkloot executable target for linux-ia32/,
  );
  assert.throws(() => cliArchiveName("v1.6.0", cliExecutableTargets[0]));
});

test("asset assertion accepts the exact expected set in any order", () => {
  const names = [
    "lurkloot-cli-1.6.0-windows-x64.zip",
    "lurkloot-1.6.0-firefox.zip",
    "SHA256SUMS",
    "lurkloot-1.6.0-chrome.crx",
    "lurkloot-cli-1.6.0-macos-x64.tar.gz",
    "lurkloot-1.6.0-firefox-sources.zip",
    "lurkloot-cli-1.6.0-linux-arm64.tar.gz",
    "lurkloot-1.6.0-chrome.zip",
    "lurkloot-cli-1.6.0-macos-arm64.tar.gz",
    "lurkloot-cli-1.6.0-linux-x64.tar.gz",
    ...desktopInstallerNames("1.6.0").toReversed(),
  ];
  assert.deepEqual(
    assertReleaseAssets({ names, version: "1.6.0" }),
    expectedReleaseAssets("1.6.0"),
  );
});

test("asset assertion rejects an unexpected file", () => {
  const names = [...expectedReleaseAssets("1.6.0"), "candidate.json"];
  assert.throws(
    () => assertReleaseAssets({ names, version: "1.6.0" }),
    /unexpected release asset: candidate\.json/,
  );
});

test("asset assertion rejects a missing file", () => {
  const names = expectedReleaseAssets("1.6.0").filter((name) => name !== "SHA256SUMS");
  assert.throws(
    () => assertReleaseAssets({ names, version: "1.6.0" }),
    /missing release asset: SHA256SUMS/,
  );
});

test("asset assertion rejects a version mismatch", () => {
  assert.throws(
    () => assertReleaseAssets({ names: expectedReleaseAssets("1.5.0"), version: "1.6.0" }),
    /unexpected release asset: lurkloot-1\.5\.0-chrome\.crx/,
  );
});

test("a prerelease tag never influences the next version", () => {
  // The candidate publishes vX.Y.Z as a prerelease before the version is final, so that tag is in
  // the v* namespace while it is still a candidate. Counting it would skip a version.
  assert.deepEqual(
    releasePolicy({
      labels: ["release/minor"],
      head: "develop",
      tags: ["v1.4.0", "v1.5.0", "v1.6.0"],
      exclude: ["v1.6.0"],
    }),
    { action: "prepare", bump: "minor", label: "release/minor", version: "1.6.0" },
  );
});

test("excluding nothing leaves the derivation unchanged", () => {
  assert.equal(
    releasePolicy({
      labels: ["release/minor"],
      head: "develop",
      tags: ["v1.4.0", "v1.5.0"],
      exclude: [],
    }).version,
    "1.6.0",
  );
});

test("recomputing after the candidate tag exists is stable", () => {
  // validate computes 1.6.0 and publishes the v1.6.0 prerelease; cut must reach the same answer.
  const at = (tags) =>
    releasePolicy({ labels: ["release/minor"], head: "develop", tags, exclude: ["v1.6.0"] })
      .version;
  assert.equal(at(["v1.5.0"]), "1.6.0");
  assert.equal(at(["v1.5.0", "v1.6.0"]), "1.6.0");
});

test("every update the app can install has its own installer-specific platform key", () => {
  const updates = desktopUpdates("1.6.0");
  assert.deepEqual(
    updates.map((update) => update.platform),
    [
      "linux-x86_64-appimage",
      "linux-x86_64-deb",
      "linux-aarch64-appimage",
      "linux-aarch64-deb",
      "darwin-aarch64-app",
      "darwin-x86_64-app",
      "windows-x86_64-msi",
      "windows-x86_64-nsis",
    ],
  );
  // Never the bare {os}-{arch} key, which every installer kind would fall back to.
  for (const update of updates) assert.match(update.platform, /^[a-z]+-[a-z0-9_]+-[a-z]+$/);
  // Each update is a release asset the candidate already ships; the .dmg is not one.
  const expected = expectedReleaseAssets("1.6.0");
  for (const update of updates) assert.ok(expected.includes(update.asset), update.asset);
  assert.ok(!updates.some((update) => update.asset.endsWith(".dmg")));
  // Nor the portable zip, which never updates itself.
  assert.ok(!updates.some((update) => update.asset.endsWith("-portable.zip")));
  assert.equal(
    updates.find((update) => update.platform === "windows-x86_64-nsis").signature,
    "lurkloot-desktop-1.6.0-windows-x64-setup.exe.sig",
  );
});

test("the updater's files are never part of the reviewed asset set", () => {
  const names = updaterAssetNames("1.6.0");
  assert.equal(names.at(-1), "latest.json");
  assert.equal(names.length, desktopUpdates("1.6.0").length + 1);
  const expected = expectedReleaseAssets("1.6.0");
  for (const name of names) assert.ok(!expected.includes(name), name);
});

test("latest.json lists every update with its signature and release download URL", () => {
  const signatures = Object.fromEntries(
    desktopUpdates("1.6.0").map((update) => [update.asset, `sig-for-${update.asset}\n`]),
  );
  const manifest = updaterManifest({
    version: "1.6.0",
    pubDate: "2026-11-27T00:00:00Z",
    notes: "notes",
    signatures,
    downloadBase: "https://github.com/jamezrin/lurkloot/releases/download/v1.6.0/",
  });
  assert.equal(manifest.version, "1.6.0");
  assert.equal(manifest.pub_date, "2026-11-27T00:00:00Z");
  assert.deepEqual(manifest.platforms["darwin-aarch64-app"], {
    signature: "sig-for-lurkloot-desktop-1.6.0-macos-arm64.app.tar.gz",
    url: "https://github.com/jamezrin/lurkloot/releases/download/v1.6.0/lurkloot-desktop-1.6.0-macos-arm64.app.tar.gz",
  });
  assert.equal(Object.keys(manifest.platforms).length, 8);
  const { [desktopUpdates("1.6.0")[0].asset]: _, ...missing } = signatures;
  assert.throws(
    () =>
      updaterManifest({
        version: "1.6.0",
        pubDate: "x",
        notes: "",
        signatures: missing,
        downloadBase: "https://example.test",
      }),
    /no updater signature for lurkloot-desktop-1\.6\.0-linux-x64\.AppImage/,
  );
});
