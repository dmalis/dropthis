# Domain Docs

How the engineering skills consume this repo's domain documentation when exploring the codebase.

## Before exploring, read these

- **`AGENTS.md`**: the product, the architecture, the key layout and the **Glossary** section. It is the single glossary; there is no `CONTEXT.md`.
- **`docs/decisions.md`**: every decision with its date and reason, numbered. It is the decision record; there is no `docs/adr/`. Superseded entries are marked, not deleted.
- **`docs/spec-v1.md`**: the v1 specification. Current code beats it on conflict — flag the stale sentence, do not obey it.

## Use the glossary's vocabulary

When your output names a domain concept (an issue title, a test name, a refactor proposal), use the term as the Glossary defines it: Drop, Slug, Title, Meta, Access, Grace, Generation, Key, Instance, Policy, Prune. Do not drift to synonyms the glossary avoids.

A concept the glossary lacks is a signal: either you are inventing language the project does not use (reconsider) or there is a real gap — propose the term for the Glossary in `AGENTS.md`.

## Flag decision conflicts

If your output contradicts an entry in `docs/decisions.md`, say so explicitly rather than silently overriding:

> _Contradicts decision #54 (access is an object), but worth reopening because…_

A new decision goes into `docs/decisions.md` with a date and a reason, in the same commit as the code that made it.
