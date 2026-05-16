# Inventory Workflow

This fork supports a catalog-first workflow for polite, repeatable creator archives. Keep creator configs local and ignored, for example `creator.local.conf`, and keep cookies out of commits.

## Full Inventory

Run this once, or occasionally as a reconciliation pass:

```sh
node bin/patreon-dl.js -C creator.local.conf --inventory --inventory-resume --inventory-out ./downloads/creator/.patreon-dl/inventory-full.jsonl
```

`--inventory-resume` appends safely from the last checkpoint if the run is interrupted.

## Delta Scan

Use this for routine checks after the first full inventory:

```sh
node bin/patreon-dl.js -C creator.local.conf --inventory-delta --inventory-in ./downloads/creator/.patreon-dl/inventory-current.jsonl --inventory-out ./downloads/creator/.patreon-dl/inventory-delta-$(date +%F).jsonl
```

Delta mode fetches newest pages only and stops once it sees known posts. This is fast for normal "new post" checks, but it will not discover old edited posts unless Patreon surfaces them near the top.

## Merge Current Inventory

Merge the delta into the canonical current inventory:

```sh
node bin/patreon-dl.js -C creator.local.conf --inventory-merge --inventory-in ./downloads/creator/.patreon-dl/inventory-current.jsonl --delta-in ./downloads/creator/.patreon-dl/inventory-delta-YYYY-MM-DD.jsonl --inventory-out ./downloads/creator/.patreon-dl/inventory-current.jsonl
```

Merge deduplicates by post ID, adds new posts, and replaces records when the delta has a newer `editedAt`.

## Select And Harvest

Select audio-bearing posts, then download the full selected posts:

```sh
node bin/patreon-dl.js -C creator.local.conf --inventory-select --inventory-in ./downloads/creator/.patreon-dl/inventory-current.jsonl --select-media audio --target-out ./downloads/creator/.patreon-dl/audio-targets.txt
node bin/patreon-dl.js -C creator.local.conf --no-prompt ./downloads/creator/.patreon-dl/audio-targets.txt
```

The media filter selects posts that contain audio. Once a post is selected, the downloader still uses the config to decide which assets inside that post are downloaded.

For video-like posts, prefer source-shape selectors over tags:

```sh
node bin/patreon-dl.js -C creator.local.conf --inventory-select --inventory-in ./downloads/creator/.patreon-dl/inventory-current.jsonl --select-media attached-video --target-out ./downloads/creator/.patreon-dl/attached-video-targets.txt
node bin/patreon-dl.js -C creator.local.conf --inventory-select --inventory-in ./downloads/creator/.patreon-dl/inventory-current.jsonl --select-media embedded-video --target-out ./downloads/creator/.patreon-dl/embedded-video-targets.txt
```

`video` selects any video-bearing post; `hosted-video`, `embedded-video`, and `attached-video` narrow by how Patreon exposed the asset. This matters because Patreon-hosted MP4 files can appear as attachments rather than native post video.

## Verify Harvest

Use the harvest report to compare targets against inventory, the SQLite database, local files, and status-cache errors:

```sh
node bin/patreon-dl.js -C creator.local.conf --harvest-report --inventory-in ./downloads/creator/.patreon-dl/inventory-current.jsonl --target-in ./downloads/creator/.patreon-dl/audio-targets.txt
```

Write machine-readable JSON for Obsidian or automation with:

```sh
node bin/patreon-dl.js -C creator.local.conf --harvest-report --inventory-in ./downloads/creator/.patreon-dl/inventory-current.jsonl --target-in ./downloads/creator/.patreon-dl/audio-targets.txt --harvest-report-out ./downloads/creator/.patreon-dl/harvest-report.json
```

## Archive State

Inventory, delta, target selection, and harvest-report commands update `./downloads/creator/.patreon-dl/archive-state.json`. This file is local state, not source code. It records current inventory paths, last delta scan counts, selected target files, and the last harvest report summary without cookies or signed media URLs.

Never delete downloaded media automatically based on upstream removals. Treat missing or edited upstream assets as archive metadata, not cleanup instructions.
