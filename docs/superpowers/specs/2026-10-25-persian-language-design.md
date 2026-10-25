# Persian language support

Add complete Persian (`fa`, native name `فارسی`) localization using the existing
catalog, locale registry and RTL mechanisms. Browser locales such as `fa-IR` must
resolve to Persian, and an explicit selection must survive settings normalization.

Use a full catalog derived from the current English keys, preserve `$N`
substitutions and brand names, and keep diagnostics as English literals. Add the
localized Persian language label to every existing catalog. Reuse the current
RTL layout, and translate the store artwork and detailed listing sources.

## Approach

Extend the explicit registries and existing loader rather than adding another
translation system. JSON catalogs remain the source for generated `_locales`.
No permissions, platform behavior, dependencies, version or release changes.

Verify browser locale resolution, settings persistence, RTL, catalog loading,
key/placeholder parity and the existing test suites. Build both browsers and
inspect a Persian popup with local demo data, without platform credentials.
