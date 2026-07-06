import type { SecurityGroup, SecurityGroupRule } from '@atlas/schema';

/**
 * Shared relationship helpers for the graph builders: security-group rule
 * formatting, world-exposure detection, IAM trust-policy parsing, and
 * CloudFront origin resolution.
 */

/** "tcp 443", "tcp 1024–2048", "udp 53", "all traffic". */
export function portLabel(rule: SecurityGroupRule): string {
  if (rule.protocol === '-1') return 'all traffic';
  const proto = rule.protocol;
  if (rule.fromPort === undefined) return proto;
  if (rule.toPort === undefined || rule.toPort === rule.fromPort) return `${proto} ${rule.fromPort}`;
  return `${proto} ${rule.fromPort}–${rule.toPort}`;
}

/** Ingress rules open to the whole internet (0.0.0.0/0 or ::/0). */
export function worldOpenIngress(sg: SecurityGroup): SecurityGroupRule[] {
  return sg.ingress.filter((r) => r.cidrs.includes('0.0.0.0/0') || r.ipv6Cidrs.includes('::/0'));
}

export interface TrustPrincipal {
  accountId: string;
  /** True when the trust statement requires MFA. */
  mfa: boolean;
}

/**
 * Extract the *other* AWS accounts allowed to assume a role from its trust
 * policy document (service principals are ignored — they're plumbing, not
 * cross-account access).
 */
export function trustedAccountPrincipals(
  doc: string | undefined,
  ownAccountId: string,
): TrustPrincipal[] {
  if (!doc) return [];
  let parsed: { Statement?: unknown };
  try {
    parsed = JSON.parse(doc) as { Statement?: unknown };
  } catch {
    return [];
  }
  const statements = Array.isArray(parsed.Statement)
    ? parsed.Statement
    : parsed.Statement !== undefined
      ? [parsed.Statement]
      : [];
  const out = new Map<string, TrustPrincipal>();
  for (const raw of statements) {
    const st = raw as {
      Effect?: string;
      Principal?: { AWS?: string | string[] };
      Condition?: unknown;
    };
    if (st.Effect !== 'Allow') continue;
    const aws = st.Principal?.AWS;
    const principals = Array.isArray(aws) ? aws : aws !== undefined ? [aws] : [];
    const mfa = JSON.stringify(st.Condition ?? {}).includes('MultiFactorAuthPresent');
    for (const p of principals) {
      const match = /^arn:aws[\w-]*:iam::(\d{12}):/.exec(p) ?? /^(\d{12})$/.exec(p);
      const accountId = match?.[1];
      if (!accountId || accountId === ownAccountId) continue;
      const existing = out.get(accountId);
      out.set(accountId, { accountId, mfa: (existing?.mfa ?? false) || mfa });
    }
  }
  return [...out.values()];
}

/** Bucket name from an S3-style CloudFront origin domain, else undefined. */
export function s3OriginBucket(origin: string): string | undefined {
  const idx = origin.indexOf('.s3');
  if (idx <= 0 || !origin.endsWith('.amazonaws.com')) return undefined;
  return origin.slice(0, idx);
}
