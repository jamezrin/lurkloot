# Store descriptions

The detailed Chrome Web Store description for each locale, one plain-text file per locale code.
`pnpm cws:listing` pastes each file into the dashboard as is and then reads it back to compare, so
write plain text with a blank line between paragraphs. The limit is 16,000 characters.

The summary shown in search results is not here: the store takes it from the manifest, which reads
the `extensionDescription` message in `packages/locales/messages/<locale>.json`.

Focus on what the extension does and why someone should install it. Use the gaming term "farm" in
every language, never a crop or agriculture word; Arabic uses the loanword فارم / يفارم.
