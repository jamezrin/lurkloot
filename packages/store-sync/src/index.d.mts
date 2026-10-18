export const BUNDLE_MANIFEST: string;
export const DESCRIPTION_MAX_LENGTH: number;
export const GLOBAL: "global";
export const MAX_SCREENSHOTS: number;
export const PARTS: readonly ["description", "screenshots", "promo"];
export const PROMO_TILES: Readonly<Record<"small" | "marquee", { width: number; height: number }>>;
export const SCREENSHOT_SIZES: readonly { width: number; height: number }[];

export type Part = "description" | "screenshots" | "promo";

export interface Source {
  version: string;
  commit?: string | null;
  dirty?: boolean;
}

export interface BundleFile {
  rel: string;
  path: string;
  name: string;
}

export interface BundleScope {
  scope: string;
  description?: { path: string; text: string };
  screenshots?: BundleFile[];
  promo?: Record<string, { rel: string; path: string }>;
  sources: Partial<Record<Part, Source & { generatedAt: string }>>;
}

export interface Bundle {
  dir: string;
  name: string;
  extensionId?: string;
  sections: Record<
    string,
    { source: Source & { generatedAt: string }; files: Record<string, string> }
  >;
  locales: string[];
  scope(code: string): BundleScope | undefined;
  global: BundleScope | undefined;
}

export function sectionId(scope: string, part: Part): string;
export function sectionPath(dir: string, scope: string, part: Part): string;

/**
 * Records the sections a producer has just written: what they hold now, a hash
 * of each file and where they came from. Sections not named are kept; `forget`
 * drops the record of a section that was removed.
 */
export function stampBundle(options: {
  dir: string;
  name: string;
  extensionId?: string;
  source: Source;
  sections?: string[];
  forget?: string[];
  now?: () => Date;
}): Promise<unknown>;

/** Reads a bundle, refusing it unless every file is exactly what was stamped. */
export function readBundle(dir: string): Promise<Bundle>;

export function gitProvenance(options?: {
  cwd?: string;
  exec?: (
    command: string,
    args: string[],
    options: { cwd?: string },
  ) => Promise<{ stdout: string }>;
}): Promise<{ commit: string; dirty: boolean }>;

export function isLocaleCode(value: unknown): boolean;
