# Usage: let AI write, you review

The point of this library is not to hand-format notes; it is to **push the cost of maintenance down and keep judgment with you**.

> AI edits files, fills frontmatter, tags, links and runs validation. You read, judge, and decide.

## Why this split

- Mechanical work (field order, timestamps, status normalization, paths, link rewrites) belongs to tools — they never forget and cannot fake a field.
- Judgment (is this worth keeping, is the conclusion right, where should it link) is yours alone.
- The client is for **reading and checking**: tree, backlinks, hover previews, search, property history.

## A typical edit

1. You tell an AI: "record this conclusion in 30-Agent工程 and link it to 30.11".
2. The AI creates the skeleton with `kb new`, writes the body, fills `description` / `tags` / links, then saves (which runs `okf commit`).
3. You review in the client: is the title a claim, is the description one standalone sentence, are tags reused from the existing vocabulary, do links point at the right layer?
4. Fix in place: click a property value to edit; the body autosaves.

## Rules for AI editors

- **Identity**: claim a token first — `kb token new --name <label> --runtime deepseekharness --session <id>` — then pass it via `KB_TOKEN`. Without a token the CLI refuses; never use `human:`.
- **Required fields**: `type`, `generated.by`, `generated.at`, `source_checked`. Missing `source_checked` is rejected.
- **Description**: one sentence understandable without context — it is what search and hover show.
- **Tags**: check the existing vocabulary first; synonyms are the enemy of retrieval.
- **Links**: prefer links to the nearest convention/index page over a pile of sibling notes.

## What you should review

- Title and description: understandable without context.
- Facts: numbers, dates, versions, paths that can be reproduced.
- Freshness: has `stale_after` passed? Expired notes are still searchable but carry a warning.
- Structure: should this be split, merged, or archived?

## What the client does for you

- Save = commit: writes the file, runs `okf commit`, rolls back on rejection.
- Conflict detection: if the file changed outside the editor, saving reports a conflict instead of overwriting.
- Property history: per-field versions in the right-hand panel.
- Entry tags: tag a single property without touching file-level tags.

## Common traps

- Hand-written frontmatter often misses `source_checked`; use `kb new` or the client.
- Copying an old document as a template copies its timestamps; `generated.at` is refreshed on commit, do not hardcode it.
- Do not rename from a file manager; use the client or `kb rename` so links are rewritten.

## External links and video blocks

- Links open in the built-in browser and are snapshotted after load. If loading fails, the client falls back to the latest snapshot and shows a yellow bar: "Offline snapshot · captured …", with a retry button.
- file: / javascript: / data: links are blocked with a reason. Local files are only allowed as video or image assets, resolved relative to the current document or from the vault root (leading /); escaping the vault is rejected.
- Video uses a declarative block provided by .okf/plugins/video:

```kb-video
src: https://example.com/clip.mp4
fallback: _assets/clip.mp4
poster: _assets/poster.png
title: Demo
controls: true
```

- If the online video fails, the client switches to fallback and shows a yellow warning; without fallback it shows an error.

### Plugins and trust

- Local vault plugins are trusted by default; no permission dialog. If `.okf/plugins/<name>/plugin.json` declares `client: "client.js"`, the client runs it on startup inside an isolated iframe. Manifest-only plugins (declarative `component`/`props`) never execute JavaScript.
- What a plugin can touch: `ui.html/css/toast` for its own UI area, `webview.eval/css/navigate/getUrl` for the built-in browser, and `commands.register` for the command palette. Narrow this with the manifest's `capabilities` list.
- A plugin cannot reach `window.kb`, Node, `ipcRenderer`, or the filesystem. `webview.navigate` only allows http/https; `file:` is rejected.
- To distrust one plugin: set `trusted: false` in its manifest. To disable all plugin clients: set `plugins.client_enabled: false` in the client config, or start with `KB_NO_PLUGIN_CLIENT=1`.
- Plugins are local code. Read `client.js` before installing one; isolation removes direct host access, not the need to trust the author.
- Ctrl+Shift+K (or the command palette item "检查当前文档（插件检查器）") runs the built-in OKF checks, .okf/checkers/, and .okf/plugins/*/checker.py; results show line numbers and codes.
