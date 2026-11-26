# Introduction: this is your knowledge base

These are **built-in starter documents**. They are not part of your knowledge base and can be reopened anytime from the command palette (Ctrl+P → "Open introduction"). They are split into five pages: read them once, then use them as a reference.

## The five pages

1. **[Usage: let AI write, you review](welcome:01-usage)** — how to split the work, edit, and audit.
2. **[General conventions](welcome:02-norms)** — frontmatter fields, naming, folders, links, commit identity.
3. **[Health baseline](welcome:03-health)** — what "healthy" means, how to read the metrics, and what to do when a red line is crossed.
4. **[Document layering for large projects](welcome:04-layers)** — how folders and links should evolve from dozens to hundreds of notes.
5. This page — layout and shortcuts.

## Quick start

- The left sidebar is the file tree; the tab strip is on top (Ctrl+W closes the current tab).
- Edit the body directly; it autosaves and commits after 1.2 s. Ctrl+S saves immediately.
- The properties block above the body shows frontmatter; click a value to edit, tags are purple pills.
- Ctrl+P command palette · Ctrl+Shift+F search · Ctrl+F find in document.

## Layout

- **Sidebar**: file tree (with filter) and backlinks.
- **Search bar**: spans the window; supports `tag:` / `path:` / `type:` / `status:` / `-tag:`; ↑↓ select, Enter open, Esc close.
- **Tabs**: open documents; middle-click or Ctrl+click a link to open a new window.
- **Properties**: frontmatter as a key/value table; expand on hover; "＋ Add property" appends a field.
- **Editor**: Live Preview for headings, bold/italic, inline code, tables, images and syntax highlighting; the line under the cursor shows raw source.
- **Status bar**: word count, backlinks, save state.

## Shortcuts

| Shortcut | Action |
|---|---|
| Ctrl+N | New note (goes to the inbox folder) |
| Ctrl+O | Quick switcher |
| Ctrl+W | Close current tab |
| Ctrl+S | Save and commit now |
| Ctrl+P | Command palette |
| Ctrl+Shift+F | Search the whole library |
| Ctrl+F | Find in current document |
| `[[` | Link autocomplete |
| `#` | Tag autocomplete |

## Links

- **Hover** shows title, path, excerpt and backlink count.
- **Left click** opens internally (external links open in the built-in browser).
- **Middle click / Ctrl+click** opens a new window (internal) or the system browser (external).

## Images

Images inside the vault render inline: write `![](relative/path)`; the path is resolved relative to the current document, or from the vault root with a leading `/`. PNG/JPEG/WebP/GIF are supported. This version does not yet auto-save pasted screenshots, dropped files, or a command-palette insert; put the file into `_assets/` first, then reference it.

## Where the data lives

- Knowledge base: a git repository selected by KB_ROOT or the app setting; every change is committed.
- Link snapshots: `~/.config/cognatlas/links/` (HTML, text, screenshot).
- Session and window state: the Electron userData directory.

## Language

Command palette → "Switch intro language", or the language buttons at the top of this page. Switching keeps you on the same page.
