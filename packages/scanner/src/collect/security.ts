import {
  KMSClient,
  paginateListAliases,
  paginateListKeys,
  DescribeKeyCommand,
  GetKeyRotationStatusCommand,
} from '@aws-sdk/client-kms';
import {
  ACMClient,
  paginateListCertificates,
  DescribeCertificateCommand,
  ListTagsForCertificateCommand,
  KeyAlgorithm,
} from '@aws-sdk/client-acm';
import { SecretsManagerClient, paginateListSecrets } from '@aws-sdk/client-secrets-manager';
import pLimit from 'p-limit';
import type { RegionSnapshot, Tags } from '@atlas/schema';
import { AwsContext, guard } from '../aws.js';

function kvTags(list?: Array<{ Key?: string; Value?: string }>): Tags {
  const tags: Tags = {};
  for (const t of list ?? []) {
    if (t.Key) tags[t.Key] = t.Value ?? '';
  }
  return tags;
}

/**
 * Security services collector (regional): KMS keys, ACM certificates, and
 * Secrets Manager secret METADATA. Read-only List/Get/Describe calls only —
 * secret values are never fetched (no GetSecretValue).
 */
export async function collectSecurity(
  ctx: AwsContext,
  region: string,
  out: RegionSnapshot,
): Promise<void> {
  const errors = out.errors;
  const limit = pLimit(4);

  // --- KMS -----------------------------------------------------------------
  const kms = ctx.client(KMSClient, region);

  // Key id -> alias names (aliases are listed separately from keys).
  const aliasesByKey = new Map<string, string[]>();
  await guard(errors, 'kms', 'ListAliases', async () => {
    for await (const page of paginateListAliases({ client: kms }, {})) {
      for (const alias of page.Aliases ?? []) {
        if (!alias.AliasName || !alias.TargetKeyId) continue;
        const list = aliasesByKey.get(alias.TargetKeyId) ?? [];
        list.push(alias.AliasName);
        aliasesByKey.set(alias.TargetKeyId, list);
      }
    }
  });

  const keyIds: string[] = [];
  await guard(errors, 'kms', 'ListKeys', async () => {
    for await (const page of paginateListKeys({ client: kms }, {})) {
      for (const key of page.Keys ?? []) {
        if (key.KeyId) keyIds.push(key.KeyId);
      }
    }
  });

  await Promise.all(
    keyIds.map((keyId) =>
      limit(() =>
        guard(errors, 'kms', `DescribeKey(${keyId})`, async () => {
          const res = await kms.send(new DescribeKeyCommand({ KeyId: keyId }));
          const meta = res.KeyMetadata;

          // Rotation only applies to symmetric keys with KMS-generated material;
          // asking for any other kind is a guaranteed UnsupportedOperationException.
          // The dedicated guard treats remaining failures (AccessDenied…) as unknown.
          let rotationEnabled: boolean | undefined;
          if (meta?.KeySpec === 'SYMMETRIC_DEFAULT' && meta?.Origin === 'AWS_KMS') {
            await guard(errors, 'kms', `GetKeyRotationStatus(${keyId})`, async () => {
              const rot = await kms.send(new GetKeyRotationStatusCommand({ KeyId: keyId }));
              rotationEnabled = rot.KeyRotationEnabled;
            });
          }

          // Sorted locally so the display name (first alias) is deterministic.
          const aliases = [...(aliasesByKey.get(keyId) ?? [])].sort();
          out.kmsKeys.push({
            id: keyId,
            arn: meta?.Arn,
            name: aliases[0]?.replace(/^alias\//, '') ?? keyId,
            tags: {},
            aliases,
            description: meta?.Description,
            keyManager: meta?.KeyManager,
            keyState: meta?.KeyState,
            keyUsage: meta?.KeyUsage,
            keySpec: meta?.KeySpec,
            rotationEnabled,
            multiRegion: meta?.MultiRegion,
          });
        }),
      ),
    ),
  );

  // --- ACM -----------------------------------------------------------------
  const acm = ctx.client(ACMClient, region);

  const certArns: string[] = [];
  await guard(errors, 'acm', 'ListCertificates', async () => {
    // Without Includes, ListCertificates only returns RSA_1024/RSA_2048
    // certificates — ECDSA and larger RSA certs would silently vanish.
    const includes = { keyTypes: Object.values(KeyAlgorithm) };
    for await (const page of paginateListCertificates({ client: acm }, { Includes: includes })) {
      for (const cert of page.CertificateSummaryList ?? []) {
        if (cert.CertificateArn) certArns.push(cert.CertificateArn);
      }
    }
  });

  await Promise.all(
    certArns.map((certArn) =>
      limit(() =>
        guard(errors, 'acm', `DescribeCertificate(${certArn})`, async () => {
          const res = await acm.send(new DescribeCertificateCommand({ CertificateArn: certArn }));
          const cert = res.Certificate;

          let tags: Tags = {};
          await guard(errors, 'acm', `ListTagsForCertificate(${certArn})`, async () => {
            const tagRes = await acm.send(
              new ListTagsForCertificateCommand({ CertificateArn: certArn }),
            );
            tags = kvTags(tagRes.Tags);
          });

          out.acmCertificates.push({
            id: certArn,
            arn: certArn,
            name: cert?.DomainName,
            tags,
            domainName: cert?.DomainName,
            subjectAlternativeNames: cert?.SubjectAlternativeNames ?? [],
            status: cert?.Status,
            certType: cert?.Type,
            inUseBy: cert?.InUseBy ?? [],
            notAfter: cert?.NotAfter?.toISOString(),
            renewalEligibility: cert?.RenewalEligibility,
          });
        }),
      ),
    ),
  );

  // --- Secrets Manager (metadata only — the value is NEVER fetched) ---------
  const secretsManager = ctx.client(SecretsManagerClient, region);
  await guard(errors, 'secretsmanager', 'ListSecrets', async () => {
    for await (const page of paginateListSecrets({ client: secretsManager }, {})) {
      for (const secret of page.SecretList ?? []) {
        if (!secret.ARN) continue;
        out.secrets.push({
          id: secret.ARN,
          arn: secret.ARN,
          name: secret.Name,
          tags: kvTags(secret.Tags),
          description: secret.Description,
          rotationEnabled: secret.RotationEnabled,
          lastRotatedDate: secret.LastRotatedDate?.toISOString(),
          lastChangedDate: secret.LastChangedDate?.toISOString(),
          kmsKeyId: secret.KmsKeyId,
        });
      }
    }
  });
}
