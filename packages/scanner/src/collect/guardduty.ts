// GuardDuty — READ-ONLY (List*/Get* only).
// Threat-detection posture the sweeps can't see: whether the region's
// detector (usually 0-or-1 per region) is enabled, which protection features
// are on (S3/EKS/RDS/runtime/malware…), how often findings publish, and
// whether a publishing destination (S3) is configured. NOT in the Cloud
// Control sweep; regional, not VPC-attached.
import {
  GuardDutyClient,
  GetDetectorCommand,
  ListPublishingDestinationsCommand,
  paginateListDetectors,
} from '@aws-sdk/client-guardduty';
import type { RegionSnapshot } from '@atlas/schema';
import { AwsContext, guard } from '../aws.js';

export async function collectGuardDuty(
  ctx: AwsContext,
  region: string,
  out: RegionSnapshot,
): Promise<void> {
  const client = ctx.client(GuardDutyClient, region);

  // Detectors + per-detector configuration and publishing destination.
  await guard(out.errors, 'guardduty', 'ListDetectors', async () => {
    for await (const page of paginateListDetectors({ client }, {})) {
      for (const detectorId of page.DetectorIds ?? []) {
        // Detail — a failure here must not lose the detector.
        let status: string | undefined;
        let findingPublishingFrequency: string | undefined;
        let features: Array<{ name?: string; status?: string }> = [];
        try {
          const detail = await client.send(new GetDetectorCommand({ DetectorId: detectorId }));
          status = detail.Status;
          findingPublishingFrequency = detail.FindingPublishingFrequency;
          features = (detail.Features ?? []).map((f) => ({ name: f.Name, status: f.Status }));
        } catch {
          // keep the detector without detail
        }

        // Publishing destination (S3) — best-effort.
        let publishingDestinationType: string | undefined;
        try {
          const destinations = await client.send(
            new ListPublishingDestinationsCommand({ DetectorId: detectorId }),
          );
          publishingDestinationType = destinations.Destinations?.[0]?.DestinationType;
        } catch {
          // keep the detector without destination detail
        }

        out.guardDutyDetectors.push({
          id: detectorId,
          // No ARN readily available without the account id — leave undefined.
          name: detectorId,
          // Tags need a separate TagResource-style ARN lookup — skipped.
          tags: {},
          status,
          findingPublishingFrequency,
          features,
          publishingDestinationType,
        });
      }
    }
  });
}
