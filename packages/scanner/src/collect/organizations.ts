import {
  OrganizationsClient,
  DescribeOrganizationCommand,
  DescribePolicyCommand,
  DescribeResourcePolicyCommand,
  ListParentsCommand,
  paginateListAccounts,
  paginateListAWSServiceAccessForOrganization,
  paginateListDelegatedAdministrators,
  paginateListDelegatedServicesForAccount,
  paginateListOrganizationalUnitsForParent,
  paginateListPolicies,
  paginateListRoots,
  paginateListTagsForResource,
  paginateListTargetsForPolicy,
} from '@aws-sdk/client-organizations';
import pLimit from 'p-limit';
import type {
  AccountSnapshot,
  Organization,
  OrganizationPolicy,
  OrganizationPolicyKind,
  Tags,
} from '@atlas/schema';
import { AwsContext, guard } from '../aws.js';

/** Organizations throttles hard (management-plane API); keep fan-out modest. */
const ORG_CONCURRENCY = 4;

/** Cap on OUs walked in the tree; past it a ScanError records the truncation. */
const MAX_OUS = 2000;

/**
 * Above this many member accounts, the per-account ListParents lookup is
 * skipped (one call per account adds up fast) and parentId stays undefined,
 * with a ScanError noting why.
 */
const MAX_ACCOUNT_PARENT_LOOKUPS = 500;

/** Per-policy cap on recorded attachment targets. */
const MAX_POLICY_TARGETS = 500;

/**
 * Cap on ListTagsForResource fan-out across OUs + accounts + policies. Past
 * it tags stay {} everywhere and a ScanError records the truncation.
 */
const MAX_TAG_LOOKUPS = 1500;

/** Every ListPolicies filter the scanner enumerates. */
const POLICY_TYPES: OrganizationPolicyKind[] = [
  'SERVICE_CONTROL_POLICY',
  'RESOURCE_CONTROL_POLICY',
  'TAG_POLICY',
  'BACKUP_POLICY',
  'AISERVICES_OPT_OUT_POLICY',
  'DECLARATIVE_POLICY_EC2',
  'CHATBOT_POLICY',
];

/**
 * AWS Organizations governance, collected once per account: the organization,
 * roots + trusted services + delegated admins, the OU tree, member accounts,
 * and policies (SCPs/RCPs/tag/backup/…) with their attachment targets.
 *
 * Only the management account (or a delegated administrator) can see any of
 * this. Everywhere else DescribeOrganization throws
 * AWSOrganizationsNotInUseException or AccessDenied — the guard records it as
 * a ScanError and the collector returns with nothing collected.
 */
export async function collectOrganizations(
  ctx: AwsContext,
  out: AccountSnapshot['global'],
): Promise<void> {
  const errors = out.errors;
  // Organizations is a global service; its standard-partition endpoint lives
  // in us-east-1 regardless of the profile's home region.
  const org = ctx.client(OrganizationsClient, 'us-east-1');
  const limit = pLimit(ORG_CONCURRENCY);

  // 1. DescribeOrganization doubles as the visibility probe: if it fails,
  //    nothing else can succeed, so bail out (the guard recorded the error).
  let organization: Organization | undefined;
  await guard(errors, 'organizations', 'DescribeOrganization', async () => {
    const res = await org.send(new DescribeOrganizationCommand({}));
    const o = res.Organization;
    if (!o?.Id) return;
    organization = {
      id: o.Id,
      arn: o.Arn,
      featureSet: o.FeatureSet,
      masterAccountId: o.MasterAccountId,
      masterAccountEmail: o.MasterAccountEmail,
      masterAccountArn: o.MasterAccountArn,
      availablePolicyTypes: (o.AvailablePolicyTypes ?? [])
        .filter((t) => t.Type)
        .map((t) => ({ type: t.Type!, status: t.Status })),
      roots: [],
      trustedServices: [],
      delegatedAdministrators: [],
    };
  });
  if (!organization) return;
  const orgOut = organization;
  out.organizations.push(orgOut);

  // 2. Roots (normally exactly one) with per-root policy-type enablement.
  await guard(errors, 'organizations', 'ListRoots', async () => {
    for await (const page of paginateListRoots({ client: org }, {})) {
      for (const r of page.Roots ?? []) {
        if (!r.Id) continue;
        orgOut.roots.push({
          id: r.Id,
          arn: r.Arn,
          name: r.Name,
          policyTypes: (r.PolicyTypes ?? [])
            .filter((t) => t.Type)
            .map((t) => ({ type: t.Type!, status: t.Status })),
        });
      }
    }
  });

  // 3. Service principals with trusted access (org-integrated services).
  await guard(errors, 'organizations', 'ListAWSServiceAccessForOrganization', async () => {
    for await (const page of paginateListAWSServiceAccessForOrganization({ client: org }, {})) {
      for (const s of page.EnabledServicePrincipals ?? []) {
        if (s.ServicePrincipal) orgOut.trustedServices.push(s.ServicePrincipal);
      }
    }
  });

  // 4. Delegated administrators, each enriched with the services delegated.
  await guard(errors, 'organizations', 'ListDelegatedAdministrators', async () => {
    for await (const page of paginateListDelegatedAdministrators({ client: org }, {})) {
      for (const a of page.DelegatedAdministrators ?? []) {
        if (!a.Id) continue;
        orgOut.delegatedAdministrators.push({
          id: a.Id,
          arn: a.Arn,
          email: a.Email,
          name: a.Name,
          status: a.Status,
        });
      }
    }
    await Promise.all(
      orgOut.delegatedAdministrators.map((admin) =>
        limit(() =>
          guard(errors, 'organizations', `ListDelegatedServicesForAccount(${admin.id})`, async () => {
            const services: string[] = [];
            for await (const page of paginateListDelegatedServicesForAccount(
              { client: org },
              { AccountId: admin.id },
            )) {
              for (const s of page.DelegatedServices ?? []) {
                if (s.ServicePrincipal) services.push(s.ServicePrincipal);
              }
            }
            admin.services = services;
          }),
        ),
      ),
    );
  });

  // 5. Organization resource policy. Throws when none exists — that's normal,
  //    not an error worth recording.
  await guard(errors, 'organizations', 'DescribeResourcePolicy', async () => {
    try {
      const res = await org.send(new DescribeResourcePolicyCommand({}));
      orgOut.resourcePolicy = res.ResourcePolicy?.Content;
    } catch (err) {
      if (err instanceof Error && err.name === 'ResourcePolicyNotFoundException') return;
      throw err;
    }
  });

  // 6. OU tree: breadth-first from each root, recording parentId so the tree
  //    can be rebuilt. Capped — a pathological org shouldn't bloat snapshots.
  await guard(errors, 'organizations', 'ListOrganizationalUnits', async () => {
    let truncated = false;
    const queue: string[] = orgOut.roots.map((r) => r.id);
    while (queue.length > 0 && !truncated) {
      const parentId = queue.shift()!;
      // Per-parent guard: one denied/failed subtree shouldn't kill the walk.
      await guard(errors, 'organizations', `ListOrganizationalUnitsForParent(${parentId})`, async () => {
        for await (const page of paginateListOrganizationalUnitsForParent(
          { client: org },
          { ParentId: parentId },
        )) {
          for (const ou of page.OrganizationalUnits ?? []) {
            if (!ou.Id) continue;
            if (out.organizationalUnits.length >= MAX_OUS) {
              truncated = true;
              return;
            }
            out.organizationalUnits.push({ id: ou.Id, arn: ou.Arn, name: ou.Name, tags: {}, parentId });
            queue.push(ou.Id);
          }
        }
      });
    }
    if (truncated) {
      errors.push({
        service: 'organizations',
        operation: 'ListOrganizationalUnitsForParent',
        message: `Organization has more than ${MAX_OUS} organizational units; the OU tree was truncated.`,
      });
    }
  });

  // 7. Member accounts (org membership records — distinct from the scanned
  //    AccountSnapshot). parentId is a per-account lookup, so it is best-effort
  //    and skipped wholesale in very large orgs.
  await guard(errors, 'organizations', 'ListAccounts', async () => {
    const firstIndex = out.organizationAccounts.length;
    for await (const page of paginateListAccounts({ client: org }, {})) {
      for (const a of page.Accounts ?? []) {
        if (!a.Id) continue;
        out.organizationAccounts.push({
          id: a.Id,
          arn: a.Arn,
          name: a.Name,
          tags: {},
          email: a.Email,
          status: a.Status,
          joinedMethod: a.JoinedMethod,
          joinedTimestamp: a.JoinedTimestamp?.toISOString(),
        });
      }
    }
    const accounts = out.organizationAccounts.slice(firstIndex);
    if (accounts.length > MAX_ACCOUNT_PARENT_LOOKUPS) {
      errors.push({
        service: 'organizations',
        operation: 'ListParents',
        message:
          `Organization has ${accounts.length} accounts (cap ${MAX_ACCOUNT_PARENT_LOOKUPS} for ` +
          `per-account parent lookups); organizationAccounts[].parentId was left unset.`,
      });
      return;
    }
    await Promise.all(
      accounts.map((acct) =>
        limit(() =>
          guard(errors, 'organizations', `ListParents(${acct.id})`, async () => {
            // An account has exactly one parent, so no pagination needed.
            const res = await org.send(new ListParentsCommand({ ChildId: acct.id }));
            acct.parentId = res.Parents?.[0]?.Id;
          }),
        ),
      ),
    );
  });

  // 8. Policies of every type, with content + attachment targets. A type that
  //    is not enabled (or is denied) fails only its own guard; the rest run.
  await Promise.all(
    POLICY_TYPES.map((type) =>
      guard(errors, 'organizations', `ListPolicies(${type})`, async () => {
        const policies: OrganizationPolicy[] = [];
        for await (const page of paginateListPolicies({ client: org }, { Filter: type })) {
          for (const p of page.Policies ?? []) {
            if (!p.Id) continue;
            policies.push({
              id: p.Id,
              arn: p.Arn,
              name: p.Name ?? p.Id,
              tags: {},
              type,
              description: p.Description || undefined,
              awsManaged: p.AwsManaged,
              targets: [],
            });
          }
        }
        await Promise.all(
          policies.map((policy) =>
            limit(async () => {
              await guard(errors, 'organizations', `DescribePolicy(${policy.id})`, async () => {
                const res = await org.send(new DescribePolicyCommand({ PolicyId: policy.id }));
                policy.content = res.Policy?.Content;
              });
              await guard(errors, 'organizations', `ListTargetsForPolicy(${policy.id})`, async () => {
                let truncated = false;
                paging: for await (const page of paginateListTargetsForPolicy(
                  { client: org },
                  { PolicyId: policy.id },
                )) {
                  for (const t of page.Targets ?? []) {
                    if (!t.TargetId) continue;
                    if (policy.targets.length >= MAX_POLICY_TARGETS) {
                      truncated = true;
                      break paging;
                    }
                    policy.targets.push({ targetId: t.TargetId, type: t.Type, name: t.Name, arn: t.Arn });
                  }
                }
                if (truncated) {
                  errors.push({
                    service: 'organizations',
                    operation: `ListTargetsForPolicy(${policy.id})`,
                    message: `Policy has more than ${MAX_POLICY_TARGETS} attachment targets; targets[] was truncated.`,
                  });
                }
              });
            }),
          ),
        );
        out.organizationPolicies.push(...policies);
      }),
    ),
  );

  // 9. Tags for OUs / member accounts / customer-managed policies. Purely
  //    best-effort: over the cap (or on a denied call) tags simply stay {}.
  const taggable: Array<{ id: string; tags: Tags }> = [
    ...out.organizationalUnits,
    ...out.organizationAccounts,
    // AWS-managed policies (p-FullAWSAccess) cannot carry tags; skip them.
    ...out.organizationPolicies.filter((p) => !p.awsManaged),
  ];
  if (taggable.length > MAX_TAG_LOOKUPS) {
    errors.push({
      service: 'organizations',
      operation: 'ListTagsForResource',
      message:
        `Organization has ${taggable.length} OUs+accounts+policies (cap ${MAX_TAG_LOOKUPS} ` +
        `for tag lookups); org resource tags were not collected.`,
    });
  } else {
    await Promise.all(
      taggable.map((res) =>
        limit(async () => {
          try {
            for await (const page of paginateListTagsForResource({ client: org }, { ResourceId: res.id })) {
              for (const t of page.Tags ?? []) {
                if (t.Key !== undefined) res.tags[t.Key] = t.Value ?? '';
              }
            }
          } catch {
            /* best-effort: access denied leaves tags empty */
          }
        }),
      ),
    );
  }
}
