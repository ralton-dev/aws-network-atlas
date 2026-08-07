/**
 * WP-C's rule table, pinned kind by kind.
 *
 * The table below is the point of the package: for every workload / data /
 * security / identity kind the viewer builds, it names the terraform type and
 * the exact import id a scanned resource must produce. Each expected value was
 * read off `website/docs/r/<type>.html.markdown` on
 * `hashicorp/terraform-provider-aws@main` (2026-08-07) — from the `id = "…"`
 * example, never the `identity = { … }` one that now precedes it.
 *
 * Resolution goes through `resolveScanned`, so these are end-to-end
 * assertions: a kind silently claimed by another rule module would change the
 * resolved type and fail here. `registry.ts` merges first-wins **and
 * silently**, which is exactly why the boundary is asserted rather than
 * assumed.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  CONFLICTS,
  emitBlock,
  resolveScanned,
  ruleForKind,
  type ScannedSubject,
} from '../src/index.js';
import { NO_RULE_KINDS, RULES } from '../src/rules/scanned-workload.js';

const ACCOUNT = '111122223333';
const REGION = 'eu-west-1';

function subject(kind: string, fields: Partial<ScannedSubject>): ScannedSubject {
  return { kind, id: '', region: REGION, accountId: ACCOUNT, raw: {}, ...fields };
}

/** `[atlas kind, terraform type, expected import id, scanned fields]`. */
type Case = readonly [string, string, string, Partial<ScannedSubject>];

const LAMBDA_ARN = `arn:aws:lambda:${REGION}:${ACCOUNT}:function:orders`;
const ECS_ARN = `arn:aws:ecs:${REGION}:${ACCOUNT}:service/prod-cluster/web`;
const EKS_ARN = `arn:aws:eks:${REGION}:${ACCOUNT}:cluster/prod`;
const SQS_ARN = `arn:aws:sqs:${REGION}:${ACCOUNT}:orders`;
const MSK_ARN = `arn:aws:kafka:${REGION}:${ACCOUNT}:cluster/events/8f0e-3`;
const ACM_ARN = `arn:aws:acm:${REGION}:${ACCOUNT}:certificate/7e7a28d2-163f`;
const SECRET_ARN = `arn:aws:secretsmanager:${REGION}:${ACCOUNT}:secret:db/password-Ab12Cd`;
const SNS_ARN = `arn:aws:sns:${REGION}:${ACCOUNT}:order-events`;
const SFN_ARN = `arn:aws:states:${REGION}:${ACCOUNT}:stateMachine:fulfilment`;
const JOB_QUEUE_ARN = `arn:aws:batch:${REGION}:${ACCOUNT}:job-queue/nightly`;
const DS_AGENT_ARN = `arn:aws:datasync:${REGION}:${ACCOUNT}:agent/agent-01234567890abcdef`;
const DS_TASK_ARN = `arn:aws:datasync:${REGION}:${ACCOUNT}:task/task-01234567890abcdef`;
const DS_LOC_ARN = `arn:aws:datasync:${REGION}:${ACCOUNT}:location/loc-01234567890abcdef`;
const FIREHOSE_ARN = `arn:aws:firehose:${REGION}:${ACCOUNT}:deliverystream/audit`;
const RAM_ARN = `arn:aws:ram:${REGION}:${ACCOUNT}:resource-share/73da1ab9-b94a`;
const TRAIL_ARN = `arn:aws:cloudtrail:${REGION}:${ACCOUNT}:trail/org-trail`;
const EDS_ARN = `arn:aws:cloudtrail:${REGION}:${ACCOUNT}:eventdatastore/22333815-4414`;
const BACKUP_PLAN_ARN = `arn:aws:backup:${REGION}:${ACCOUNT}:backup-plan:8f1c2d3e-4a5b-6c7d`;
const IAM_POLICY_ARN = `arn:aws:iam::${ACCOUNT}:policy/UsersManageOwnCredentials`;
const SAML_ARN = `arn:aws:iam::${ACCOUNT}:saml-provider/Okta`;
const OIDC_ARN = `arn:aws:iam::${ACCOUNT}:oidc-provider/token.actions.githubusercontent.com`;
const SSO_INSTANCE_ARN = 'arn:aws:sso:::instance/ssoins-2938j0x8920sbj72';
const SSO_PS_ARN = 'arn:aws:sso:::permissionSet/ssoins-2938j0x8920sbj72/ps-80383020jr9302rk';
const SSO_APP_ARN = `arn:aws:sso::${ACCOUNT}:application/ssoins-2938j0x8920sbj72/apl-1234`;

const CASES: readonly Case[] = [
  // --- compute -------------------------------------------------------------
  ['instance', 'aws_instance', 'i-0abc1234def567890', { id: 'i-0abc1234def567890', name: 'web-1' }],
  ['asg', 'aws_autoscaling_group', 'web-asg', { id: 'web-asg', name: 'web-asg' }],
  // TRAP 1 — collect/compute.ts:90 stores the ARN; import is the function name.
  ['lambda', 'aws_lambda_function', 'orders', { id: LAMBDA_ARN, arn: LAMBDA_ARN, name: 'orders' }],

  // --- containers ----------------------------------------------------------
  // TRAP 2 — collect/containers.ts:66 stores serviceArn; import is cluster/name.
  [
    'ecs',
    'aws_ecs_service',
    'prod-cluster/web',
    {
      id: ECS_ARN,
      arn: ECS_ARN,
      name: 'web',
      raw: {
        clusterArn: `arn:aws:ecs:${REGION}:${ACCOUNT}:cluster/prod-cluster`,
        clusterName: 'prod-cluster',
      },
    },
  ],
  // TRAP 3 (not in the plan's table) — collect/containers.ts:99 is
  // `id: c.arn ?? name`; aws_eks_cluster imports by name.
  ['eks', 'aws_eks_cluster', 'prod', { id: EKS_ARN, arn: EKS_ARN, name: 'prod' }],
  ['ecr-repository', 'aws_ecr_repository', 'orders', { id: 'orders', name: 'orders' }],

  // --- relational, cache, search -------------------------------------------
  ['rds', 'aws_db_instance', 'orders-db', { id: 'orders-db', name: 'orders-db' }],
  ['rds-cluster', 'aws_rds_cluster', 'aurora-prod', { id: 'aurora-prod', name: 'aurora-prod' }],
  ['rds-proxy', 'aws_db_proxy', 'orders-proxy', { id: 'orders-proxy', name: 'orders-proxy' }],
  ['elasticache', 'aws_elasticache_cluster', 'sessions-001', { id: 'sessions-001' }],
  [
    'elasticache-replication-group',
    'aws_elasticache_replication_group',
    'sessions',
    { id: 'sessions', name: 'sessions' },
  ],
  [
    'elasticache-serverless',
    'aws_elasticache_serverless_cache',
    'sessions-sl',
    { id: 'sessions-sl', name: 'sessions-sl' },
  ],
  ['efs', 'aws_efs_file_system', 'fs-6fa144c6', { id: 'fs-6fa144c6', name: 'shared' }],
  ['opensearch', 'aws_opensearch_domain', 'logs', { id: 'logs', name: 'logs' }],
  // MSK genuinely imports by ARN, and the collector stores one — right by luck,
  // verified rather than assumed.
  ['msk', 'aws_msk_cluster', MSK_ARN, { id: MSK_ARN, arn: MSK_ARN, name: 'events' }],
  ['redshift', 'aws_redshift_cluster', 'analytics', { id: 'analytics', name: 'analytics' }],
  [
    'redshift-serverless-workgroup',
    'aws_redshiftserverless_workgroup',
    'reporting',
    { id: 'reporting', name: 'reporting' },
  ],
  [
    'redshift-serverless-namespace',
    'aws_redshiftserverless_namespace',
    'reporting-ns',
    { id: 'reporting-ns', name: 'reporting-ns' },
  ],
  ['mq', 'aws_mq_broker', 'b-a1b2c3d4-d5f6', { id: 'b-a1b2c3d4-d5f6', name: 'events-mq' }],
  ['dynamodb-table', 'aws_dynamodb_table', 'GameScores', { id: 'GameScores', name: 'GameScores' }],
  ['neptune-cluster', 'aws_neptune_cluster', 'graph-prod', { id: 'graph-prod' }],
  ['docdb-cluster', 'aws_docdb_cluster', 'docs-prod', { id: 'docs-prod' }],
  ['memorydb-cluster', 'aws_memorydb_cluster', 'mem-prod', { id: 'mem-prod', name: 'mem-prod' }],

  // --- crypto and secrets --------------------------------------------------
  [
    'kms',
    'aws_kms_key',
    '1234abcd-12ab-34cd-56ef-1234567890ab',
    // The collector puts the alias in `name`; the import id is the key id.
    { id: '1234abcd-12ab-34cd-56ef-1234567890ab', name: 'atlas/data' },
  ],
  ['acm', 'aws_acm_certificate', ACM_ARN, { id: ACM_ARN, arn: ACM_ARN, name: 'atlas.example' }],
  ['secret', 'aws_secretsmanager_secret', SECRET_ARN, { id: SECRET_ARN, arn: SECRET_ARN }],

  // --- observability -------------------------------------------------------
  [
    'log-group',
    'aws_cloudwatch_log_group',
    '/aws/lambda/orders',
    { id: '/aws/lambda/orders', name: '/aws/lambda/orders' },
  ],

  // --- regional identity ---------------------------------------------------
  [
    'cognito-user-pool',
    'aws_cognito_user_pool',
    'eu-west-1_abc123',
    { id: 'eu-west-1_abc123', name: 'customers' },
  ],
  [
    'cognito-identity-pool',
    'aws_cognito_identity_pool',
    'eu-west-1:1a234567-8901-234b',
    { id: 'eu-west-1:1a234567-8901-234b', name: 'customers' },
  ],
  [
    'directory-service',
    'aws_directory_service_directory',
    'd-936710ba5c',
    { id: 'd-936710ba5c', name: 'corp.example.com' },
  ],

  // --- messaging -----------------------------------------------------------
  ['sns-topic', 'aws_sns_topic', SNS_ARN, { id: SNS_ARN, arn: SNS_ARN, name: 'order-events' }],
  // TRAP 4 — the queue URL, rebuilt from the ARN (decision 14: no new field).
  [
    'sqs-queue',
    'aws_sqs_queue',
    `https://sqs.${REGION}.amazonaws.com/${ACCOUNT}/orders`,
    { id: SQS_ARN, arn: SQS_ARN, name: 'orders' },
  ],

  // --- eventing ------------------------------------------------------------
  ['event-bus', 'aws_cloudwatch_event_bus', 'orders-bus', { id: 'orders-bus', name: 'orders-bus' }],
  ['eventbridge-pipe', 'aws_pipes_pipe', 'orders-pipe', { id: 'orders-pipe', name: 'orders-pipe' }],
  [
    'eventbridge-schedule',
    'aws_scheduler_schedule',
    'nightly/reindex',
    { id: 'reindex', name: 'reindex', raw: { groupName: 'nightly' } },
  ],

  // --- orchestration -------------------------------------------------------
  [
    'sfn-state-machine',
    'aws_sfn_state_machine',
    SFN_ARN,
    { id: SFN_ARN, arn: SFN_ARN, name: 'fulfilment' },
  ],

  // --- analytics and batch -------------------------------------------------
  ['emr-cluster', 'aws_emr_cluster', 'j-123456ABCDEF', { id: 'j-123456ABCDEF', name: 'etl' }],
  [
    'batch-compute-environment',
    'aws_batch_compute_environment',
    'nightly-ce',
    { id: 'nightly-ce', name: 'nightly-ce' },
  ],
  // Backwards: collect/batch.ts:60 stores the queue NAME as `id`, and
  // aws_batch_job_queue imports by ARN — the opposite of its sibling above.
  [
    'batch-job-queue',
    'aws_batch_job_queue',
    JOB_QUEUE_ARN,
    { id: 'nightly', arn: JOB_QUEUE_ARN, name: 'nightly' },
  ],

  // --- transfer and beanstalk ----------------------------------------------
  ['transfer-server', 'aws_transfer_server', 's-12345678', { id: 's-12345678', name: 's-12345678' }],
  [
    'beanstalk-environment',
    'aws_elastic_beanstalk_environment',
    'e-rpqsewtp2j',
    { id: 'e-rpqsewtp2j', name: 'prod-web' },
  ],

  // --- glue ----------------------------------------------------------------
  [
    'glue-connection',
    'aws_glue_connection',
    `${ACCOUNT}:orders-jdbc`,
    { id: 'orders-jdbc', name: 'orders-jdbc' },
  ],
  ['glue-dev-endpoint', 'aws_glue_dev_endpoint', 'devx', { id: 'devx', name: 'devx' }],
  ['glue-job', 'aws_glue_job', 'nightly-etl', { id: 'nightly-etl', name: 'nightly-etl' }],
  ['glue-crawler', 'aws_glue_crawler', 'orders-crawler', { id: 'orders-crawler', name: 'orders-crawler' }],
  [
    'glue-database',
    'aws_glue_catalog_database',
    `${ACCOUNT}:analytics`,
    { id: 'analytics', name: 'analytics' },
  ],

  // --- database migration --------------------------------------------------
  [
    'dms-replication-instance',
    'aws_dms_replication_instance',
    'dms-ri-1',
    { id: 'dms-ri-1', name: 'dms-ri-1' },
  ],
  ['dms-endpoint', 'aws_dms_endpoint', 'orders-src', { id: 'orders-src', name: 'orders-src' }],
  [
    'dms-replication-task',
    'aws_dms_replication_task',
    'orders-task',
    { id: 'orders-task', name: 'orders-task' },
  ],

  // --- datasync ------------------------------------------------------------
  // Backwards: collect/datasync.ts stores lastSegment(arn) as `id`.
  [
    'datasync-agent',
    'aws_datasync_agent',
    DS_AGENT_ARN,
    { id: 'agent-01234567890abcdef', arn: DS_AGENT_ARN, name: 'dc-agent' },
  ],
  [
    'datasync-task',
    'aws_datasync_task',
    DS_TASK_ARN,
    { id: 'task-01234567890abcdef', arn: DS_TASK_ARN, name: 'nightly-copy' },
  ],
  // One representative per kind here; every other locationType is pinned in
  // DATASYNC_VARIANTS below, including the four that decline their id.
  [
    'datasync-location',
    'aws_datasync_location_s3',
    DS_LOC_ARN,
    { id: 'loc-01234567890abcdef', arn: DS_LOC_ARN, raw: { locationType: 's3' } },
  ],

  // --- streaming -----------------------------------------------------------
  // Backwards: collect/firehose.ts:87 stores the stream NAME as `id`.
  [
    'firehose-delivery-stream',
    'aws_kinesis_firehose_delivery_stream',
    FIREHOSE_ARN,
    { id: 'audit', arn: FIREHOSE_ARN, name: 'audit' },
  ],

  // --- resource sharing ----------------------------------------------------
  ['ram-share', 'aws_ram_resource_share', RAM_ARN, { id: RAM_ARN, arn: RAM_ARN, name: 'net-share' }],

  // --- config --------------------------------------------------------------
  [
    'config-recorder',
    'aws_config_configuration_recorder',
    'default',
    { id: 'default', name: 'default' },
  ],
  ['config-rule', 'aws_config_config_rule', 's3-public-read', { id: 's3-public-read' }],
  [
    'config-conformance-pack',
    'aws_config_conformance_pack',
    'ops-baseline',
    { id: 'ops-baseline', name: 'ops-baseline' },
  ],

  // --- cloudtrail ----------------------------------------------------------
  // Backwards: collect/cloudtrail.ts:78 stores trail.Name; import is the ARN.
  ['cloudtrail-trail', 'aws_cloudtrail', TRAIL_ARN, { id: 'org-trail', arn: TRAIL_ARN, name: 'org-trail' }],
  [
    'cloudtrail-event-data-store',
    'aws_cloudtrail_event_data_store',
    EDS_ARN,
    { id: 'audit-store', arn: EDS_ARN, name: 'audit-store' },
  ],

  // --- posture -------------------------------------------------------------
  [
    'guardduty-detector',
    'aws_guardduty_detector',
    '00b00fd5aecc0ab60a708659477e9617',
    { id: '00b00fd5aecc0ab60a708659477e9617', name: '00b00fd5aecc0ab60a708659477e9617' },
  ],
  ['backup-vault', 'aws_backup_vault', 'Default', { id: 'Default', name: 'Default' }],
  // Backwards: collect/backup.ts:104 stores `BackupPlanName ?? BackupPlanId`,
  // so a named plan's `id` is a name. The plan id lives in the ARN.
  [
    'backup-plan',
    'aws_backup_plan',
    '8f1c2d3e-4a5b-6c7d',
    { id: 'daily-35d', arn: BACKUP_PLAN_ARN, name: 'daily-35d' },
  ],
  // TRAP — collect/security-posture.ts:45 is `id: hub.HubArn ?? 'securityhub'`.
  [
    'securityhub',
    'aws_securityhub_account',
    ACCOUNT,
    {
      id: `arn:aws:securityhub:${REGION}:${ACCOUNT}:hub/default`,
      arn: `arn:aws:securityhub:${REGION}:${ACCOUNT}:hub/default`,
      name: 'securityhub',
    },
  ],
  [
    'access-analyzer',
    'aws_accessanalyzer_analyzer',
    'org-analyzer',
    { id: 'org-analyzer', name: 'org-analyzer' },
  ],
  [
    'inspector2',
    'aws_inspector2_enabler',
    `${ACCOUNT}-EC2:ECR:LAMBDA`,
    {
      id: 'inspector2',
      name: 'inspector2',
      raw: { ec2: 'ENABLED', ecr: 'ENABLED', lambda: 'ENABLED', lambdaCode: 'DISABLED' },
    },
  ],
  ['macie2', 'aws_macie2_account', ACCOUNT, { id: 'macie2', name: 'macie2' }],

  // --- storage -------------------------------------------------------------
  ['s3', 'aws_s3_bucket', 'atlas-logs-euw1', { id: 'atlas-logs-euw1', name: 'atlas-logs-euw1' }],
  // One representative per kind; all four fileSystemTypes are in FSX_VARIANTS.
  [
    'fsx',
    'aws_fsx_lustre_file_system',
    'fs-543ab12b1ca672f33',
    { id: 'fs-543ab12b1ca672f33', name: 'scratch', raw: { fileSystemType: 'LUSTRE' } },
  ],

  // --- IAM -----------------------------------------------------------------
  ['iam-role', 'aws_iam_role', 'AtlasScanner', { id: 'AtlasScanner', name: 'AtlasScanner', arn: `arn:aws:iam::${ACCOUNT}:role/AtlasScanner` }],
  ['iam-user', 'aws_iam_user', 'ben', { id: 'ben', name: 'ben', arn: `arn:aws:iam::${ACCOUNT}:user/ben` }],
  [
    'iam-group',
    'aws_iam_group',
    'developers',
    { id: 'developers', name: 'developers', arn: `arn:aws:iam::${ACCOUNT}:group/developers` },
  ],
  [
    'iam-instance-profile',
    'aws_iam_instance_profile',
    'app-instance-profile-1',
    { id: 'app-instance-profile-1', name: 'app-instance-profile-1' },
  ],
  // Not the same rule as the four above: policies import by ARN, and
  // collect/iam.ts:173 stores the policy NAME as `id`.
  [
    'iam-policy',
    'aws_iam_policy',
    IAM_POLICY_ARN,
    { id: 'UsersManageOwnCredentials', arn: IAM_POLICY_ARN, name: 'UsersManageOwnCredentials' },
  ],
  ['saml-provider', 'aws_iam_saml_provider', SAML_ARN, { id: 'Okta', arn: SAML_ARN, name: 'Okta' }],
  // TRAP running backwards — collect/iam.ts:234 stores the extracted NAME.
  [
    'oidc-provider',
    'aws_iam_openid_connect_provider',
    OIDC_ARN,
    {
      id: 'token.actions.githubusercontent.com',
      arn: OIDC_ARN,
      name: 'token.actions.githubusercontent.com',
    },
  ],

  // --- IAM Identity Center -------------------------------------------------
  // TRAP — a comma-joined composite, not the permission-set ARN alone.
  [
    'sso-permission-set',
    'aws_ssoadmin_permission_set',
    `${SSO_PS_ARN},${SSO_INSTANCE_ARN}`,
    { id: SSO_PS_ARN, arn: SSO_PS_ARN, name: 'AdministratorAccess', raw: { instanceArn: SSO_INSTANCE_ARN } },
  ],
  [
    'sso-application',
    'aws_ssoadmin_application',
    SSO_APP_ARN,
    { id: SSO_APP_ARN, arn: SSO_APP_ARN, name: 'Atlas' },
  ],

  // --- organizations -------------------------------------------------------
  ['org', 'aws_organizations_organization', 'o-1234567', { id: 'o-1234567' }],
  [
    'org-ou',
    'aws_organizations_organizational_unit',
    'ou-abc1-def23456',
    { id: 'ou-abc1-def23456', name: 'workloads' },
  ],
  [
    'org-account',
    'aws_organizations_account',
    '444455556666',
    { id: '444455556666', name: 'prod' },
  ],
  ['org-policy', 'aws_organizations_policy', 'p-12345678', { id: 'p-12345678', name: 'deny-root' }],
];

for (const [kind, type, want, fields] of CASES) {
  test(`${kind} resolves to ${type} with a doc-verified import id`, () => {
    const resolved = resolveScanned(subject(kind, fields));
    assert.equal(resolved.type, type, `${kind}: wrong terraform type`);
    assert.equal(resolved.id, want, `${kind}: wrong import id`);
    assert.equal(resolved.verified, true, `${kind}: a rule must have produced the id`);
  });
}

test('no rule hands back an ARN where the provider wants a native identifier', () => {
  // The regression this whole package exists to prevent, asserted in bulk: if
  // the expected id is not an ARN, the resolved id must not be one either.
  // A future passthrough added by mistake fails here as well as in its own row.
  for (const [kind, , want, fields] of CASES) {
    if (want.startsWith('arn:')) continue;
    const { id } = resolveScanned(subject(kind, fields));
    assert.ok(!id.startsWith('arn:'), `${kind} resolved to an ARN (${id}) but wants ${want}`);
  }
});

test('the table covers exactly the kinds the rule module claims', () => {
  const declared = new Set(RULES.flatMap((rule) => rule.kinds ?? []));
  const tested = new Set(CASES.map(([kind]) => kind));
  assert.deepEqual([...tested].sort(), [...declared].sort());
  assert.equal(CASES.length, tested.size, 'a kind appears twice in the table');
  // One rule per kind: a rule serving two kinds would hide a wrong type.
  assert.equal(RULES.length, declared.size);
});

test('every workload kind is served by this module, not another one', () => {
  // registry.ts merges byKind first-wins and *silently*: a kind claimed by both
  // scanned-network.ts and this module yields no CONFLICTS entry, and WP-B wins
  // on source order. Two shapes have to be caught separately.
  //
  // Different type for the same kind — the silent one. Comparing the object is
  // no use (the registry stores `{ ...rule }` copies), so compare the type.
  const mineByKind = new Map<string, string>();
  for (const rule of RULES) for (const kind of rule.kinds ?? []) mineByKind.set(kind, rule.type);
  for (const [kind, type] of mineByKind) {
    assert.equal(ruleForKind(kind)?.type, type, `${kind}: claimed by another rule module`);
  }

  // Same type declared twice with a `fromScanned` each — this one the registry
  // does report, and first-wins means the other module's function would run.
  const mineTypes = new Set(RULES.map((rule) => rule.type));
  assert.deepEqual(
    CONFLICTS.filter((c) => mineTypes.has(c.type)),
    [],
    'another module declared fromScanned/notImportable for a type WP-C owns',
  );
});

test('kinds AWS models but terraform does not have no rule at all', () => {
  // What is left after WP-I. `fsx` and `datasync-location` used to be here,
  // declined because a kind whose terraform *type* depends on a collected
  // field could not be expressed; `typeFromScanned` expresses it and both are
  // real rules below. These two are the honest case — the provider has no
  // resource for them at any variant, so the fallback is the final answer.
  assert.deepEqual(Object.keys(NO_RULE_KINDS).sort(), ['ecr-registry', 'sso-instance']);
  for (const kind of Object.keys(NO_RULE_KINDS)) {
    assert.equal(ruleForKind(kind), undefined, `${kind} should have no rule`);
    const resolved = resolveScanned(subject(kind, { id: 'fs-0abc', name: 'thing' }));
    assert.equal(resolved.type, '', `${kind} must not be given a guessed terraform type`);
    assert.equal(resolved.verified, false);
    assert.ok(resolved.comments.some((c) => c.startsWith('VERIFY:')));
  }
});

// --- Kinds whose terraform type depends on a collected field ---------------

/**
 * WP-I. Both kinds here map one atlas record onto several provider resources,
 * and both used to be declined outright — a commented-out block with no type
 * and no candidates, for every FSx file system and every DataSync location in
 * the estate. `typeFromScanned` resolves the type per subject, so they now
 * emit real blocks for the variants they can place and a *named shortlist* for
 * the ones they cannot.
 *
 * `datasync-location` is also the case that proves the type and the id fail
 * independently: the four FSx-backed locations resolve their type exactly and
 * cannot build their id, which is the opposite of every other row here.
 */
interface Variant {
  readonly what: string;
  readonly subject: ScannedSubject;
  /** `''` asserts that no terraform type may be emitted. */
  readonly type: string;
  readonly id: string;
  readonly verified: boolean;
}

const FS_ID = 'fs-543ab12b1ca672f33';

/**
 * All four FSx file system pages print the identical
 * `id = "fs-543ab12b1ca672f33"`, so only the type was ever in doubt.
 * `collect/fsx.ts:52` writes `FileSystemType ?? 'UNKNOWN'`, which is why the
 * literal `UNKNOWN` has a row of its own.
 */
const FSX_VARIANTS: readonly Variant[] = [
  {
    what: 'a Lustre file system',
    subject: subject('fsx', { id: FS_ID, name: 'scratch', raw: { fileSystemType: 'LUSTRE' } }),
    type: 'aws_fsx_lustre_file_system',
    id: FS_ID,
    verified: true,
  },
  {
    what: 'a Windows file system',
    subject: subject('fsx', { id: FS_ID, name: 'shares', raw: { fileSystemType: 'WINDOWS' } }),
    type: 'aws_fsx_windows_file_system',
    id: FS_ID,
    verified: true,
  },
  {
    what: 'an ONTAP file system',
    subject: subject('fsx', { id: FS_ID, name: 'ontap', raw: { fileSystemType: 'ONTAP' } }),
    type: 'aws_fsx_ontap_file_system',
    id: FS_ID,
    verified: true,
  },
  {
    what: 'an OpenZFS file system',
    subject: subject('fsx', { id: FS_ID, name: 'zfs', raw: { fileSystemType: 'OPENZFS' } }),
    type: 'aws_fsx_openzfs_file_system',
    id: FS_ID,
    verified: true,
  },
  {
    what: 'a file system whose type the collector could not read',
    subject: subject('fsx', { id: FS_ID, name: 'mystery', raw: { fileSystemType: 'UNKNOWN' } }),
    type: '',
    id: FS_ID,
    verified: false,
  },
];

/**
 * The DataSync location types, and the split that motivated the whole seam.
 * The plain locations import by the location ARN; the four FSx-backed ones
 * import by `<location-arn>#<fsx-arn>` — verified on all four pages, with
 * ONTAP wanting the storage-virtual-machine ARN rather than the file system's
 * — and `collect/datasync.ts:91` keeps only `SecurityGroupArns` from the
 * describe call, so the second half is not in the snapshot at all.
 */
const DATASYNC_VARIANTS: readonly Variant[] = [
  {
    what: 'an S3 location',
    subject: subject('datasync-location', {
      id: 'loc-01234567890abcdef',
      arn: DS_LOC_ARN,
      raw: { locationType: 's3' },
    }),
    type: 'aws_datasync_location_s3',
    id: DS_LOC_ARN,
    verified: true,
  },
  {
    what: 'an NFS location',
    subject: subject('datasync-location', {
      id: 'loc-01234567890abcdef',
      arn: DS_LOC_ARN,
      raw: { locationType: 'nfs' },
    }),
    type: 'aws_datasync_location_nfs',
    id: DS_LOC_ARN,
    verified: true,
  },
  {
    what: 'an SMB location',
    subject: subject('datasync-location', {
      id: 'loc-01234567890abcdef',
      arn: DS_LOC_ARN,
      raw: { locationType: 'smb' },
    }),
    type: 'aws_datasync_location_smb',
    id: DS_LOC_ARN,
    verified: true,
  },
  {
    what: 'an EFS location',
    subject: subject('datasync-location', {
      id: 'loc-01234567890abcdef',
      arn: DS_LOC_ARN,
      raw: { locationType: 'efs' },
    }),
    type: 'aws_datasync_location_efs',
    id: DS_LOC_ARN,
    verified: true,
  },
  {
    what: 'an HDFS location',
    subject: subject('datasync-location', {
      id: 'loc-01234567890abcdef',
      arn: DS_LOC_ARN,
      raw: { locationType: 'hdfs' },
    }),
    type: 'aws_datasync_location_hdfs',
    id: DS_LOC_ARN,
    verified: true,
  },
  {
    // The exact scheme string AWS returns for these two could not be verified
    // against a real snapshot, so the rule matches after stripping separators
    // and case: both spellings reach the same type and neither can reach a
    // different one. This row is the hyphenated spelling.
    what: 'an object-storage location',
    subject: subject('datasync-location', {
      id: 'loc-01234567890abcdef',
      arn: DS_LOC_ARN,
      raw: { locationType: 'object-storage' },
    }),
    type: 'aws_datasync_location_object_storage',
    id: DS_LOC_ARN,
    verified: true,
  },
  {
    what: 'an object_storage location under the underscore spelling',
    subject: subject('datasync-location', {
      id: 'loc-01234567890abcdef',
      arn: DS_LOC_ARN,
      raw: { locationType: 'object_storage' },
    }),
    type: 'aws_datasync_location_object_storage',
    id: DS_LOC_ARN,
    verified: true,
  },
  {
    what: 'an Azure Blob location',
    subject: subject('datasync-location', {
      id: 'loc-01234567890abcdef',
      arn: DS_LOC_ARN,
      raw: { locationType: 'azure-blob' },
    }),
    type: 'aws_datasync_location_azure_blob',
    id: DS_LOC_ARN,
    verified: true,
  },
  // The four whose id is a composite the snapshot cannot supply: the TYPE
  // resolves and the ID does not. Nothing else in this package runs this way,
  // and it is why `typeFromScanned` is independent of `fromScanned` rather
  // than one function returning a pair.
  {
    what: 'an FSx for Windows location',
    subject: subject('datasync-location', {
      id: 'loc-01234567890abcdef',
      arn: DS_LOC_ARN,
      raw: { locationType: 'fsxWindows' },
    }),
    type: 'aws_datasync_location_fsx_windows_file_system',
    // Declining the id falls the block back to `subject.id`, which for a
    // DataSync location is `lastSegment(arn)` — flagged, and not the ARN.
    id: 'loc-01234567890abcdef',
    verified: false,
  },
  {
    what: 'an FSx for Lustre location',
    subject: subject('datasync-location', {
      id: 'loc-01234567890abcdef',
      arn: DS_LOC_ARN,
      raw: { locationType: 'fsxLustre' },
    }),
    type: 'aws_datasync_location_fsx_lustre_file_system',
    // Declining the id falls the block back to `subject.id`, which for a
    // DataSync location is `lastSegment(arn)` — flagged, and not the ARN.
    id: 'loc-01234567890abcdef',
    verified: false,
  },
  {
    what: 'an FSx for ONTAP location',
    subject: subject('datasync-location', {
      id: 'loc-01234567890abcdef',
      arn: DS_LOC_ARN,
      raw: { locationType: 'fsxOntap' },
    }),
    type: 'aws_datasync_location_fsx_ontap_file_system',
    // Declining the id falls the block back to `subject.id`, which for a
    // DataSync location is `lastSegment(arn)` — flagged, and not the ARN.
    id: 'loc-01234567890abcdef',
    verified: false,
  },
  {
    what: 'an FSx for OpenZFS location',
    subject: subject('datasync-location', {
      id: 'loc-01234567890abcdef',
      arn: DS_LOC_ARN,
      raw: { locationType: 'fsxOpenZfs' },
    }),
    type: 'aws_datasync_location_fsx_openzfs_file_system',
    // Declining the id falls the block back to `subject.id`, which for a
    // DataSync location is `lastSegment(arn)` — flagged, and not the ARN.
    id: 'loc-01234567890abcdef',
    verified: false,
  },
  {
    // Unlike `fsx`, these eleven do not share one id form, so an unreadable
    // locationType leaves both halves unknown and the ARN must not be vouched
    // for. `collect/datasync.ts:29` returns undefined for an unparseable URI.
    what: 'a location whose type the collector could not read',
    subject: subject('datasync-location', {
      id: 'loc-01234567890abcdef',
      arn: DS_LOC_ARN,
    }),
    type: '',
    id: 'loc-01234567890abcdef',
    verified: false,
  },
];

for (const v of [...FSX_VARIANTS, ...DATASYNC_VARIANTS]) {
  test(`${v.what} resolves to ${v.type === '' ? 'no terraform type' : v.type}`, () => {
    const resolved = resolveScanned(v.subject);
    assert.equal(resolved.type, v.type, `${v.what}: wrong terraform type`);
    assert.equal(resolved.id, v.id, `${v.what}: wrong import id`);
    assert.equal(resolved.verified, v.verified, `${v.what}: ${resolved.comments.join(' | ')}`);
  });
}

test('both per-subject type resolvers cover every variant they advertise', () => {
  const ambiguous = RULES.filter((r) => r.typeFromScanned !== undefined);
  assert.deepEqual(ambiguous.map((r) => r.type).sort(), [
    'aws_datasync_location_s3',
    'aws_fsx_lustre_file_system',
  ]);
  const emitted = new Set(
    [...FSX_VARIANTS, ...DATASYNC_VARIANTS].map((v) => v.type).filter((t) => t !== ''),
  );
  for (const rule of ambiguous) {
    const choices = rule.typeChoices ?? [];
    assert.ok(choices.length > 1, `${rule.type}: typeFromScanned without candidates`);
    // The declared type is the merge key and nothing more. Neither of these
    // kinds has a dominant variant, so `type` is an arbitrary member of the
    // set and must never be emitted except by `typeFromScanned` choosing it.
    assert.ok(choices.includes(rule.type), `${rule.type}: merge key is not a candidate`);
    for (const choice of choices) {
      assert.ok(emitted.has(choice), `${choice} is advertised but no variant produces it`);
    }
  }
});

/**
 * The regression WP-I fixes, in this half of the table. Before, every FSx file
 * system emitted a fully commented-out block with no type and no hint; a
 * Windows file system is now a block you can paste.
 */
test('a Windows file system is no longer declined outright', () => {
  const windows = resolveScanned(
    subject('fsx', { id: FS_ID, name: 'shares', raw: { fileSystemType: 'WINDOWS' } }),
  );
  const text = emitBlock(windows);
  assert.match(text, /^ {2}to = aws_fsx_windows_file_system\.shares$/m);
  assert.match(text, new RegExp(`id = "${FS_ID}"`));
  assert.doesNotMatch(text, /VERIFY/);
  assert.doesNotMatch(text, /aws_fsx_lustre_file_system/, 'the merge key must never be emitted');
});

test('an unreadable FSx type is commented out and names all four candidates', () => {
  const unknown = resolveScanned(
    subject('fsx', { id: FS_ID, name: 'mystery', raw: { fileSystemType: 'UNKNOWN' } }),
  );
  const text = emitBlock(unknown);
  for (const line of text.split('\n')) {
    assert.ok(line.startsWith('# '), `line is pasteable but has no type: ${line}`);
  }
  assert.match(text, /VERIFY: the terraform resource type could not be determined/);
  assert.match(
    text,
    /Candidates: aws_fsx_lustre_file_system, aws_fsx_windows_file_system, aws_fsx_ontap_file_system, aws_fsx_openzfs_file_system/,
  );
  // All four import by the `fs-…` id, so this claim is safe here — and the
  // block is one word away from being usable.
  assert.match(text, /The id below is right whichever of those it is/);
  assert.doesNotMatch(text, /could not build an import id/);
});

/**
 * The reverse split. The type is exact and the id genuinely cannot be built,
 * so the comment must blame the id — the one case where the old wording was
 * right, kept working, and now names the resolved type rather than a
 * placeholder.
 */
test('an FSx-backed DataSync location keeps its type and flags only the id', () => {
  const fsxLoc = resolveScanned(
    subject('datasync-location', {
      id: 'loc-01234567890abcdef',
      arn: DS_LOC_ARN,
      raw: { locationType: 'fsxWindows' },
    }),
  );
  const text = emitBlock(fsxLoc);
  assert.match(text, /^ {2}to = aws_datasync_location_fsx_windows_file_system\./m);
  assert.match(
    text,
    /the aws_datasync_location_fsx_windows_file_system rule could not build an import id/,
    'the comment must name the resolved type, not the merge key',
  );
  assert.doesNotMatch(text, /type could not be determined/);
  assert.doesNotMatch(text, /aws_datasync_location_s3/);
});

test('an unreadable DataSync location declines both halves rather than vouching', () => {
  const unknown = resolveScanned(
    subject('datasync-location', { id: 'loc-01234567890abcdef', arn: DS_LOC_ARN }),
  );
  const text = emitBlock(unknown);
  assert.match(text, /VERIFY: the terraform resource type could not be determined/);
  // These eleven disagree about the id form, so no claim may be made about it.
  assert.doesNotMatch(text, /right whichever of those it is/);
  assert.match(text, /could not build an import id/);
});

test('every rule records the provider doc page its id format came from', () => {
  for (const rule of RULES) {
    assert.match(rule.doc ?? '', /^website\/docs\/r\/.+\.html\.markdown$/, rule.type);
  }
});

// --- derivations that have to hold on inputs the fixture never contains -----

test('the SQS queue URL follows the ARN, not the subject region', () => {
  // A resource whose ARN region disagrees with ref.region is exactly the shape
  // packages/scanner/src/fixture.ts never produces.
  const resolved = resolveScanned(
    subject('sqs-queue', {
      id: 'arn:aws:sqs:us-east-1:444455556666:orders.fifo',
      arn: 'arn:aws:sqs:us-east-1:444455556666:orders.fifo',
      region: REGION,
    }),
  );
  assert.equal(resolved.id, 'https://sqs.us-east-1.amazonaws.com/444455556666/orders.fifo');
});

test('the SQS queue URL carries the China partition DNS suffix', () => {
  const resolved = resolveScanned(
    subject('sqs-queue', { id: 'arn:aws-cn:sqs:cn-north-1:444455556666:orders' }),
  );
  assert.equal(resolved.id, 'https://sqs.cn-north-1.amazonaws.com.cn/444455556666/orders');
});

test('an SQS subject with no usable ARN falls back and is flagged', () => {
  const resolved = resolveScanned(subject('sqs-queue', { id: 'orders', name: 'orders' }));
  assert.equal(resolved.type, 'aws_sqs_queue');
  assert.equal(resolved.id, 'orders');
  assert.equal(resolved.verified, false);
  assert.ok(resolved.comments.some((c) => c.includes('could not build an import id')));
});

test('ECS falls back to the cluster ARN when clusterName is absent', () => {
  // Snapshots written before collect/containers.ts:71 existed have clusterArn
  // only, and emitting the service ARN instead would be silently wrong.
  const resolved = resolveScanned(
    subject('ecs', {
      id: ECS_ARN,
      arn: ECS_ARN,
      name: 'web',
      raw: { clusterArn: `arn:aws:ecs:${REGION}:${ACCOUNT}:cluster/prod-cluster` },
    }),
  );
  assert.equal(resolved.id, 'prod-cluster/web');
});

test('ECS recovers the service name from an old-format service ARN', () => {
  const old = `arn:aws:ecs:${REGION}:${ACCOUNT}:service/web`;
  const resolved = resolveScanned(
    subject('ecs', { id: old, arn: old, raw: { clusterName: 'prod-cluster' } }),
  );
  assert.equal(resolved.id, 'prod-cluster/web');
});

test('lambda refuses to pass an ARN off as a function name', () => {
  const resolved = resolveScanned(subject('lambda', { id: LAMBDA_ARN, arn: LAMBDA_ARN }));
  assert.equal(resolved.verified, false);
  assert.equal(resolved.id, LAMBDA_ARN, 'the flagged fallback keeps the scanned id');
  assert.ok(resolved.comments.some((c) => c.includes('could not build an import id')));
});

test('a permission set recovers its instance ARN from its own ARN', () => {
  // sso.ts sets instanceArn today, but older snapshots predate the field and a
  // one-armed composite would be silently wrong.
  const resolved = resolveScanned(subject('sso-permission-set', { id: SSO_PS_ARN, arn: SSO_PS_ARN }));
  assert.equal(resolved.id, `${SSO_PS_ARN},${SSO_INSTANCE_ARN}`);
});

test('a backup plan with no ARN falls back rather than emitting the plan name', () => {
  const resolved = resolveScanned(subject('backup-plan', { id: 'daily-35d', name: 'daily-35d' }));
  assert.equal(resolved.type, 'aws_backup_plan');
  assert.equal(resolved.verified, false);
});

test('inspector2 emits nothing when no resource type is enabled', () => {
  const resolved = resolveScanned(
    subject('inspector2', { id: 'inspector2', raw: { ec2: 'DISABLED', ecr: 'DISABLED' } }),
  );
  assert.equal(resolved.verified, false);
});

test('glue falls back when the catalog account is unknown', () => {
  const resolved = resolveScanned(
    subject('glue-database', { id: 'analytics', name: 'analytics', accountId: '' }),
  );
  assert.equal(resolved.verified, false);
});
