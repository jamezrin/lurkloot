// Types for checkNoGplJavaScript.mjs, so the CLI's tests can import it under strict TypeScript.

export declare function isGplLicense(license: unknown): boolean;
export declare function gplPackagesIn(nodeModules: string): string[];
export declare function gplInputsIn(
  metafile: { inputs?: Record<string, unknown> },
  options: { root: string; read?: (path: string) => string },
): string[];
