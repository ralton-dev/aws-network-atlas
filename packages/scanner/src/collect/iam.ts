// IAM collector (account-global) — READ-ONLY (Get*/List* only).
import {
  IAMClient,
  paginateGetAccountAuthorizationDetails,
  ListMFADevicesCommand,
  ListAccessKeysCommand,
  GetLoginProfileCommand,
  type RoleDetail,
  type UserDetail,
  type GroupDetail,
  type ManagedPolicyDetail,
} from '@aws-sdk/client-iam';
import pLimit from 'p-limit';
import type { AccountSnapshot } from '@atlas/schema';
import { AwsContext, guard } from '../aws.js';
import { toTags } from '../util.js';

type IamInstanceProfileOut = AccountSnapshot['global']['iamInstanceProfiles'][number];
type IamUserOut = AccountSnapshot['global']['iamUsers'][number];

/** IAM policy documents come back URL-encoded; fall back to raw on bad input. */
function decodePolicyDocument(doc: string | undefined): string | undefined {
  if (doc === undefined) return undefined;
  try {
    return decodeURIComponent(doc);
  } catch {
    return doc;
  }
}

/**
 * Collect IAM roles, users, groups, customer-managed policies, and instance
 * profiles (read-only) into the account-global container. IAM is global, so
 * this runs once per account.
 *
 * One paginated GetAccountAuthorizationDetails call returns roles, users,
 * groups, and local (customer-managed) policies with their attached + inline
 * policies and instance profiles — no N+1 for the core data. Per-user MFA /
 * access-key / console-access details are best-effort enrichment on top.
 */
export async function collectIam(ctx: AwsContext, out: AccountSnapshot['global']): Promise<void> {
  const errors = out.errors;
  const iam = ctx.client(IAMClient, ctx.homeRegion);

  const roleDetails: RoleDetail[] = [];
  const userDetails: UserDetail[] = [];
  const groupDetails: GroupDetail[] = [];
  const policyDetails: ManagedPolicyDetail[] = [];

  await guard(errors, 'iam', 'GetAccountAuthorizationDetails', async () => {
    // LocalManagedPolicy = customer-managed only; skips the thousands of
    // AWS-managed policies.
    for await (const page of paginateGetAccountAuthorizationDetails(
      { client: iam },
      { Filter: ['Role', 'User', 'Group', 'LocalManagedPolicy'] },
    )) {
      roleDetails.push(...(page.RoleDetailList ?? []));
      userDetails.push(...(page.UserDetailList ?? []));
      groupDetails.push(...(page.GroupDetailList ?? []));
      policyDetails.push(...(page.Policies ?? []));
    }
  });

  // Roles + the instance profiles embedded in them (unique by name).
  const instanceProfiles = new Map<string, IamInstanceProfileOut>();
  for (const r of roleDetails) {
    if (!r.RoleName) continue;
    out.iamRoles.push({
      id: r.RoleName,
      arn: r.Arn,
      name: r.RoleName,
      tags: toTags(r.Tags),
      path: r.Path,
      assumeRolePolicyDocument: decodePolicyDocument(r.AssumeRolePolicyDocument),
      attachedManagedPolicyArns: (r.AttachedManagedPolicies ?? [])
        .map((p) => p.PolicyArn)
        .filter((arn): arn is string => arn !== undefined),
      inlinePolicyNames: (r.RolePolicyList ?? [])
        .map((p) => p.PolicyName)
        .filter((n): n is string => n !== undefined),
      // RoleDetail carries neither Description nor MaxSessionDuration.
      description: undefined,
      maxSessionDuration: undefined,
      lastUsed: r.RoleLastUsed?.LastUsedDate?.toISOString(),
    });
    for (const ip of r.InstanceProfileList ?? []) {
      if (!ip.InstanceProfileName || instanceProfiles.has(ip.InstanceProfileName)) continue;
      instanceProfiles.set(ip.InstanceProfileName, {
        id: ip.InstanceProfileName,
        arn: ip.Arn,
        name: ip.InstanceProfileName,
        tags: toTags(ip.Tags),
        path: ip.Path,
        roleNames: (ip.Roles ?? [])
          .map((role) => role.RoleName)
          .filter((n): n is string => n !== undefined),
      });
    }
  }
  out.iamInstanceProfiles.push(...instanceProfiles.values());

  // Users (per-user enrichment fills mfa/keys/console fields afterwards).
  const users: IamUserOut[] = [];
  for (const u of userDetails) {
    if (!u.UserName) continue;
    const user: IamUserOut = {
      id: u.UserName,
      arn: u.Arn,
      name: u.UserName,
      tags: toTags(u.Tags),
      path: u.Path,
      groups: u.GroupList ?? [],
      attachedManagedPolicyArns: (u.AttachedManagedPolicies ?? [])
        .map((p) => p.PolicyArn)
        .filter((arn): arn is string => arn !== undefined),
      inlinePolicyNames: (u.UserPolicyList ?? [])
        .map((p) => p.PolicyName)
        .filter((n): n is string => n !== undefined),
      hasConsoleAccess: undefined,
      mfaDeviceCount: 0,
      accessKeyIds: [],
      passwordLastUsed: undefined,
    };
    users.push(user);
    out.iamUsers.push(user);
  }

  // Groups (membership is derived from the users' GroupList — the group
  // detail itself does not carry members).
  for (const g of groupDetails) {
    if (!g.GroupName) continue;
    out.iamGroups.push({
      id: g.GroupName,
      arn: g.Arn,
      name: g.GroupName,
      tags: {},
      path: g.Path,
      attachedManagedPolicyArns: (g.AttachedManagedPolicies ?? [])
        .map((p) => p.PolicyArn)
        .filter((arn): arn is string => arn !== undefined),
      inlinePolicyNames: (g.GroupPolicyList ?? [])
        .map((p) => p.PolicyName)
        .filter((n): n is string => n !== undefined),
      userNames: userDetails
        .filter((u) => u.UserName && (u.GroupList ?? []).includes(g.GroupName!))
        .map((u) => u.UserName!),
    });
  }

  // Customer-managed policies.
  for (const p of policyDetails) {
    if (!p.PolicyName) continue;
    const defaultVersion = (p.PolicyVersionList ?? []).find((v) => v.IsDefaultVersion === true);
    out.iamPolicies.push({
      id: p.PolicyName,
      arn: p.Arn,
      name: p.PolicyName,
      // ManagedPolicyDetail does not include Tags.
      tags: {},
      path: p.Path,
      attachmentCount: p.AttachmentCount,
      isAttachable: p.IsAttachable,
      defaultVersionDocument: decodePolicyDocument(defaultVersion?.Document),
      description: p.Description,
    });
  }

  // Best-effort per-user enrichment: MFA devices, access keys, console access.
  // Each call is guarded so partial permissions degrade gracefully.
  const limit = pLimit(4);
  await Promise.all(
    users.flatMap((user) => [
      limit(() =>
        guard(errors, 'iam', `ListMFADevices(${user.id})`, async () => {
          let marker: string | undefined;
          let count = 0;
          do {
            const res = await iam.send(
              new ListMFADevicesCommand({ UserName: user.id, Marker: marker }),
            );
            count += (res.MFADevices ?? []).length;
            marker = res.IsTruncated ? res.Marker : undefined;
          } while (marker);
          user.mfaDeviceCount = count;
        }),
      ),
      limit(() =>
        guard(errors, 'iam', `ListAccessKeys(${user.id})`, async () => {
          let marker: string | undefined;
          const keyIds: string[] = [];
          do {
            const res = await iam.send(
              new ListAccessKeysCommand({ UserName: user.id, Marker: marker }),
            );
            for (const k of res.AccessKeyMetadata ?? []) {
              if (k.AccessKeyId) keyIds.push(k.AccessKeyId);
            }
            marker = res.IsTruncated ? res.Marker : undefined;
          } while (marker);
          user.accessKeyIds = keyIds;
        }),
      ),
      limit(() =>
        guard(errors, 'iam', `GetLoginProfile(${user.id})`, async () => {
          try {
            await iam.send(new GetLoginProfileCommand({ UserName: user.id }));
            user.hasConsoleAccess = true;
          } catch (err) {
            // NoSuchEntity simply means "no console password" — not an error.
            if (err instanceof Error && err.name === 'NoSuchEntityException') {
              user.hasConsoleAccess = false;
            } else {
              throw err;
            }
          }
        }),
      ),
    ]),
  );
}
