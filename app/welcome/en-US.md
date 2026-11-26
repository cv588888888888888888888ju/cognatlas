# Welcome to Cognatlas

This is a built-in introduction. It is not part of your knowledge base, and you can reopen it anytime from the command palette (Ctrl+P → "Open introduction").

## What this is

Cognatlas is a local-first AI knowledge base client: it reads and writes .md files in a git repository that follows the OKF spec (frontmatter + three required fields). Everything stays on your own disk.

## Layout

- **Sidebar**: file tree (expand folders, click a file to open), filter box, backlinks.
- **Tab strip**: open documents; click × to close, Ctrl+W closes the current one.
- **Properties block**: frontmatter rendered as a key/value table, tags as purple pills; click a value to edit, Enter saves and commits.
- **Editor**: Live Preview for headings, bold/italic, inline code, tables, images, syntax highlighting; the line under the cursor shows raw source.
- **Status bar**: word count, backlink count, save state.

## Keyboard shortcuts

| Shortcut | Action |
|---|---|
| Ctrl+N | New note (into 00-收件箱) |
| Ctrl+O | Quick switch document |
| Ctrl+W | Close current tab |
| Ctrl+S | Save and commit now (edits also auto-save after 1.2s) |
| Ctrl+P | Command palette |
| Ctrl+Shift+F | Search the whole base (expired docs still match, with a warning) |
| [[ | Trigger document link completion |
| # | Tag completion |

## Three ways to use links

- **Hover**: preview title, path, excerpt and backlink count.
- **Left click**: open internal links in the current tab; external links open in the built-in browser.
- **Middle click / Ctrl+click**: open internal links in a new window; external links go to the system browser.

## Built-in browser and link snapshots

External links open in the built-in browser, and logins persist across restarts (dedicated partition). Every loaded page is snapshotted automatically (at most once per 6 hours per URL); press "Snapshot" in the toolbar to save a manual version. "History" lists every version by time, so the page stays readable even if the source goes offline.

## Where the data lives

- Knowledge base: given by KB_ROOT at launch (your vault), every change goes through git.
- Snapshots: `~/.config/cognatlas/links/` (HTML, text, screenshot).
- Window state and session: `window-state.json` in Electron's userData directory plus localStorage.

## Switch language

Command palette (Ctrl+P) → "切换介绍语言", or the language buttons at the top of this page.
