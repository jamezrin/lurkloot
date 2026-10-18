import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";
import {
  stampBundle,
  // @ts-expect-error The production utility is an executable JavaScript module.
} from "../../src/bundle.mjs";

// A PNG header is all the bundle reads of an image: signature, IHDR, and the size.
export function png(width = 1280, height = 800, mark = ""): Buffer {
  const bytes = Buffer.alloc(24 + mark.length);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes);
  bytes.writeUInt32BE(13, 8);
  bytes.write("IHDR", 12, "ascii");
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  bytes.write(mark, 24, "ascii");
  return bytes;
}

const directories: string[] = [];

export function useTemporaryDirectories(): void {
  afterEach(() => {
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });
}

export function temporaryDirectory(prefix = "store-sync-"): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
}

export const NAMES = ["01-drops", "02-extras", "03-easy", "04-settings", "05-updated"];

export type Content = {
  description?: string;
  screenshots?: number;
};

export type BundleSpec = {
  locales?: Record<string, Content>;
  global?: { screenshots?: number; promo?: boolean };
  version?: string;
  dirty?: boolean;
  commit?: string;
  extensionId?: string;
};

export const SOURCE = {
  version: "1.18.0",
  commit: "1ec05403dc4a391f45553c57981caa61f9dd36b4",
  dirty: false,
};

// Writes one section of a bundle's files (not its stamp). `mark` makes the
// bytes differ between runs so a hash change can be observed.
export function writeSection(dir: string, scope: string, part: string, count = 5, mark = "v1") {
  if (part === "description") {
    mkdirSync(join(dir, scope), { recursive: true });
    writeFileSync(join(dir, scope, "description.txt"), `Description for ${scope} ${mark}\n`);
    return;
  }
  const folder = join(dir, scope, part);
  mkdirSync(folder, { recursive: true });
  if (part === "screenshots") {
    for (const name of NAMES.slice(0, count)) {
      writeFileSync(join(folder, `${name}.png`), png(1280, 800, `${scope}-${name}-${mark}`));
    }
  } else {
    writeFileSync(join(folder, "small.png"), png(440, 280, mark));
    writeFileSync(join(folder, "marquee.png"), png(1400, 560, mark));
  }
}

// A complete, stamped bundle on disk.
export async function makeBundle(spec: BundleSpec = {}): Promise<string> {
  const dir = temporaryDirectory();
  const sections: string[] = [];
  for (const [locale, content] of Object.entries(spec.locales ?? {})) {
    if (content.description !== undefined) {
      mkdirSync(join(dir, locale), { recursive: true });
      writeFileSync(join(dir, locale, "description.txt"), content.description);
      sections.push(`${locale}/description`);
    }
    if (content.screenshots) {
      writeSection(dir, locale, "screenshots", content.screenshots);
      sections.push(`${locale}/screenshots`);
    }
  }
  if (spec.global?.screenshots) {
    writeSection(dir, "global", "screenshots", spec.global.screenshots);
    sections.push("global/screenshots");
  }
  if (spec.global?.promo) {
    writeSection(dir, "global", "promo");
    sections.push("global/promo");
  }
  await stampBundle({
    dir,
    name: "acme",
    extensionId: spec.extensionId,
    source: {
      version: spec.version ?? SOURCE.version,
      commit: spec.commit ?? SOURCE.commit,
      dirty: spec.dirty ?? SOURCE.dirty,
    },
    sections,
  });
  return dir;
}
