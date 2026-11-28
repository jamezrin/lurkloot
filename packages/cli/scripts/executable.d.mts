// Types for executable.mjs, so the CLI's tests can import it under strict TypeScript.

export declare const SEA_FUSE: string;
export declare const SEA_RESOURCE: string;
export declare const SEA_MACHO_SEGMENT: string;

export declare function cycleTlsFileName(platform: string): string;
export declare function cycleTlsUpstreamName(platform: string, arch: string): string;
export declare function impitBindingPackages(
  manifest: { optionalDependencies?: Record<string, string> },
  platform: string,
  arch: string,
): string[];
export declare const CYCLETLS_SOURCE: { version: string; commit: string };
export declare function cycleTlsNotice(options: {
  version: string;
  file: string;
  dir?: string;
}): string[];
export declare function executableName(platform: string): string;
export declare function packageDirOf(file: string): string | undefined;

export interface BundledPackage {
  name: string;
  version: string;
  license: string;
  text: string | undefined;
}

export declare function bundledPackages(
  inputs: Iterable<string>,
  options: { root: string; read?: (path: string) => string },
): BundledPackage[];

export declare function renderNotice(options: {
  version: string;
  nodeVersion: string;
  nodeLicense: string;
  impit: { version: string; license: string; addons: string[] };
  cycleTls: { file: string; version: string; license: string };
  packages: BundledPackage[];
  appLicenses: string;
}): string;

export declare function envWithoutNode(
  env: Record<string, string | undefined>,
  options: { platform?: string; hasNode: (path: string) => boolean },
): Record<string, string | undefined>;

export declare function nodeLicenseCandidates(execPath: string): string[];
