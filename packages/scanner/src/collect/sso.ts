// IAM Identity Center (SSO) collector (account-global) — READ-ONLY.
import {
  SSOAdminClient,
  DescribePermissionSetCommand,
  GetInlinePolicyForPermissionSetCommand,
  paginateListAccountAssignments,
  paginateListAccountsForProvisionedPermissionSet,
  paginateListApplications,
  paginateListCustomerManagedPolicyReferencesInPermissionSet,
  paginateListInstances,
  paginateListManagedPoliciesInPermissionSet,
  paginateListPermissionSets,
} from '@aws-sdk/client-sso-admin';
import pLimit from 'p-limit';
import type { AccountSnapshot, SsoInstance, SsoPermissionSet } from '@atlas/schema';
import { AwsContext, guard } from '../aws.js';

/** SSO Admin is a management-plane API with low TPS quotas; keep fan-out modest. */
const SSO_CONCURRENCY = 4;

/** Cap on permission sets enriched per instance; past it a ScanError records the truncation. */
const MAX_PERMISSION_SETS = 200;

/**
 * Per-permission-set cap on recorded (account, principal) assignments. The
 * assignment walk is a per-account ListAccountAssignments call, so this also
 * bounds the API fan-out for sets provisioned to very many accounts.
 */
const MAX_ASSIGNMENTS = 500;

/** Cap on Identity Center applications recorded per instance. */
const MAX_APPLICATIONS = 300;

/**
 * Collect IAM Identity Center (successor to AWS SSO): the instance, its
 * permission sets (policies + account assignments), and its applications.
 * Account-global — collected once per account, against the profile's home
 * region.
 *
 * Only the org management account or the Identity Center delegated
 * administrator can see any of this, and ListInstances is REGION-SCOPED: an
 * Identity Center instance lives in exactly one region, so it is only found
 * when that region is the profile's home region. When ListInstances returns
 * nothing (not enabled, wrong region) or is denied (the guard records it),
 * the collector yields nothing.
 */
export async function collectSso(ctx: AwsContext, out: AccountSnapshot['global']): Promise<void> {
  const errors = out.errors;
  const sso = ctx.client(SSOAdminClient, ctx.homeRegion);
  const limit = pLimit(SSO_CONCURRENCY);

  // 1. ListInstances doubles as the visibility probe: no instances means
  //    Identity Center isn't enabled/reachable here — nothing else to do.
  const instances: SsoInstance[] = [];
  await guard(errors, 'sso', 'ListInstances', async () => {
    for await (const page of paginateListInstances({ client: sso }, {})) {
      for (const i of page.Instances ?? []) {
        if (!i.InstanceArn) continue;
        instances.push({
          id: i.InstanceArn,
          arn: i.InstanceArn,
          name: i.Name,
          identityStoreId: i.IdentityStoreId,
          ownerAccountId: i.OwnerAccountId,
          status: i.Status,
          createdDate: i.CreatedDate?.toISOString(),
        });
      }
    }
  });
  if (instances.length === 0) return;
  out.ssoInstances.push(...instances);

  for (const instance of instances) {
    // 2. Permission sets: enumerate ARNs, then enrich each one (description,
    //    session duration, attached policies, inline policy, assignments).
    await guard(errors, 'sso', `ListPermissionSets(${instance.id})`, async () => {
      const psArns: string[] = [];
      let truncated = false;
      paging: for await (const page of paginateListPermissionSets(
        { client: sso },
        { InstanceArn: instance.id },
      )) {
        for (const arn of page.PermissionSets ?? []) {
          if (psArns.length >= MAX_PERMISSION_SETS) {
            truncated = true;
            break paging;
          }
          psArns.push(arn);
        }
      }
      if (truncated) {
        errors.push({
          service: 'sso',
          operation: `ListPermissionSets(${instance.id})`,
          message: `Instance has more than ${MAX_PERMISSION_SETS} permission sets; the list was truncated.`,
        });
      }

      const sets: SsoPermissionSet[] = [];
      await Promise.all(
        psArns.map((psArn) =>
          limit(async () => {
            const set: SsoPermissionSet = {
              id: psArn,
              arn: psArn,
              // Placeholder until DescribePermissionSet fills the real name.
              name: psArn.split('/').pop() ?? psArn,
              instanceArn: instance.id,
              managedPolicyArns: [],
              customerManagedPolicies: [],
              assignments: [],
            };
            await guard(errors, 'sso', `DescribePermissionSet(${psArn})`, async () => {
              const res = await sso.send(
                new DescribePermissionSetCommand({ InstanceArn: instance.id, PermissionSetArn: psArn }),
              );
              const ps = res.PermissionSet;
              if (!ps) return;
              set.name = ps.Name ?? set.name;
              set.description = ps.Description || undefined;
              set.sessionDuration = ps.SessionDuration;
              set.relayState = ps.RelayState;
              set.createdDate = ps.CreatedDate?.toISOString();
            });
            await guard(errors, 'sso', `ListManagedPoliciesInPermissionSet(${psArn})`, async () => {
              for await (const page of paginateListManagedPoliciesInPermissionSet(
                { client: sso },
                { InstanceArn: instance.id, PermissionSetArn: psArn },
              )) {
                for (const p of page.AttachedManagedPolicies ?? []) {
                  if (p.Arn) set.managedPolicyArns.push(p.Arn);
                }
              }
            });
            await guard(
              errors,
              'sso',
              `ListCustomerManagedPolicyReferencesInPermissionSet(${psArn})`,
              async () => {
                for await (const page of paginateListCustomerManagedPolicyReferencesInPermissionSet(
                  { client: sso },
                  { InstanceArn: instance.id, PermissionSetArn: psArn },
                )) {
                  for (const p of page.CustomerManagedPolicyReferences ?? []) {
                    if (p.Name) set.customerManagedPolicies.push({ name: p.Name, path: p.Path });
                  }
                }
              },
            );
            await guard(errors, 'sso', `GetInlinePolicyForPermissionSet(${psArn})`, async () => {
              const res = await sso.send(
                new GetInlinePolicyForPermissionSetCommand({
                  InstanceArn: instance.id,
                  PermissionSetArn: psArn,
                }),
              );
              // The API returns an empty string when no inline policy exists.
              set.inlinePolicy = res.InlinePolicy || undefined;
            });
            // Assignments: which accounts the set is provisioned to, then the
            // (principal, account) grants in each. Capped — both the recorded
            // list and the per-account call fan-out.
            await guard(errors, 'sso', `ListAccountsForProvisionedPermissionSet(${psArn})`, async () => {
              const accountIds: string[] = [];
              for await (const page of paginateListAccountsForProvisionedPermissionSet(
                { client: sso },
                { InstanceArn: instance.id, PermissionSetArn: psArn },
              )) {
                accountIds.push(...(page.AccountIds ?? []));
              }
              let assignmentsTruncated = false;
              for (const accountId of accountIds) {
                if (set.assignments.length >= MAX_ASSIGNMENTS) {
                  assignmentsTruncated = true;
                  break;
                }
                // Per-account guard: one denied account shouldn't kill the walk.
                await guard(errors, 'sso', `ListAccountAssignments(${psArn}, ${accountId})`, async () => {
                  paging: for await (const page of paginateListAccountAssignments(
                    { client: sso },
                    { InstanceArn: instance.id, AccountId: accountId, PermissionSetArn: psArn },
                  )) {
                    for (const a of page.AccountAssignments ?? []) {
                      if (!a.AccountId) continue;
                      if (set.assignments.length >= MAX_ASSIGNMENTS) {
                        assignmentsTruncated = true;
                        break paging;
                      }
                      set.assignments.push({
                        accountId: a.AccountId,
                        principalType: a.PrincipalType,
                        principalId: a.PrincipalId,
                      });
                    }
                  }
                });
              }
              if (assignmentsTruncated) {
                errors.push({
                  service: 'sso',
                  operation: `ListAccountAssignments(${psArn})`,
                  message: `Permission set has more than ${MAX_ASSIGNMENTS} account assignments; assignments[] was truncated.`,
                });
              }
            });
            sets.push(set);
          }),
        ),
      );
      out.ssoPermissionSets.push(...sets);
    });

    // 3. Applications (access-portal SAML/OAuth apps). Guarded separately —
    //    the API is newer than permission sets and may be unsupported/denied.
    await guard(errors, 'sso', `ListApplications(${instance.id})`, async () => {
      let truncated = false;
      paging: for await (const page of paginateListApplications(
        { client: sso },
        { InstanceArn: instance.id },
      )) {
        for (const app of page.Applications ?? []) {
          if (!app.ApplicationArn) continue;
          if (out.ssoApplications.length >= MAX_APPLICATIONS) {
            truncated = true;
            break paging;
          }
          out.ssoApplications.push({
            id: app.ApplicationArn,
            arn: app.ApplicationArn,
            name: app.Name,
            instanceArn: app.InstanceArn ?? instance.id,
            applicationProviderArn: app.ApplicationProviderArn,
            status: app.Status,
            description: app.Description || undefined,
            portalVisibility: app.PortalOptions?.Visibility,
            portalSignInOrigin: app.PortalOptions?.SignInOptions?.Origin,
            createdDate: app.CreatedDate?.toISOString(),
          });
        }
      }
      if (truncated) {
        errors.push({
          service: 'sso',
          operation: `ListApplications(${instance.id})`,
          message: `Instance has more than ${MAX_APPLICATIONS} applications; the list was truncated.`,
        });
      }
    });
  }
}
