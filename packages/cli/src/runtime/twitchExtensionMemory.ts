import { open } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
  parseTwitchExtensionLaneMemory,
  type TwitchExtensionLaneMemoryPort,
} from "@lurkloot/core/extensions/host";
import { writeJsonAtomically } from "../storage";

// The core format holds at most 64 cooldowns plus the two providers' deadlines.
// Cap reads too, including when an external edit replaces the file.
const MAX_MEMORY_BYTES = 8 * 1024;

export function createTwitchExtensionMemory(
  statePath: string,
  now = Date.now,
): TwitchExtensionLaneMemoryPort {
  const stateFile = basename(statePath);
  const laneFile = "twitch-extension-lane.json";
  const path = join(
    dirname(statePath),
    stateFile === "state.json" ? laneFile : `${stateFile}.${laneFile}`,
  );
  return {
    async load() {
      try {
        const file = await open(path, "r");
        try {
          const stat = await file.stat();
          if (!stat.isFile() || stat.size > MAX_MEMORY_BYTES) return undefined;
          const buffer = Buffer.alloc(MAX_MEMORY_BYTES + 1);
          let total = 0;
          while (total < buffer.length) {
            const { bytesRead } = await file.read(buffer, total, buffer.length - total);
            if (bytesRead === 0) break;
            total += bytesRead;
          }
          if (total > MAX_MEMORY_BYTES) return undefined;
          return parseTwitchExtensionLaneMemory(
            JSON.parse(buffer.toString("utf8", 0, total)),
            now(),
          );
        } finally {
          await file.close();
        }
      } catch {
        // Core can rediscover deadlines after a missing or damaged file.
        return undefined;
      }
    },
    async save(memory) {
      const sanitized = parseTwitchExtensionLaneMemory(memory, now());
      if (sanitized) await writeJsonAtomically(path, sanitized);
    },
  };
}
