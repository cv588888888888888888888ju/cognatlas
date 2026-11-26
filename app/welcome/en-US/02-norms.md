# General conventions

These apply to every document. They describe **the rules this library actually enforces**, not an ideal; if a rule changes, update `.okf/config.yaml` and this page together.

## The 12 standard frontmatter fields

The order is fixed (okf normalizes it on commit; unknown custom fields are kept after these):

| Field | Meaning | Required |
|---|---|---|
| `type` | Document type (see below) | yes |
| `title` | Title, separate from the body H1 | recommended |
| `description` | One-sentence summary used by search and hover | strongly recommended |
| `tags` | Tag array; reuse existing vocabulary | recommended |
| `aliases` | Alternate names for search | optional |
| `status` | `draft` / `stable` / `deprecated` | recommended |
| `generated.by` | Last editor identity | yes |
| `generated.at` | Last update time, refreshed on commit | yes |
| `source_checked` | Whether sources were checked (boolean, explicit) | yes |
| `source_checked_at` | When sources were checked | optional |
| `verified` | Verification records (appended by tools) | automatic |
| `stale_after` | Expiry date; search warns after it | recommended |
| `sources` | External sources | optional |

All four required fields are enforced; a missing one makes `okf commit` reject and roll back.

## Document types

- `Knowledge` — reusable knowledge, conventions, conclusions (most common).
- `Note` — working notes, temporary records.
- `Policy` — binding rules (gates, processes, must-follow conventions).
- `Asset` — images and other non-text resources.

When unsure, use `Note`; it is the fallback and can be promoted later.

## What to put in properties

- `description`: one standalone sentence, not "this document introduces…".
- `tags`: search the vocabulary first; do not create a second spelling of the same concept.
- `status`: `draft` still changing, `stable` safe to cite, `deprecated` kept but not to be used.
- `stale_after`: required for anything with external facts (versions, prices, APIs, policies).

## Naming and folders

- File names: short phrases or `number-topic`; avoid spaces and `#` / `?`.
- Folders are by domain, not by date; time belongs in frontmatter and the body.
- `_raw/` holds raw material and is exempt from governance; `70-元知识/` holds the conventions themselves; the inbox holds unclassified drafts.
- Create notes with `kb new "Title" --dir 30-Agent工程` so required fields are filled in.

## Links

- Internal links use `[[file name]]` or `[text](relative/path.md)`; both feed backlinks.
- Prefer linking to a convention/index page over sibling fragments.
- Rename through the client or `kb rename` so links are rewritten library-wide.

## Commit identity and tokens

- `human:user` — you. The desktop client and an interactive terminal use this by default; the client issues a token on first run.
- `agent:<runtime>:<sessionId>` — a token claimed by an AI session, e.g. `agent:deepseekharness:s-abc123`.
- `process:<name>` — scripts and cron without a session.
- Token command: `kb token new --name <label> [--runtime deepseekharness --session <id>] [--save]`. The plaintext is printed once; `--save` writes `~/.config/kb/token`.
- **No valid token means no access**: CLI exits 2 (AUTH-NEEDED / AUTH-INVALID), HTTP returns 401, MCP exits 2. First run: `kb token new --name me --save`.
- The git author of a commit is the token identity; the client status bar shows the last committer and date.
- Never put a token in the knowledge base or commit it to git.

## Checkers

- Content checks live in `.okf/checkers/` plugins; `okf check` runs them, and commits follow `checkers.gate` (`warn` = report, `block` = reject).
- Format gates (required frontmatter, parseable YAML) stay built into okf; do not try to bypass them.
- Health thresholds and checker parameters live in `.okf/health.yaml`; `okf health --json` returns `ok`, metrics and `violations`. Defaults are a starting point — tune them per project, never edit them just to turn green.

## Do not

- Hardcode `generated.at` to fake freshness; commit refreshes it.
- Add `verified` records for reviews that never happened.
- Duplicate the same content in two folders; use links and an index.
- Write absolute paths or `file://` links in the body.
