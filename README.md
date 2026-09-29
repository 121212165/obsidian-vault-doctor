# Vault Doctor

A link health center for Obsidian vaults. One click scans the whole vault and
shows a dashboard of:

- **Broken links** — links pointing to notes that don't exist (from Obsidian's
  own `unresolvedLinks` cache), with reference counts and the first referrer.
  Each target gets a **one-click create** button that makes the missing note
  next to its first referrer.
- **Orphan notes** — markdown files with zero backlinks and no embeds
  (templates/ignore-tagged notes exempt via settings).
- **Dangling attachments** — images/PDFs/audio/video present in the vault but
  never referenced by any note.

Everything is computed from Obsidian's `metadataCache` — scans finish in
milliseconds even on large vaults, with no manual parsing.

## Settings

- **Ignore path prefixes** — folders excluded from all checks.
- **Orphan exemption tags** — notes carrying these tags are never flagged as
  orphans (e.g. `模板`, `MOC`).

## Notes

- Plain JavaScript, no build step; runs entirely offline.
