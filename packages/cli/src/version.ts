// The application version is declared only in the repository root manifest,
// as for the extension (wxt.config.ts). esbuild inlines it into the bundle.
import rootManifest from "../../../package.json" with { type: "json" };

export const CLI_VERSION: string = rootManifest.version;
