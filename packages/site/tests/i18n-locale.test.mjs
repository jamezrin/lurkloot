import assert from "node:assert/strict";
import test from "node:test";
import {
  htmlDir,
  htmlLang,
  localeToPrefix,
  pageHref,
  parseLocaleFromPathname,
  prefixToLocale,
  SITE_LOCALES,
} from "../src/i18n/locale.ts";
import { hashEnglish } from "../src/i18n/hash.ts";

test("lists every supported locale including English", () => {
  assert.deepEqual(SITE_LOCALES, ["en", "es", "fr", "it", "ru", "de", "zh_CN", "hi", "pt_BR", "ar", "tr"]);
});

test("maps locales to URL prefixes", () => {
  assert.equal(localeToPrefix("en"), "");
  assert.equal(localeToPrefix("es"), "es");
  assert.equal(localeToPrefix("zh_CN"), "zh-cn");
  assert.equal(localeToPrefix("pt_BR"), "pt-br");
  assert.equal(prefixToLocale(""), "en");
  assert.equal(prefixToLocale("zh-cn"), "zh_CN");
  assert.equal(prefixToLocale("pt-br"), "pt_BR");
  assert.equal(prefixToLocale("nope"), undefined);
});

test("builds locale-aware home and changelog hrefs", () => {
  assert.equal(pageHref("en", "/"), "/");
  assert.equal(pageHref("en", "/changelog"), "/changelog");
  assert.equal(pageHref("es", "/"), "/es/");
  assert.equal(pageHref("es", "/changelog"), "/es/changelog");
  assert.equal(pageHref("zh_CN", "/changelog"), "/zh-cn/changelog");
});

test("parses the locale out of a pathname", () => {
  assert.deepEqual(parseLocaleFromPathname("/"), { locale: "en", path: "/" });
  assert.deepEqual(parseLocaleFromPathname("/changelog"), { locale: "en", path: "/changelog" });
  assert.deepEqual(parseLocaleFromPathname("/es"), { locale: "es", path: "/" });
  assert.deepEqual(parseLocaleFromPathname("/es/changelog"), { locale: "es", path: "/changelog" });
  assert.deepEqual(parseLocaleFromPathname("/zh-cn/changelog/"), { locale: "zh_CN", path: "/changelog" });
});

test("uses BCP 47 lang and RTL only for Arabic", () => {
  assert.equal(htmlLang("en"), "en");
  assert.equal(htmlLang("zh_CN"), "zh-CN");
  assert.equal(htmlLang("pt_BR"), "pt-BR");
  assert.equal(htmlDir("es"), "ltr");
  assert.equal(htmlDir("ar"), "rtl");
});

test("hashes English text stably", () => {
  const a = hashEnglish("Farm Twitch drops");
  const b = hashEnglish("Farm Twitch drops");
  const c = hashEnglish("Farm Twitch drops.");
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.match(a, /^[0-9a-f]{64}$/);
});
