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
 * quietly changed the emitted HCL; (2) without (1) is just today. Landed as
 * `{ todo: true }` so the suite keeps exiting 0 while the split is in flight —
 * node:test *runs* a todo test and reports its failure without counting it —
 * and the todo comes off in WP-6. When it passes as a plain assertion the
 * extraction is done; there is no other definition.
 *
 * It lives in `packages/scanner/test/` rather than in the package because it
 * has to survive `rm -rf packages/tf-import-blocks/`.
 *
 * OBSERVED FAILURE — this is what actually happened, not what was expected.
 * Run un-todo'd on 2026-08-08 at 95e66fa, with the built artifact in place:
 *
 *   $ npx tsx --test "packages/scanner/test/consumed-from-npm.test.ts"
 *   ✖ tf-import-blocks resolves from outside packages/, and the CLI still
 *     reproduces the golden (4.531375ms)
 *   ℹ tests 1
 *   ℹ pass 0
 *   ℹ fail 1
 *
 *   ✖ failing tests:
 *   AssertionError [ERR_ASSERTION]: tf-import-blocks still resolves inside the
 *   source tree: /Users/benralton/repos/BEN_WORKING/terraform_graphing/
 *   packages/tf-import-blocks/dist/index.js
 *       at TestContext.<anonymous> (packages/scanner/test/consumed-from-npm.test.ts:113:12)
 *     generatedMessage: false,
 *     code: 'ERR_ASSERTION',
 *     actual: false,
 *     expected: true,
 *     operator: '=='
 *
 * The failing frame is the resolution assert, not the golden compare — line
 * numbers below refer to that run, before the `{ todo: true }` went back on —
 * so execution got past assertion 2. Assertion 2 already passes; assertion 1
 * is the whole of the red. That is the point: `npm install` symlinks
 * `node_modules/tf-import-blocks` straight back to `packages/tf-import-blocks`,
 * and Node's CJS resolver realpaths through it, so the package the scanner
 * loads is the one in this repo.
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
  { todo: true },
  async () => {
    // Assertion 2 runs first on purpose. Today only assertion 1 can fail, and
    // putting it first would leave the golden comparison as dead code behind a
    // known-red assert for the whole life of the split — the half that would
    // actually catch a behaviour change never running.
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
