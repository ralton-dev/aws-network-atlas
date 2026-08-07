/**
 * The red pin.
 *
 * This test states what correct output looks like and fails until it is true.
 * It runs under `{ todo: true }`, so `npm test` still exits 0 — the tree
 * documents the known defect without a red build.
 *
 * **WP-E removes `{ todo: true }`. When this passes as a plain assertion, the
 * plan is done. There is no other definition.** If it does not pass, the defect
 * is in the rule modules (WP-B / WP-C / WP-D), not here: the fixtures are the
 * specification and their values came off the provider doc pages, so do not
 * edit them to match the code.
 *
 * Three things are asserted, all from the same two fixtures:
 *
 *   1. State path — `importsFromState(awkward.tfstate.json)` emits
 *      `awkward.expected.tf` byte for byte (after `##` annotation lines are
 *      stripped from the golden).
 *   2. Scanned path — each subject in `awkward.scanned.json` resolves to the
 *      terraform type and import id recorded beside it.
 *   3. Agreement — where a type appears on both paths the two produce the same
 *      string. That is the plan's completion signal.
 *
 * ---------------------------------------------------------------------------
 * OBSERVED FAILURE at WP-A (rule tables empty, 2026-08-07). Recorded so the
 * next agent can tell a *new* failure from the expected one:
 *
 *   IMPORT IDS (state path) — 4 of 15 blocks resolve to the wrong id
 *     aws_ecs_service.web             aws_ecs_service
 *       expected "prod-cluster/web"
 *       actual   "arn:aws:ecs:eu-west-1:111122223333:service/prod-cluster/web"
 *     aws_route.default               aws_route
 *       expected "rtb-656C65616E6F72_0.0.0.0/0"
 *       actual   "r-rtb-656C65616E6F721080289494"
 *     aws_security_group_rule.web_ingress   aws_security_group_rule
 *       expected "sg-6e616f6d69_ingress_tcp_8000_8000_10.0.3.0/24"
 *       actual   "sgrule-1859128000"
 *     aws_wafv2_web_acl.edge          aws_wafv2_web_acl
 *       expected "a1b2c3d4-d5f6-7777-8888-9999aaaabbbbcccc/edge-acl/REGIONAL"
 *       actual   "a1b2c3d4-d5f6-7777-8888-9999aaaabbbbcccc"
 *
 *   IMPORT IDS (scanned path) — 4 of 6 subjects resolve to the wrong id
 *     sqs-queue     expected "https://sqs.eu-west-1.amazonaws.com/111122223333/orders"
 *                   actual   "arn:aws:sqs:eu-west-1:111122223333:orders"
 *     lambda        expected "orders-worker"
 *                   actual   "arn:aws:lambda:eu-west-1:111122223333:function:orders-worker"
 *     ecs           expected "prod-cluster/web"
 *                   actual   "arn:aws:ecs:eu-west-1:111122223333:service/prod-cluster/web"
 *     waf-web-acl   expected "a1b2c3d4-…-cccc/edge-acl/REGIONAL"
 *                   actual   "a1b2c3d4-…-cccc"
 *     (vpc and iam-role — the controls — already agree on the id)
 *
 *   TERRAFORM TYPE — 6 of 6 scanned subjects resolve to no type at all, because
 *   no rule module claims any atlas kind yet.
 *
 *   FALLBACK COMMENTS — 14 of 15 state blocks carry
 *   `VERIFY: no rule for <type>` that the golden does not. Only
 *   aws_s3_object is *supposed* to, and it is the one type no rule module owns.
 *
 *   AGREEMENT — aws_sqs_queue and aws_lambda_function resolve differently
 *   depending on which path produced them (URL/name from state, ARN from the
 *   scan). Those two are the clearest statement of the whole defect.
 *
 *   Types disagreeing: aws_db_instance, aws_ecs_service, aws_iam_role,
 *   aws_iam_role_policy_attachment, aws_lambda_function, aws_nat_gateway,
 *   aws_route, aws_route53_record, aws_s3_bucket, aws_security_group_rule,
 *   aws_sqs_queue, aws_subnet, aws_vpc, aws_wafv2_web_acl
 *
 * Note the shape of it: on the state path SQS and Lambda are *not* wrong,
 * because terraform-provider-aws happens to store the queue URL and the
 * function name as the state id. They are wrong on the scanned path, where
 * atlas stores the ARN. Both halves are needed to see the whole defect, which
 * is why this test drives both.
 * ---------------------------------------------------------------------------
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  emitBlocks,
  importsFromState,
  resolveScanned,
  type ResolvedImport,
  type ScannedSubject,
} from '../src/index.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

const read = (name: string): string => readFileSync(path.join(FIXTURES, name), 'utf8');

/**
 * `##` lines in the golden are annotations — provider doc citations and notes
 * for whoever reads it next — and are not part of the expected output. Nothing
 * else is touched: blank lines and single-`#` comments are compared.
 */
export function stripAnnotations(text: string): string {
  return text
    .split('\n')
    .filter((line) => !line.startsWith('##'))
    .join('\n');
}

interface Block {
  readonly address: string;
  /** The id exactly as written between the quotes — escaped, not decoded. */
  readonly idLiteral: string;
  readonly comments: string[];
  readonly text: string;
}

function parseBlocks(text: string): Block[] {
  return text
    .replace(/\n$/, '')
    .split('\n\n')
    .filter((stanza) => stanza.trim() !== '')
    .map((stanza) => {
      let address = '';
      let idLiteral = '';
      const comments: string[] = [];
      for (const line of stanza.split('\n')) {
        const to = /^\s*to = (.+)$/.exec(line);
        const id = /^\s*id = "(.*)"\s*$/.exec(line);
        if (to !== null) address = to[1] ?? '';
        else if (id !== null) idLiteral = id[1] ?? '';
        else if (line.startsWith('# ')) comments.push(line.slice(2));
      }
      return { address, idLiteral, comments, text: stanza };
    });
}

/** The terraform type an address belongs to, e.g. `module.a.aws_vpc.b[0]` → `aws_vpc`. */
function typeOfAddress(address: string): string {
  const parts = address.split('.');
  for (let i = parts.length - 1; i >= 0; i--) {
    const part = parts[i];
    if (part !== undefined && part.startsWith('aws_')) return part;
  }
  return address;
}

interface ScannedCase {
  readonly why: string;
  readonly expectedType: string;
  readonly expectedId: string;
  readonly doc: string;
  readonly subject: ScannedSubject;
}

function loadScannedCases(): ScannedCase[] {
  const parsed = JSON.parse(read('awkward.scanned.json')) as { subjects: ScannedCase[] };
  return parsed.subjects;
}

function quote(value: string): string {
  return `"${value}"`;
}

/** Everything wrong with the current output, as prose a human can act on. */
function buildReport(): string {
  const sections: string[] = [];
  const disagreeingTypes = new Set<string>();

  // ── 1. state path ────────────────────────────────────────────────────────
  const state = JSON.parse(read('awkward.tfstate.json')) as unknown;
  const resolved: ResolvedImport[] = importsFromState(state, 'awkward.tfstate.json');
  const actual = parseBlocks(emitBlocks(resolved));
  const expected = parseBlocks(stripAnnotations(read('awkward.expected.tf')));

  const actualByAddress = new Map(actual.map((b) => [b.address, b]));
  const expectedByAddress = new Map(expected.map((b) => [b.address, b]));

  const missing = expected.filter((b) => !actualByAddress.has(b.address));
  const extra = actual.filter((b) => !expectedByAddress.has(b.address));
  if (missing.length > 0 || extra.length > 0) {
    const lines = ['BLOCK SET — the generated blocks are not the expected blocks'];
    for (const b of missing) lines.push(`  missing  ${b.address}`);
    for (const b of extra) lines.push(`  extra    ${b.address}`);
    sections.push(lines.join('\n'));
    for (const b of [...missing, ...extra]) disagreeingTypes.add(typeOfAddress(b.address));
  }

  const wrongId: Block[] = [];
  const wrongComments: Array<[Block, Block]> = [];
  for (const exp of expected) {
    const act = actualByAddress.get(exp.address);
    if (act === undefined) continue;
    if (act.idLiteral !== exp.idLiteral) {
      wrongId.push(exp);
      disagreeingTypes.add(typeOfAddress(exp.address));
    }
    if (act.comments.join('\n') !== exp.comments.join('\n')) {
      wrongComments.push([exp, act]);
      disagreeingTypes.add(typeOfAddress(exp.address));
    }
  }

  if (wrongId.length > 0) {
    const lines = [
      `IMPORT IDS (state path) — ${wrongId.length} of ${expected.length} blocks resolve to the wrong id`,
    ];
    for (const exp of wrongId) {
      const act = actualByAddress.get(exp.address);
      lines.push(`  ${exp.address}   ${typeOfAddress(exp.address)}`);
      lines.push(`    expected ${quote(exp.idLiteral)}`);
      lines.push(`    actual   ${quote(act?.idLiteral ?? '<absent>')}`);
    }
    sections.push(lines.join('\n'));
  }

  if (wrongComments.length > 0) {
    const lines = [
      `FALLBACK COMMENTS — ${wrongComments.length} of ${expected.length} state blocks carry ` +
        'comments the golden does not (or lack ones it has)',
    ];
    for (const [exp, act] of wrongComments) {
      const surplus = act.comments.filter((c) => !exp.comments.includes(c));
      const absent = exp.comments.filter((c) => !act.comments.includes(c));
      lines.push(`  ${exp.address}`);
      for (const c of surplus) lines.push(`    unexpected  # ${c}`);
      for (const c of absent) lines.push(`    missing     # ${c}`);
    }
    sections.push(lines.join('\n'));
  }

  // ── 2. scanned path ──────────────────────────────────────────────────────
  const cases = loadScannedCases();
  const badId: string[] = [];
  const badType: string[] = [];
  for (const c of cases) {
    const got = resolveScanned(c.subject);
    if (got.id !== c.expectedId) {
      badId.push(
        `  ${c.subject.kind.padEnd(13)} ${c.why}\n` +
          `    expected ${quote(c.expectedId)}\n` +
          `    actual   ${quote(got.id)}`,
      );
      disagreeingTypes.add(c.expectedType);
    }
    if (got.type !== c.expectedType) {
      badType.push(
        `  ${c.subject.kind.padEnd(13)} expected ${c.expectedType}, got ` +
          `${got.type === '' ? '<no rule for this kind>' : got.type}`,
      );
      disagreeingTypes.add(c.expectedType);
    }
  }
  if (badId.length > 0) {
    sections.push(
      `IMPORT IDS (scanned path) — ${badId.length} of ${cases.length} subjects resolve to ` +
        `the wrong id\n${badId.join('\n')}`,
    );
  }
  if (badType.length > 0) {
    sections.push(
      `TERRAFORM TYPE — ${badType.length} of ${cases.length} scanned subjects resolve to the ` +
        `wrong type\n${badType.join('\n')}`,
    );
  }

  // ── 3. cross-path agreement ──────────────────────────────────────────────
  const stateIdByType = new Map<string, string>();
  for (const b of actual) stateIdByType.set(typeOfAddress(b.address), b.idLiteral);
  const disagree: string[] = [];
  for (const c of cases) {
    const fromStateId = stateIdByType.get(c.expectedType);
    if (fromStateId === undefined) continue;
    const fromScannedId = resolveScanned(c.subject).id;
    if (fromStateId !== fromScannedId) {
      disagree.push(
        `  ${c.expectedType}\n` +
          `    from state   ${quote(fromStateId)}\n` +
          `    from scanned ${quote(fromScannedId)}`,
      );
      disagreeingTypes.add(c.expectedType);
    }
  }
  if (disagree.length > 0) {
    sections.push(
      'AGREEMENT — a type resolved differently depending on which path produced it; ' +
        `both must produce the same string\n${disagree.join('\n')}`,
    );
  }

  if (sections.length === 0) return '';
  sections.push(`Types disagreeing: ${[...disagreeingTypes].sort().join(', ')}`);
  return `\n${sections.join('\n\n')}\n`;
}

test('import blocks for awkward.tfstate.json match the golden output', { todo: true }, () => {
  // `assert.fail`, not `assert.equal(report, '')`: the latter prints the whole
  // report twice — once as the message and again as a string diff — which
  // buries the thing you need to read.
  const report = buildReport();
  if (report !== '') assert.fail(report);

  // Belt and braces: the per-block report above is the legible signal, but the
  // file must also match exactly — ordering, blank lines and all.
  const state = JSON.parse(read('awkward.tfstate.json')) as unknown;
  const generated = emitBlocks(importsFromState(state, 'awkward.tfstate.json'));
  assert.equal(generated, stripAnnotations(read('awkward.expected.tf')));
});
