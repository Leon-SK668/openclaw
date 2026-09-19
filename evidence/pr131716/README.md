# Sessions preference screenshots

These are cropped copies of the previously published Chromium captures for OpenClaw PR #131716, not a new runtime run. The original proof used the rendered Control UI and the repository's mocked Gateway with synthetic `ada` and `bob` sessions. Its tested historical head was `497bfc0c04ffdf6c295db489f6ec7a8a7cd8232a`.

The only pixel operation is a crop from `(258, 0)` to `(1280, 900)`. It removes the unrelated sidebar and its invitation card. The Sessions title, filters, status selection, table and page-size controls remain unchanged. No controls, text, or results were drawn or reconstructed.

`manifest.json` records the original attachment URLs, original SHA-256 hashes, crop rectangle and published SHA-256 hashes. The original full frames are not relabeled as current-head execution. The cropped frames were visually inspected before publication.

| Capture | Observed control state |
| --- | --- |
| `initial-v1.png` | Restored search `persisted`, Active, grouping, 10 rows per page. |
| `revisit-search.png` | Search edit `changed` retained after revisit. |
| `legacy-group.png` | Legacy grouping retained while the visible search is edited. |
| `archived-before.png` | Archived selected, no archived sessions. |
| `archived-to-active.png` | Active selected, synthetic rows visible after the failed-write scenario. |
| `all-before.png` | All selected. |
| `all-to-active.png` | Active selected after the corresponding failed-write scenario. |

The images corroborate visible states; storage-write interception and outgoing-request assertions remain evidenced by the original runtime receipts. They do not independently establish real Gateway behavior or maintainer acceptance of the persistence and rollback contract.
