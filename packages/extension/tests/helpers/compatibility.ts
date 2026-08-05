import { resolveCompatibility, type CompatibilityHostFacts, type ResolvedCompatibility } from "@lurkloot/core";
import { DEFAULT_SETTINGS } from "@lurkloot/shared/settings";

// TwitchAdapterOptions/KickAdapterOptions require a resolved compatibility —
// no construction site may restate a capability id by hand. Fixtures build
// theirs through the real resolver, on the extension's own host facts, so
// they exercise the same path production does rather than drifting from it.
const EXTENSION_HOST_FACTS: CompatibilityHostFacts = { host: "extension", twitchIdentity: "web" };

export function testCompatibility(hostFacts: CompatibilityHostFacts = EXTENSION_HOST_FACTS): ResolvedCompatibility {
  return resolveCompatibility(DEFAULT_SETTINGS.compatibility, hostFacts).compatibility;
}
