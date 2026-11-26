# Health baseline

"Healthy" does not mean "many documents"; it means **search results can be trusted**. Measurements below come from the live `okf status --json` output — no hardcoded snapshot numbers.

## Six core metrics

| Metric | Meaning | Healthy line |
|---|---|---|
| `errors` | Lint-level errors (invalid or missing frontmatter) | **must be 0** |
| `ghost` | Files in the git index but deleted on disk | **must be 0** |
| `unreadable` | Files that cannot be read (permissions, encoding) | **must be 0** |
| `no_frontmatter` | Documents with no frontmatter at all | < 10% and trending down |
| `tiers` | Trust tiers: unverified / machine-confirmed / human-reviewed | machine-confirmed ≥ 70% |
| stale coverage | Documents with external facts but no `stale_after` | key conventions 100% |

`errors`, `ghost` and `unreadable` are hard red lines: if any is non-zero, fix it before writing new content.

## Reading trust tiers

- `unverified`: no validation record yet (new documents).
- `machine-confirmed`: at least one format-gate pass (`okf commit` appends a `process:okf-commit` record).
- `human-reviewed`: the human confirmed the content; only `human:` records count — AI cannot sign on your behalf.

A low tier does not mean the content is wrong, only that no traceable check was recorded. Do not pad the numbers.

## How to measure

```bash
# Full health snapshot (JSON)
python3 .okf/okf_commit.py status --json

# Same data, human readable
kb status

# The resident service adds index freshness
curl -s http://127.0.0.1:18812/health
```

`stale: true` means the index is older than the refresh interval (30 min by default). Search still works, but may lag the disk.

## Handling anomalies

- **High no_frontmatter**: add `type`, `generated`, `source_checked` via the properties block; test on a small sample before batch-fixing.
- **Non-zero ghost**: deleted files still listed by git; run `git add -A` and re-check status.
- **Non-zero unreadable**: check permissions and encoding (non-UTF-8 counts).
- **Expired documents**: keep them. Search still returns them with an `expired` warning; review and refresh `stale_after` or mark `deprecated`.
- **Zero backlinks**: not an error, but the note is not yet in the network; link it from an index.

## Five-minute weekly check

1. `kb status` — the three red lines at zero?
2. Search `status:draft` — any stale drafts?
3. Pick a document with zero backlinks and decide: link it in, or archive it.
4. Review expired documents and confirm their conclusions still hold.

## Custom health standards (advanced)

The defaults are a starting point, not a hard-coded product rule. Health policy lives in the vault's own `.okf/health.yaml` and travels with the repository; change it per team or project without touching code.

### 1. Change thresholds

```yaml
version: 1
thresholds:
  errors_max: 0              # hard red line: lint errors
  ghost_max: 0               # in the git index, missing on disk
  unreadable_max: 0          # cannot be read
  no_frontmatter_ratio_max: 0.10
  machine_confirmed_ratio_min: 0.70
  stale_ratio_max: 0.25
  checker_errors_max: 0
checkers:
  params: {}
external: {}
```

Changes take effect immediately: `python3 .okf/okf_commit.py health` recomputes; `--json` for machines, `--strict` to make warnings return non-zero. `/health` exposes the same `ok / thresholds / violations` under `kb.health`.

`ok` only means there are no error-level violations. Warnings appear in `violations` but do not flip `ok`; use `--strict` when warnings must block.

### 2. Pass parameters to checkers

Parameter chain, lowest to highest:

1. `.okf/config.yaml` → `checkers.params` (vault defaults)
2. `.okf/health.yaml` → `checkers.params` (health-run overrides)
3. `--param name.key=value` on the command line (temporary, repeatable)

```yaml
# .okf/health.yaml
checkers:
  params:
    broken-links:
      ignore: ["drafts/", "archive/"]
    stale-docs:
      grace_days: 7
```

```bash
okf health --param stale-docs.grace_days=30
okf check --param broken-links.ignore='["temp/"]' 00-inbox/
```

Parameters for one checker are **replaced as a whole**, not deep-merged: if the health layer defines `broken-links`, it takes over that checker's map from the config layer. Omit the key if you do not want to override.

Built-in sample checkers accept:

| Checker | Parameter | Meaning |
|---|---|---|
| `broken-links` | `ignore` (string array) | skip targets containing any substring |
| `broken-links` | `level` | `warn` / `error` |
| `stale-docs` | `grace_days` (integer) | days of grace after expiry |
| `stale-docs` | `level` | `warn` / `error` |

### 3. Plug in an external checker

If a checker should not live under `.okf/checkers/`, attach any command to the health result. `okf health` feeds it a metrics JSON on stdin and reads the last stdout line:

```yaml
external:
  command: ~/bin/check-kb
  args: ["--strict"]
  timeout_seconds: 10
```

stdin: `{root, metrics, thresholds, params}`. The last stdout line must be `{"findings":[{"level":"warn","message":"…","value":0,"threshold":0}]}`. A failing or timed-out command becomes one warning; it never crashes the health run.

The external command runs with local permissions. Only attach scripts you trust; it is not a sandbox.

### 4. When to change the standard

- New vault: relax `no_frontmatter_ratio_max` first; do not make day one all red. Tighten to 0.10 once formatting settles.
- Convention vault: keep `errors_max` / `ghost_max` at 0 and raise `machine_confirmed_ratio_min` to 0.80.
- Vault with external facts: tighten `stale_ratio_max` and set `stale-docs` `grace_days`.
- Numbers are policy, not facts: say why you changed them in the commit; never edit just to turn green.