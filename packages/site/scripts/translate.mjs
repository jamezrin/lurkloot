import { defaultCacheDir } from "../src/i18n/cache.ts";
import { prefixedLocales } from "../src/i18n/locale.ts";
import { collectSiteEnglish } from "../src/i18n/siteStrings.ts";
import { translateAll } from "../src/i18n/translateAll.ts";
import { ScoutTranslator } from "../src/i18n/translator.ts";

const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
const apiToken = process.env.WORKERS_AI_API_TOKEN;
if (!accountId || !apiToken) {
  console.error("Skipping site translation: CLOUDFLARE_ACCOUNT_ID or WORKERS_AI_API_TOKEN is unset.");
  process.exit(0);
}

await translateAll({
  cacheDir: defaultCacheDir(),
  english: collectSiteEnglish(),
  locales: prefixedLocales(),
  translator: new ScoutTranslator({ accountId, apiToken }),
});
