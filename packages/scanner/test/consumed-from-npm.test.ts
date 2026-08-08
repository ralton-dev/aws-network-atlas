/**
 * The definition of "fully extracted", asserted from this side of the boundary.
 *
 * `tf-import-blocks` is being lifted out of this repo and published to npm.
 * Two things are jointly true only when that is finished, and neither is true
 * today:
 *
 *   1. the package resolves to something outside `<repo>/packages/` — i.e. it
 *      is an installed dependency, not a workspace symlink back into the
 *      source tree;
 *   2. `atlas-scan tf-blocks` still reproduces `awkward.expected.tf` byte for
 *      byte — i.e. consuming it as a published dependency changed nothing
 *      observable.
 *
 * Either alone is easy and worthless. (1) without (2) is an extraction that
 * quietly changed the emitted HCL; (2) without (1) is just today.
 *
 * It lives in `packages/scanner/test/` rather than in the package because it
 * has to survive `rm -rf packages/tf-import-blocks/`.
 *
 * RESOLVED — 2026-08-08. This landed under `{ todo: true }` while the split was
 * in flight, red on assertion 1 with:
 *
 *   AssertionError [ERR_ASSERTION]: tf-import-blocks still resolves inside the
 *   source tree: <repo>/packages/tf-import-blocks/dist/index.js
 *
 * because npm workspaces symlinked `node_modules/tf-import-blocks` straight
 * back to `packages/tf-import-blocks` and Node's CJS resolver realpaths through
 * it, so the package the scanner loaded was the one in this repo. Assertion 2
 * passed even then, which was the point of running it first.
 *
 * The todo came off when `packages/tf-import-blocks/` was deleted and both
 * consumers moved to `tf-import-blocks@^0.1.0` from the public registry. It is
 * a plain assertion now and must stay one: if it ever goes red again, either
 * the dependency has been re-pointed at something inside this tree, or
 * consuming the published package has changed the emitted HCL.
 */
import assert from 'node:assert/strict';
import { realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { tfBlocks } from '../src/tf-blocks.js';

const resolver = createRequire(import.meta.url);

/**
 * Realpath'd on both sides, deliberately.
 *
 * Node's CJS resolver already returns a realpath — it calls `realpathSync` on
 * the result unless `--preserve-symlinks` is set — so on this runner the
 * `realpathSync` below is a no-op and the naive check would happen to be right.
 * That is luck, not design: `import.meta.resolve` does *not* follow symlinks
 * and would report `node_modules/tf-import-blocks/…`, passing for entirely the
 * wrong reason. Resolving both sides makes the assertion mean what it says
 * under either resolver and under `--preserve-symlinks`, and costs nothing.
 */
const REPO_ROOT = realpathSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..'),
);
const SOURCE_TREE = path.join(REPO_ROOT, 'packages') + path.sep;

/**
 * The fixtures are read out of *whatever copy of the package is installed*,
 * not out of `packages/`, which is the only way this test can outlive the
 * directory it is guarding. `tf-import-blocks` ships `test/fixtures/` in its
 * tarball for exactly this, and its `exports` map carries a `./package.json`
 * entry so the package root is nameable — without it Node answers
 * `ERR_PACKAGE_PATH_NOT_EXPORTED` and there is no supported way to find it.
 *
 * It also means the golden compared against is the one versioned with the
 * emitter that produced it. A local copy would go stale silently the first
 * time the package legitimately changed its output.
 */
const FIXTURES = path.join(
  path.dirname(realpathSync(resolver.resolve('tf-import-blocks/package.json'))),
  'test',
  'fixtures',
);

/** `##` lines in the golden are annotations for the reader, not expected output. */
function stripAnnotations(text: string): string {
  return text
    .split('\n')
    .filter((line) => !line.startsWith('##'))
    .join('\n');
}

test(
  'tf-import-blocks resolves from outside packages/, and the CLI still reproduces the golden',
  async () => {
    // Assertion 2 runs first on purpose. It was the ordering that kept the
    // golden comparison live while assertion 1 was known-red; now that both
    // pass it is simply the more informative failure to see first.
    const { hcl } = await tfBlocks({
      files: [path.join(FIXTURES, 'awkward.tfstate.json')],
      cwd: REPO_ROOT,
    });
    const golden = stripAnnotations(await readFile(path.join(FIXTURES, 'awkward.expected.tf'), 'utf8'));
    assert.equal(hcl, golden, 'the CLI no longer reproduces awkward.expected.tf byte for byte');

    const entry = realpathSync(resolver.resolve('tf-import-blocks'));
    assert.ok(
      !entry.startsWith(SOURCE_TREE),
      `tf-import-blocks still resolves inside the source tree: ${entry}`,
    );
  },
);
