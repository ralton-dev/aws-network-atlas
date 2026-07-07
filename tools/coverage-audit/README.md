# Coverage audit

Generates [`docs/coverage.html`](../../docs/coverage.html) — the **authoritative source of
truth** for what this tool sees. It lists **every AWS resource type that can be created**
(from the CloudFormation resource registry) and, for each, whether the scanner **collects**
it and whether the viewer **draws** it.

Run it:

```bash
npm run coverage
```

## Why it exists

Earlier coverage notes audited the scanner against a self-selected "networking surface" — so
they could tick everything off while most of the AWS estate stayed dark. This page instead
measures against the **entire** CloudFormation registry (~1,600 resource types across ~280
services), so a gap can't hide by being declared out of scope. Today ~93% of resource types
have no dedicated collector; that's the reality this page keeps honest.

## Columns

- **Resource type** — driven from the CloudFormation resource specification (downloaded and
  cached under `.cache/`, git-ignored). This is the "what can exist in AWS" spine.
- **Collected** — one of:
  - `Detailed` — a dedicated collector captures typed attributes (mapped to a first-class
    collection in `packages/schema/src/snapshot.ts`).
  - `Inventory (untagged-catch)` — swept by the Cloud Control API list in
    `packages/scanner/src/collect/cloudcontrol.ts`, regardless of tags (ARN/name/tags only).
  - `Inventory — if tagged` — caught by the Resource Groups Tagging API sweep **only if the
    resource is tagged**; untagged instances are invisible.
  - `Not collected` — no collector and not taggable — never seen.
- **Displayed** — `node` (its own box on a graph view), `edge` (only a connecting line/route),
  `panel-only` (searchable inventory / details pane, never on the graph), or `not displayed`.
- **CFN props** — the count (and, with "show attributes" toggled on, the full list) of that
  type's CloudFormation properties, so attribute-level gaps are visible too.

## How it stays correct

`generate.cjs` cross-checks its inputs against the real source at build time and **fails loudly**
on drift:

- Every collection in the schema's `emptyRegionSnapshot()` / `emptyGlobal()` factories must be
  mapped to its CloudFormation type(s) in the `DETAILED` table — and vice versa.
- Every mapped collection must have a `display-map.json` entry.
- The Cloud Control sweep list is read directly from `cloudcontrol.ts`, not duplicated.

So if you add or remove a collector without updating this tool, `npm run coverage` errors
instead of producing a stale page.

## Files

| File | What it is |
| --- | --- |
| `generate.cjs` | The generator + the `DETAILED` map (CFN type → schema collection). |
| `display-map.json` | Per-collection viewer rendering classification (node/edge/panel-only) — update when the viewer's rendering changes. |
| `.cache/` | Downloaded CloudFormation spec (git-ignored). Delete to force a re-download. |
