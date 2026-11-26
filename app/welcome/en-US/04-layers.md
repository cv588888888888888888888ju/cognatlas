# Document layering for large projects

At dozens of notes, "put it in a folder" is enough. At hundreds, the question changes from "where is it" to "which one is authoritative, and where do I start reading". These layers and link rules scale up; adopt them as needed, not all at once.

## Four layers

| Layer | Purpose | Contents | Update rate |
|---|---|---|---|
| **L0 Index** | Entry points and maps | One page per domain, listing children with one-line summaries | low |
| **L1 Convention / decision** | Constraints and rationale | Policy, architecture decisions, contracts, gates | low, changes recorded |
| **L2 Topic / module** | Concrete knowledge | Implementation details, pitfalls, comparisons, procedures | medium |
| **L3 Evidence / raw** | Traceable material | `_raw/`, snapshots, logs, source text | append-only |

L3 is exempt from frontmatter governance and does not need links; it records what actually happened.

## Link direction

- L2 documents link **up** to the L1 conventions they obey.
- L0 indexes link **down** to L1/L2, one line per entry explaining why to click.
- Backlinks are not maintained by hand; point upward and they grow by themselves.
- Avoid lateral links between many sibling fragments; use tags or an index instead.

## Link budget per document

- 3–8 outbound links: fewer usually means the note is not connected; more than 8 suggests it needs an index.
- More than 10 inbound links: it is a hotspot; consider promoting it to L1.
- Zero inbound links: not an error, but decide at the next review whether to link or archive.

## What a folder looks like

```text
30-Agent工程/
  30.0-Agent工程索引.md      ← L0: domain map
  30.12-能力设计与投放.md    ← L1: convention
  30.11-Agent工具链踩坑实测.md ← L2: concrete knowledge
  _raw/                      ← L3: raw records
```

Minimal index template:

```markdown
# Agent engineering index

- [[30.12-能力设计与投放]] — order of operations and rollout criteria.
- [[30.11-Agent工具链踩坑实测]] — real failures and fixes on this machine.
- [[30.7-多Agent并行协作]] — boundaries for parallel collaboration.
```

## Migrating from flat folders

1. **Add L0 first**: one index per top-level folder with links and one-line notes; do not touch existing documents.
2. **Then add upward links**: every L2 links at least one L1; do it folder by folder.
3. **Finally tighten L1**: merge contradictory conventions, mark the rest `deprecated` and link to the survivor.
4. One layer per pass; after each, run `kb status` and spot-check search so no links break.

## Split or merge?

- Two or more independent topics in one document → split.
- The same topic written half in three places → merge.
- Over ~800 lines and search keeps matching only one section → split, leaving an index link behind.

## Quarterly checklist

- [ ] Every top-level folder has an L0 index whose links all resolve.
- [ ] No L2 document links directly to an L3 file path.
- [ ] Documents with zero backlinks have been handled (linked or archived).
- [ ] Expired documents either refreshed or marked `deprecated`.
- [ ] Synonym tags merged; `tag:` search no longer shows two spellings.
