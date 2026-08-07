/**
 * Tier A — workload, data, security and identity kinds, resolved from a
 * scanned resource alone.
 *
 * Owned by WP-C. The network and edge half lives in `scanned-network.ts`
 * (WP-B); the two kind lists are disjoint and `waf-*` belongs to WP-B.
 *
 * **The assumption this file exists to break is "a resource's import id is its
 * id".** In this half of the estate it fails in both directions:
 *
 *  - the collector stored an **ARN** where the provider wants a native
 *    identifier — `lambda`, `ecs`, `eks`, `sqs-queue`, `securityhub`;
 *  - the collector stored a **name** where the provider wants the **ARN** —
 *    `iam-policy`, `saml-provider`, `oidc-provider`, `cloudtrail-trail`,
 *    `cloudtrail-event-data-store`, `batch-job-queue`, `datasync-agent`,
 *    `datasync-task`, `firehose-delivery-stream`, `backup-plan`.
 *
 * The second group is the one that survives review, because "id is an ARN,
 * take the name off it" is the shape everybody expects and these run the other
 * way. Neither group may be written as a passthrough.
 *
 * Every id format below was read off
 * `website/docs/r/<type>.html.markdown` in `hashicorp/terraform-provider-aws`
 * on `main` (2026-08-07), from the `id = "…"` example — **not** the
 * `identity = { … }` example that now appears above it, which decision 3
 * forbids emitting. The `doc` field on each rule records the page.
 */
import type { ImportRule, ScannedSubject } from '../types.js';
import { parseArn, str } from '../types.js';

/** The provider doc page an id format was verified against. */
function doc(page: string): string {
  return `website/docs/r/${page}.html.markdown`;
}

/**
 * `id` only when it is *not* an ARN. Fifteen collectors write an ARN into a
 * field named `id`, so "the id" is never safe to hand to a rule that needs a
 * native identifier — this is the guard that makes that impossible.
 */
function nativeId(s: ScannedSubject): string | undefined {
  return parseArn(s.id) === undefined ? str(s.id) : undefined;
}

/** The ARN, from wherever the collector put it. Never returns a non-ARN. */
function arnOf(s: ScannedSubject): string | undefined {
  const arn = str(s.arn);
  if (arn !== undefined) return arn;
  return parseArn(s.id) !== undefined ? str(s.id) : undefined;
}

/** The resource's own name, refusing to pass an ARN off as one. */
function nameOf(s: ScannedSubject): string | undefined {
  return str(s.name) ?? nativeId(s);
}

/** Last `/`-delimited segment — the tail of an ARN resource path. */
function lastPathSegment(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return str(value.split('/').pop());
}

/** The scanned `id` is already the import id. */
function passthrough(type: string, kind: string, page: string): ImportRule {
  return { type, kinds: [kind], fromScanned: (s) => str(s.id), doc: doc(page) };
}

/** The import id is the ARN, whatever the collector chose to call `id`. */
function byArn(type: string, kind: string, page: string): ImportRule {
  return { type, kinds: [kind], fromScanned: arnOf, doc: doc(page) };
}

/** The import id is the resource name, whatever the collector chose as `id`. */
function byName(type: string, kind: string, page: string): ImportRule {
  return { type, kinds: [kind], fromScanned: nameOf, doc: doc(page) };
}

/**
 * The import id is the AWS account id: the resource models an account-level
 * service subscription rather than a thing with an identifier of its own.
 */
function byAccountId(type: string, kind: string, page: string): ImportRule {
  return { type, kinds: [kind], fromScanned: (s) => str(s.accountId), doc: doc(page) };
}

/**
 * `arn:<partition>:sqs:<region>:<account>:<name>` →
 * `https://sqs.<region>.<dns-suffix>/<account>/<name>`.
 *
 * The scanner stores the queue **ARN** (`collect/messaging.ts:142` —
 * `id: queueArn ?? queueUrl`) and never stores the URL, so it has to be
 * rebuilt. Decision 14 is explicit that this does not earn a snapshot field:
 * the mapping is total and adopting drift must not require a re-scan.
 */
function sqsQueueUrl(s: ScannedSubject): string | undefined {
  const parsed = parseArn(arnOf(s));
  if (parsed === undefined || parsed.service !== 'sqs') return undefined;
  const region = str(parsed.region) ?? str(s.region);
  const account = str(parsed.accountId) ?? str(s.accountId);
  const name = str(parsed.resource);
  if (region === undefined || account === undefined || name === undefined) return undefined;
  // China's endpoints carry the `.cn` suffix; every other partition does not.
  const suffix = parsed.partition === 'aws-cn' ? 'amazonaws.com.cn' : 'amazonaws.com';
  return `https://sqs.${region}.${suffix}/${account}/${name}`;
}

/**
 * `<cluster-name>/<service-name>`. `EcsService` carries `clusterName`, derived
 * from `clusterArn` at `collect/containers.ts:71`; when an older snapshot
 * lacks it, take the tail of `clusterArn` rather than emitting a bare ARN.
 */
function ecsServiceId(s: ScannedSubject): string | undefined {
  const cluster =
    str(s.raw['clusterName']) ?? lastPathSegment(str(s.raw['clusterArn']));
  // Both ECS service ARN formats end in the service name.
  const service = str(s.name) ?? lastPathSegment(str(s.arn) ?? str(s.id));
  if (cluster === undefined || service === undefined) return undefined;
  return `${cluster}/${service}`;
}

/** `<group-name>/<schedule-name>`; EventBridge Scheduler's default group is `default`. */
function schedulerScheduleId(s: ScannedSubject): string | undefined {
  const name = nameOf(s);
  if (name === undefined) return undefined;
  return `${str(s.raw['groupName']) ?? 'default'}/${name}`;
}

/** `<catalog-id>:<name>`; the catalog id is the owning account unless overridden. */
function glueCatalogId(s: ScannedSubject): string | undefined {
  const name = nameOf(s);
  const catalog = str(s.raw['catalogId']) ?? str(s.accountId);
  if (name === undefined || catalog === undefined) return undefined;
  return `${catalog}:${name}`;
}

/**
 * The plan **id**, not the plan name. `collect/backup.ts:104` stores
 * `BackupPlanName ?? BackupPlanId` as `id`, so a named plan's `id` is a name —
 * but the ARN's resource field is `backup-plan:<plan-id>`, so the real id is
 * recoverable. Verified against `internal/service/backup/plan.go`, which sets
 * the resource id from `BackupPlanId`.
 */
function backupPlanId(s: ScannedSubject): string | undefined {
  const parsed = parseArn(arnOf(s));
  if (parsed === undefined) return undefined;
  const resource = str(parsed.resource);
  if (resource === undefined || !resource.startsWith('backup-plan:')) return undefined;
  return str(resource.slice('backup-plan:'.length));
}

/**
 * `<permission-set-arn>,<instance-arn>` — comma-joined, no space.
 *
 * `collect/sso.ts:105` stores the permission-set ARN as `id` and the instance
 * ARN alongside it. When the instance ARN is missing it is still recoverable:
 * a permission-set ARN embeds the instance id
 * (`…:permissionSet/ssoins-abc/ps-def` → `…:instance/ssoins-abc`).
 */
function permissionSetId(s: ScannedSubject): string | undefined {
  const psArn = arnOf(s);
  const parsed = parseArn(psArn);
  if (psArn === undefined || parsed === undefined) return undefined;
  const instanceArn = str(s.raw['instanceArn']) ?? deriveSsoInstanceArn(parsed);
  if (instanceArn === undefined) return undefined;
  return `${psArn},${instanceArn}`;
}

function deriveSsoInstanceArn(parsed: NonNullable<ReturnType<typeof parseArn>>): string | undefined {
  const parts = parsed.resource.split('/');
  const instanceId = parts[1];
  if (parts[0] !== 'permissionSet' || instanceId === undefined || instanceId === '') return undefined;
  return `arn:${parsed.partition}:sso:::instance/${instanceId}`;
}

/**
 * `<account-ids sorted ascending>-<resource-types sorted alphabetically>`.
 *
 * The scanner records only the calling account's per-resource-type state
 * (`collect/security-posture.ts:96`), so the account list is this one account.
 * **Known incompleteness:** the provider also accepts `CODE_REPOSITORY`, which
 * `InspectorStatus` does not carry — if that is enabled the id will be short
 * by one type and `terraform plan` will show it as a diff. That is a visible
 * failure, unlike the literal `inspector2` the fallback would otherwise emit.
 */
function inspector2EnablerId(s: ScannedSubject): string | undefined {
  const account = str(s.accountId);
  if (account === undefined) return undefined;
  const enabled: string[] = [];
  for (const [field, type] of [
    ['ec2', 'EC2'],
    ['ecr', 'ECR'],
    ['lambda', 'LAMBDA'],
    ['lambdaCode', 'LAMBDA_CODE'],
  ] as const) {
    if (str(s.raw[field]) === 'ENABLED') enabled.push(type);
  }
  if (enabled.length === 0) return undefined;
  return `${account}-${[...enabled].sort().join(':')}`;
}

export const RULES: ImportRule[] = [
  // ---- compute ------------------------------------------------------------
  passthrough('aws_instance', 'instance', 'instance'),
  // `id` is the ASG name already (`collect/compute.ts:60`).
  passthrough('aws_autoscaling_group', 'asg', 'autoscaling_group'),
  // TRAP: `collect/compute.ts:90` stores `FunctionArn ?? FunctionName`; the
  // provider imports by `function_name`.
  byName('aws_lambda_function', 'lambda', 'lambda_function'),

  // ---- containers ---------------------------------------------------------
  // TRAP: `collect/containers.ts:66` stores `serviceArn`; import is
  // `cluster-name/service-name`.
  {
    type: 'aws_ecs_service',
    kinds: ['ecs'],
    fromScanned: ecsServiceId,
    doc: doc('ecs_service'),
  },
  // TRAP (not in the plan's table): `collect/containers.ts:99` is
  // `id: c.arn ?? name`, but `aws_eks_cluster` imports by `name`. Same defect
  // class as Lambda.
  byName('aws_eks_cluster', 'eks', 'eks_cluster'),
  passthrough('aws_ecr_repository', 'ecr-repository', 'ecr_repository'),

  // ---- relational + cache + search ----------------------------------------
  passthrough('aws_db_instance', 'rds', 'db_instance'),
  passthrough('aws_rds_cluster', 'rds-cluster', 'rds_cluster'),
  passthrough('aws_db_proxy', 'rds-proxy', 'db_proxy'),
  passthrough('aws_elasticache_cluster', 'elasticache', 'elasticache_cluster'),
  passthrough(
    'aws_elasticache_replication_group',
    'elasticache-replication-group',
    'elasticache_replication_group',
  ),
  passthrough(
    'aws_elasticache_serverless_cache',
    'elasticache-serverless',
    'elasticache_serverless_cache',
  ),
  passthrough('aws_efs_file_system', 'efs', 'efs_file_system'),
  passthrough('aws_opensearch_domain', 'opensearch', 'opensearch_domain'),
  // `collect/vpc-workloads.ts:133` stores `ClusterArn`, and MSK does import by
  // ARN — one of the cases where the naive assumption is right by luck.
  byArn('aws_msk_cluster', 'msk', 'msk_cluster'),
  passthrough('aws_redshift_cluster', 'redshift', 'redshift_cluster'),
  passthrough(
    'aws_redshiftserverless_workgroup',
    'redshift-serverless-workgroup',
    'redshiftserverless_workgroup',
  ),
  passthrough(
    'aws_redshiftserverless_namespace',
    'redshift-serverless-namespace',
    'redshiftserverless_namespace',
  ),
  passthrough('aws_mq_broker', 'mq', 'mq_broker'),
  passthrough('aws_dynamodb_table', 'dynamodb-table', 'dynamodb_table'),
  passthrough('aws_neptune_cluster', 'neptune-cluster', 'neptune_cluster'),
  passthrough('aws_docdb_cluster', 'docdb-cluster', 'docdb_cluster'),
  passthrough('aws_memorydb_cluster', 'memorydb-cluster', 'memorydb_cluster'),

  // ---- crypto + secrets ---------------------------------------------------
  passthrough('aws_kms_key', 'kms', 'kms_key'),
  byArn('aws_acm_certificate', 'acm', 'acm_certificate'),
  byArn('aws_secretsmanager_secret', 'secret', 'secretsmanager_secret'),

  // ---- observability ------------------------------------------------------
  passthrough('aws_cloudwatch_log_group', 'log-group', 'cloudwatch_log_group'),

  // ---- regional identity --------------------------------------------------
  passthrough('aws_cognito_user_pool', 'cognito-user-pool', 'cognito_user_pool'),
  passthrough('aws_cognito_identity_pool', 'cognito-identity-pool', 'cognito_identity_pool'),
  passthrough('aws_directory_service_directory', 'directory-service', 'directory_service_directory'),

  // ---- messaging ----------------------------------------------------------
  // `collect/messaging.ts:90` stores the topic ARN and SNS imports by ARN.
  byArn('aws_sns_topic', 'sns-topic', 'sns_topic'),
  // TRAP: the queue URL, rebuilt from the ARN (decision 14).
  {
    type: 'aws_sqs_queue',
    kinds: ['sqs-queue'],
    fromScanned: sqsQueueUrl,
    doc: doc('sqs_queue'),
  },

  // ---- eventing -----------------------------------------------------------
  passthrough('aws_cloudwatch_event_bus', 'event-bus', 'cloudwatch_event_bus'),
  passthrough('aws_pipes_pipe', 'eventbridge-pipe', 'pipes_pipe'),
  {
    type: 'aws_scheduler_schedule',
    kinds: ['eventbridge-schedule'],
    fromScanned: schedulerScheduleId,
    doc: doc('scheduler_schedule'),
  },

  // ---- orchestration ------------------------------------------------------
  // `collect/stepfunctions.ts:103` stores the ARN and Step Functions imports
  // by ARN — correct by luck, verified rather than assumed.
  byArn('aws_sfn_state_machine', 'sfn-state-machine', 'sfn_state_machine'),

  // ---- analytics + batch --------------------------------------------------
  passthrough('aws_emr_cluster', 'emr-cluster', 'emr_cluster'),
  // Compute environments import by name; job queues by ARN. The two Batch
  // resources disagree with each other, and `collect/batch.ts` stores the name
  // as `id` for both.
  passthrough(
    'aws_batch_compute_environment',
    'batch-compute-environment',
    'batch_compute_environment',
  ),
  byArn('aws_batch_job_queue', 'batch-job-queue', 'batch_job_queue'),

  // ---- transfer + beanstalk -----------------------------------------------
  passthrough('aws_transfer_server', 'transfer-server', 'transfer_server'),
  passthrough(
    'aws_elastic_beanstalk_environment',
    'beanstalk-environment',
    'elastic_beanstalk_environment',
  ),

  // ---- glue ---------------------------------------------------------------
  {
    type: 'aws_glue_connection',
    kinds: ['glue-connection'],
    fromScanned: glueCatalogId,
    doc: doc('glue_connection'),
  },
  passthrough('aws_glue_dev_endpoint', 'glue-dev-endpoint', 'glue_dev_endpoint'),
  passthrough('aws_glue_job', 'glue-job', 'glue_job'),
  passthrough('aws_glue_crawler', 'glue-crawler', 'glue_crawler'),
  {
    type: 'aws_glue_catalog_database',
    kinds: ['glue-database'],
    fromScanned: glueCatalogId,
    doc: doc('glue_catalog_database'),
  },

  // ---- database migration -------------------------------------------------
  passthrough(
    'aws_dms_replication_instance',
    'dms-replication-instance',
    'dms_replication_instance',
  ),
  passthrough('aws_dms_endpoint', 'dms-endpoint', 'dms_endpoint'),
  passthrough('aws_dms_replication_task', 'dms-replication-task', 'dms_replication_task'),

  // ---- datasync -----------------------------------------------------------
  // `collect/datasync.ts` stores `lastSegment(arn)` as `id` (e.g.
  // `agent-0123…`), but every DataSync resource imports by full ARN.
  byArn('aws_datasync_agent', 'datasync-agent', 'datasync_agent'),
  byArn('aws_datasync_task', 'datasync-task', 'datasync_task'),

  // ---- streaming ----------------------------------------------------------
  // `collect/firehose.ts:87` stores the delivery-stream *name*; the provider
  // imports by ARN.
  byArn(
    'aws_kinesis_firehose_delivery_stream',
    'firehose-delivery-stream',
    'kinesis_firehose_delivery_stream',
  ),

  // ---- resource sharing ---------------------------------------------------
  byArn('aws_ram_resource_share', 'ram-share', 'ram_resource_share'),

  // ---- config -------------------------------------------------------------
  passthrough('aws_config_configuration_recorder', 'config-recorder', 'config_configuration_recorder'),
  passthrough('aws_config_config_rule', 'config-rule', 'config_config_rule'),
  passthrough('aws_config_conformance_pack', 'config-conformance-pack', 'config_conformance_pack'),

  // ---- cloudtrail ---------------------------------------------------------
  // `collect/cloudtrail.ts:78` stores `trail.Name`; the current provider docs
  // import `aws_cloudtrail` by ARN, not by name.
  byArn('aws_cloudtrail', 'cloudtrail-trail', 'cloudtrail'),
  byArn(
    'aws_cloudtrail_event_data_store',
    'cloudtrail-event-data-store',
    'cloudtrail_event_data_store',
  ),

  // ---- posture ------------------------------------------------------------
  passthrough('aws_guardduty_detector', 'guardduty-detector', 'guardduty_detector'),
  passthrough('aws_backup_vault', 'backup-vault', 'backup_vault'),
  {
    type: 'aws_backup_plan',
    kinds: ['backup-plan'],
    fromScanned: backupPlanId,
    doc: doc('backup_plan'),
  },
  // TRAP: `collect/security-posture.ts:45` is `id: hub.HubArn ?? 'securityhub'`;
  // `aws_securityhub_account` imports by AWS account id.
  byAccountId('aws_securityhub_account', 'securityhub', 'securityhub_account'),
  passthrough('aws_accessanalyzer_analyzer', 'access-analyzer', 'accessanalyzer_analyzer'),
  {
    type: 'aws_inspector2_enabler',
    kinds: ['inspector2'],
    fromScanned: inspector2EnablerId,
    doc: doc('inspector2_enabler'),
  },
  // `collect/security-posture.ts:119` stores the literal `'macie2'`;
  // `internal/service/macie2/account.go` sets the resource id to the account id.
  byAccountId('aws_macie2_account', 'macie2', 'macie2_account'),

  // ---- storage ------------------------------------------------------------
  passthrough('aws_s3_bucket', 's3', 's3_bucket'),

  // ---- IAM ----------------------------------------------------------------
  // Roles, users, groups and instance profiles import by NAME…
  passthrough('aws_iam_role', 'iam-role', 'iam_role'),
  passthrough('aws_iam_user', 'iam-user', 'iam_user'),
  passthrough('aws_iam_group', 'iam-group', 'iam_group'),
  passthrough('aws_iam_instance_profile', 'iam-instance-profile', 'iam_instance_profile'),
  // …but policies import by ARN, and `collect/iam.ts:173` stores `PolicyName`
  // as `id`. Same shape as the two federation providers below.
  byArn('aws_iam_policy', 'iam-policy', 'iam_policy'),
  byArn('aws_iam_saml_provider', 'saml-provider', 'iam_saml_provider'),
  // TRAP, running backwards: `collect/iam.ts:234` stores the extracted provider
  // NAME as `id`, while `aws_iam_openid_connect_provider` imports by ARN.
  byArn('aws_iam_openid_connect_provider', 'oidc-provider', 'iam_openid_connect_provider'),

  // ---- IAM Identity Center ------------------------------------------------
  // TRAP: a comma-joined composite, not the permission-set ARN alone.
  {
    type: 'aws_ssoadmin_permission_set',
    kinds: ['sso-permission-set'],
    fromScanned: permissionSetId,
    doc: doc('ssoadmin_permission_set'),
  },
  byArn('aws_ssoadmin_application', 'sso-application', 'ssoadmin_application'),

  // ---- organizations ------------------------------------------------------
  passthrough('aws_organizations_organization', 'org', 'organizations_organization'),
  passthrough(
    'aws_organizations_organizational_unit',
    'org-ou',
    'organizations_organizational_unit',
  ),
  passthrough('aws_organizations_account', 'org-account', 'organizations_account'),
  passthrough('aws_organizations_policy', 'org-policy', 'organizations_policy'),
];

/**
 * Kinds in WP-C's half that are **deliberately** left to the `# VERIFY`
 * fallback. A silent omission and a deliberate one look identical in a diff,
 * so they are named here and asserted in `test/scanned-workload.test.ts`.
 *
 * The first two are a limitation of the seam, not of AWS: `ImportRule.type` is
 * a constant and `ruleForKind` returns one rule per kind, so a kind whose
 * terraform *type* depends on a collected field cannot be expressed. Guessing
 * one variant would emit a confidently wrong `type`, which is worse than the
 * fallback — the fallback comments the block out.
 */
export const NO_RULE_KINDS: Readonly<Record<string, string>> = {
  // FsxFileSystem.fileSystemType selects between aws_fsx_lustre_file_system,
  // _windows_, _ontap_ and _openzfs_file_system. All four import by the `fs-…`
  // id, so only the type is unknown — but the type is what a block needs most.
  fsx: 'terraform type depends on FsxFileSystem.fileSystemType (LUSTRE | WINDOWS | ONTAP | OPENZFS)',
  // DataSyncLocation.locationType selects between aws_datasync_location_s3,
  // _nfs, _smb, _efs, _fsx_windows_file_system and friends. All import by ARN.
  'datasync-location':
    'terraform type depends on DataSyncLocation.locationType (s3 | nfs | smb | efs | fsx…)',
  // The ECR registry is an account-level singleton with no managed resource of
  // its own — only aws_ecr_registry_policy / _scanning_configuration /
  // _replication_configuration, which are configuration, not the registry.
  'ecr-registry': 'no aws_ecr_registry resource exists; the registry is not a managed resource',
  // r/ssoadmin_instance.html.markdown is a 404 on `main`: Identity Center
  // instances are exposed as a data source only.
  'sso-instance': 'no aws_ssoadmin_instance resource exists; Identity Center instances are read-only',
};
