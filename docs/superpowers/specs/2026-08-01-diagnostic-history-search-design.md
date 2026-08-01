# Diagnostic history search design

## Goal

Let users find diagnostic messages across the complete retained diagnostic history from the popup's Diagnostics view.

## Scope and behavior

- The Diagnostics view contains a localized search field.
- A non-empty query is matched as a case-insensitive substring against each diagnostic message.
- Results include all retained diagnostics (currently the latest 2,000 records within seven days), not only the page already loaded by the popup.
- Results retain the selected platform scope, including platform-less global diagnostics as in the current history view.
- Empty or whitespace-only input uses the ordinary diagnostics stream.
- A search with no matches shows a dedicated localized empty state.
- Changing platform, leaving the Diagnostics view, or clearing the history resets the search state.

## Architecture

`ActivityQuery` gains an optional text query. The extension history repository applies it while iterating the existing category/time index. It continues reading until it has one more matching result than the requested limit, allowing the current cursor pagination format to represent the last returned matching record without a schema migration.

The popup owns the search input and debounces request refreshes enough to avoid a request per keystroke. Search requests use a separate activity stream and mutation sequence so late responses cannot replace the ordinary diagnostic stream or a newer search. The ActivityLog receives the query state and displays its search control only when Diagnostics is active; its list and copy action operate on the matching stream.

## Error handling

History-query failures remain non-disruptive, matching the existing activity refresh behavior. A stale response is discarded whenever its platform, query, or history generation no longer matches. Clearing history invalidates every outstanding history request.

## Testing

- Storage tests prove case-insensitive matching, platform/global inclusion, and cursor pagination across unmatched rows.
- Popup tests prove the search control appears only in Diagnostics, filters visible results, uses the no-results state, and clears when the view or platform changes.
- Existing activity-history request tests cover stream-mutation ordering; new cases cover query-scoped ordering.
