const sha = (char) => char.repeat(40);

export function candidateMetadata(overrides = {}) {
  return {
    schemaVersion: 2,
    version: "1.5.0",
    kind: "normal",
    label: "release/minor",
    stableVersion: "1.4.0",
    stableSha: sha("b"),
    developSha: sha("c"),
    sourceSha: sha("a"),
    authorizedSha: sha("a"),
    releasePr: 120,
    initiator: "jamezrin",
    authorizedBy: "admin-user",
    trustedToolsSha: sha("b"),
    createdAt: "2026-07-17T00:00:00Z",
    reconciledAt: "2026-07-17T00:00:00Z",
    chromeZipSha256: "a".repeat(64),
    artifactChecksums: { "lurkloot-1.5.0-chrome.zip": "a".repeat(64) },
    dockerDigests: [`sha256:${"a".repeat(64)}`, `sha256:${"b".repeat(64)}`],
    cwsState: "DRAFT",
    previewUrl: "https://example.com/preview",
    ...overrides,
  };
}
