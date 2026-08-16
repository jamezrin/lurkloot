# Diagnostics full-export design

## Goal

Let users download the complete retained diagnostic history for the selected platform from the popup Diagnostics view, while keeping the existing copy action as a pasteable snapshot of whatever is currently loaded.

## Scope and behavior

- Diagnostics toolbar becomes **Copy loaded**, **Export all**, and **Clear history**. Activity keeps today's **Copy log** and does not gain an export control.
- **Copy loaded** still serializes only the on-screen diagnostic list (the loaded page, plus any **Load more** rows, including the current search results). Clipboard text is unchanged.
- **Export all** downloads a `.log` file of every retained matching diagnostic for the selected platform, including platform-less unscoped events that already appear in that view. It ignores the search box.
- Retention stays as today: latest 2,000 diagnostic records within seven days. Export does not add a second cap.
- An empty store still downloads a valid log (`events: 0` and `(no events)`). **Export all** stays enabled when search has no matches, and is disabled only while an export is in flight.
- Hosts without a file-download hook (the site demo) hide **Export all**. **Copy loaded** still follows the existing clipboard hook.
- Core and the CLI are out of scope. Diagnostic line bodies remain English literals; only toolbar chrome is localized.

## Architecture

Export is a one-shot extension-host job, not another `getActivity` page.

`RuntimeMessage` gains `{ type: "exportDiagnostics"; platform: Platform }`. The extension activity handler asks the IndexedDB repository for every retained diagnostic matching the current list's platform rule (`event.platform` missing or equal to the selected platform). The walk uses the existing diagnostic category index and retention cutoff, returns newest-first, and does not apply a text query or the 100-row `getActivity` limit.

The handler returns a `DiagnosticsExport` of `{ events }` with no cursor. The popup formats that list with the existing `buildActivityExport` helper (oldest-first body, same `timestamp [level] message` lines as copy). Export passes `coverage: "full"` so the header includes `coverage: full`; copy omits that field so clipboard text does not change. `PopupAdapter` gains an optional `downloadFile(filename, contents, mimeType)` hook; the extension implements it with the same Blob URL + `<a download>` path used for settings and credentials, and the demo omits it. No new extension permissions.

Export uses its own request generation, not the diagnostic list's mutation sequence, so a **Load more** or search refresh cannot adopt or cancel a download. A stale export whose platform or generation no longer matches is discarded and not downloaded. Switching platform or leaving Diagnostics clears the transient success state, matching copy.

## File format

Filename: `lurkloot-diagnostics-{platform}-{utc}.log`, for example `lurkloot-diagnostics-twitch-20260816T143327Z.log`. The UTC stamp uses `YYYYMMDDTHHMMSSZ` so it is a legal filename on Windows.

Header (English, same fields as copy, plus coverage):

```text
Lurkloot diagnostics log
version: …
platform: twitch
locale: …
exported: …
browser: …
events: N
coverage: full
```

Body: one oldest-first line per event, `2026-07-25T12:00:01.000Z [error] …`.

## Error handling

IndexedDB or message failures show a localized alert, **Could not export the log. Try again.**, and do not download a partial file. Success shows a transient **Exported N events** on the button (same 2.5s confirmation window as copy). Closing the popup during the IndexedDB read may abort the download; that is accepted.

## Testing

- Storage tests prove one-shot export returns more than a 100-row page, includes unscoped events, excludes the other platform, ignores a search query, is newest-first, and still respects the seven-day cutoff.
- Message tests prove `exportDiagnostics` routes through the extension repository and returns `DiagnosticsExport`. `coreBoundary`'s history-API guard includes the new message name.
- Popup tests prove Diagnostics shows **Copy loaded** and **Export all**; Activity still shows **Copy log** and no export control; hosts without a download hook hide **Export all**; the request is `{ type: "exportDiagnostics", platform }` with no search query; the file uses `buildActivityExport` with `coverage: full` and the `.log` filename; copy still serializes only the loaded list; export stays enabled when search has no matches; failure shows the alert; a stale result after a platform switch is not downloaded; success shows **Exported N events**.
- Locale tests cover the new chrome strings only.
