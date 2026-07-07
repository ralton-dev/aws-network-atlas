// AWS Backup — READ-ONLY (List*/Get* only).
// Recoverability posture the sweeps can't see: whether vaults actually hold
// recovery points, whether Vault Lock protects them from deletion, whether an
// access policy guards the vault, and what the backup plans do (schedule,
// lifecycle, cross-region/account copy, continuous backup) plus a best-effort
// summary of their selections. NOT in the Cloud Control sweep; regional, not
// VPC-attached.
import {
  BackupClient,
  GetBackupPlanCommand,
  GetBackupVaultAccessPolicyCommand,
  paginateListBackupPlans,
  paginateListBackupSelections,
  paginateListBackupVaults,
} from '@aws-sdk/client-backup';
import type { BackupPlan, RegionSnapshot } from '@atlas/schema';
import { AwsContext, guard } from '../aws.js';

export async function collectBackup(
  ctx: AwsContext,
  region: string,
  out: RegionSnapshot,
): Promise<void> {
  const client = ctx.client(BackupClient, region);

  // Vaults + vault-lock settings + access-policy presence.
  await guard(out.errors, 'backup', 'ListBackupVaults', async () => {
    for await (const page of paginateListBackupVaults({ client }, {})) {
      for (const vault of page.BackupVaultList ?? []) {
        if (!vault.BackupVaultName) continue;

        // Access policy — best-effort (throws ResourceNotFound when absent).
        let hasAccessPolicy: boolean | undefined;
        try {
          const policy = await client.send(
            new GetBackupVaultAccessPolicyCommand({ BackupVaultName: vault.BackupVaultName }),
          );
          hasAccessPolicy = !!policy.Policy;
        } catch {
          // keep the vault without access-policy detail
        }

        out.backupVaults.push({
          id: vault.BackupVaultName,
          arn: vault.BackupVaultArn,
          name: vault.BackupVaultName,
          // Tags need a separate ListTags call per ARN — skipped.
          tags: {},
          numberOfRecoveryPoints: vault.NumberOfRecoveryPoints,
          locked: !!(vault.LockDate || vault.MinRetentionDays || vault.MaxRetentionDays),
          minRetentionDays: vault.MinRetentionDays,
          maxRetentionDays: vault.MaxRetentionDays,
          hasAccessPolicy,
        });
      }
    }
  });

  // Plans + rules (GetBackupPlan) + best-effort selection summary.
  await guard(out.errors, 'backup', 'ListBackupPlans', async () => {
    for await (const page of paginateListBackupPlans({ client }, {})) {
      for (const plan of page.BackupPlansList ?? []) {
        if (!plan.BackupPlanId) continue;
        const name = plan.BackupPlanName ?? plan.BackupPlanId;

        // Rules — a detail failure must not lose the plan.
        let rules: BackupPlan['rules'] = [];
        try {
          const detail = await client.send(
            new GetBackupPlanCommand({ BackupPlanId: plan.BackupPlanId }),
          );
          rules = (detail.BackupPlan?.Rules ?? []).map((r) => ({
            name: r.RuleName,
            targetVault: r.TargetBackupVaultName,
            scheduleExpression: r.ScheduleExpression,
            moveToColdStorageAfterDays: r.Lifecycle?.MoveToColdStorageAfterDays,
            deleteAfterDays: r.Lifecycle?.DeleteAfterDays,
            copyToDestinations: (r.CopyActions ?? [])
              .map((c) => c.DestinationBackupVaultArn)
              .filter((arn): arn is string => !!arn),
            continuousBackup: r.EnableContinuousBackup,
          }));
        } catch {
          // keep the plan without rule detail
        }

        // Selection summary — cheap best-effort: ListBackupSelections gives
        // selection names only (per-selection resource lists would fan out).
        const selectionResourceTypes: string[] = [];
        try {
          for await (const sel of paginateListBackupSelections(
            { client },
            { BackupPlanId: plan.BackupPlanId },
          )) {
            for (const s of sel.BackupSelectionsList ?? []) {
              if (s.SelectionName) selectionResourceTypes.push(s.SelectionName);
            }
          }
        } catch {
          // keep the plan without selection detail
        }

        out.backupPlans.push({
          id: name,
          arn: plan.BackupPlanArn,
          name,
          tags: {},
          rules,
          selectionResourceTypes,
        });
      }
    }
  });
}
