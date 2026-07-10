// AWS RAM (Resource Access Manager) — READ-ONLY (Get* only).
// Collects the resource shares THIS account OWNS (resourceOwner=SELF): what
// the account exposes to other accounts / OUs / the whole organization —
// cross-account exposure is a top security signal for a multi-account estate.
// Shares RECEIVED from other accounts are deliberately not collected: the
// owning account's scan is the authoritative record of that exposure, and a
// received copy would draw the same edge twice.
import {
  RAMClient,
  paginateGetResourceShareAssociations,
  paginateGetResourceShares,
} from '@aws-sdk/client-ram';
import type { RamResourceShare, RegionSnapshot, Tags } from '@atlas/schema';
import { AwsContext, guard } from '../aws.js';
import { parseArn } from '../util.js';

/** Cap on resource shares recorded per region. */
const MAX_SHARES = 500;
/** Per-share caps on recorded principals / shared resources. */
const MAX_PRINCIPALS_PER_SHARE = 200;
const MAX_RESOURCES_PER_SHARE = 200;

/** RAM tag lists use lowercase key/value (unlike EC2's Key/Value). */
function toRamTags(tagList?: Array<{ key?: string; value?: string }>): Tags {
  const tags: Tags = {};
  for (const t of tagList ?? []) {
    if (t.key !== undefined) tags[t.key] = t.value ?? '';
  }
  return tags;
}

/**
 * Classify a RAM principal entity: a bare 12-digit account id, an
 * organization ARN, an OU ARN, or an IAM user/role ARN (folded to its
 * owning account — exposure granularity here is the account). Anything
 * unrecognized (e.g. a service principal) is dropped with the count noted
 * by the caller.
 */
function classifyPrincipal(
  entity: string,
): { id: string; type: 'account' | 'ou' | 'organization' } | undefined {
  if (/^\d{12}$/.test(entity)) return { id: entity, type: 'account' };
  if (/^arn:[^:]+:organizations::\d{12}:organization\//.test(entity)) {
    return { id: entity, type: 'organization' };
  }
  if (/^arn:[^:]+:organizations::\d{12}:ou\//.test(entity)) return { id: entity, type: 'ou' };
  const iamAccount = /^arn:[^:]+:iam::(\d{12}):/.exec(entity)?.[1];
  if (iamAccount) return { id: iamAccount, type: 'account' };
  return undefined;
}

/** Best-effort "service:resource" type from a shared resource's ARN. */
function resourceTypeFromArn(arn: string): string | undefined {
  const parsed = parseArn(arn);
  if (!parsed?.service) return undefined;
  return parsed.resourceType ? `${parsed.service}:${parsed.resourceType}` : parsed.service;
}

export async function collectRam(
  ctx: AwsContext,
  region: string,
  out: RegionSnapshot,
): Promise<void> {
  const client = ctx.client(RAMClient, region);

  // 1. The shares this account owns. Nothing owned → nothing else to ask.
  const shares = new Map<string, RamResourceShare>();
  await guard(out.errors, 'ram', 'GetResourceShares', async () => {
    let truncated = false;
    paging: for await (const page of paginateGetResourceShares(
      { client },
      { resourceOwner: 'SELF' },
    )) {
      for (const share of page.resourceShares ?? []) {
        const arn = share.resourceShareArn;
        if (!arn) continue;
        // DELETED shares linger in listings for a while; they expose nothing.
        if (share.status === 'DELETED') continue;
        if (shares.size >= MAX_SHARES) {
          truncated = true;
          break paging;
        }
        shares.set(arn, {
          id: arn,
          arn,
          name: share.name ?? arn.split('/').pop() ?? arn,
          tags: toRamTags(share.tags),
          status: share.status,
          owningAccountId: share.owningAccountId,
          allowExternalPrincipals: share.allowExternalPrincipals,
          principals: [],
          resources: [],
          creationTime: share.creationTime?.toISOString(),
        });
      }
    }
    if (truncated) {
      out.errors.push({
        service: 'ram',
        operation: 'GetResourceShares',
        message: `stopped after ${MAX_SHARES} resource shares; results for this region are incomplete`,
      });
    }
  });
  if (shares.size === 0) return;

  // 2. Who they are shared with. One paginated listing covers every share the
  //    account owns (associations carry their share's ARN); group by share.
  await guard(out.errors, 'ram', 'GetResourceShareAssociations(PRINCIPAL)', async () => {
    const overflowed = new Set<string>();
    for await (const page of paginateGetResourceShareAssociations(
      { client },
      { associationType: 'PRINCIPAL' },
    )) {
      for (const assoc of page.resourceShareAssociations ?? []) {
        const share = assoc.resourceShareArn ? shares.get(assoc.resourceShareArn) : undefined;
        if (!share || !assoc.associatedEntity) continue;
        // Tombstones and failures are not live exposure — skip them.
        if (assoc.status === 'DISASSOCIATED' || assoc.status === 'FAILED') continue;
        const principal = classifyPrincipal(assoc.associatedEntity);
        if (!principal) continue;
        if (share.principals.length >= MAX_PRINCIPALS_PER_SHARE) {
          overflowed.add(share.id);
          continue;
        }
        // IAM principals in the same account fold to duplicates — keep one.
        if (!share.principals.some((p) => p.id === principal.id && p.type === principal.type)) {
          share.principals.push(principal);
        }
      }
    }
    for (const shareArn of overflowed) {
      out.errors.push({
        service: 'ram',
        operation: 'GetResourceShareAssociations(PRINCIPAL)',
        message: `share ${shareArn} has more than ${MAX_PRINCIPALS_PER_SHARE} principals; principals[] was truncated`,
      });
    }
  });

  // 3. What they expose.
  await guard(out.errors, 'ram', 'GetResourceShareAssociations(RESOURCE)', async () => {
    const overflowed = new Set<string>();
    for await (const page of paginateGetResourceShareAssociations(
      { client },
      { associationType: 'RESOURCE' },
    )) {
      for (const assoc of page.resourceShareAssociations ?? []) {
        const share = assoc.resourceShareArn ? shares.get(assoc.resourceShareArn) : undefined;
        if (!share || !assoc.associatedEntity) continue;
        if (assoc.status === 'DISASSOCIATED') continue;
        if (share.resources.length >= MAX_RESOURCES_PER_SHARE) {
          overflowed.add(share.id);
          continue;
        }
        share.resources.push({
          arn: assoc.associatedEntity,
          type: resourceTypeFromArn(assoc.associatedEntity),
          status: assoc.status,
        });
      }
    }
    for (const shareArn of overflowed) {
      out.errors.push({
        service: 'ram',
        operation: 'GetResourceShareAssociations(RESOURCE)',
        message: `share ${shareArn} has more than ${MAX_RESOURCES_PER_SHARE} resources; resources[] was truncated`,
      });
    }
  });

  out.ramResourceShares.push(...shares.values());
}
