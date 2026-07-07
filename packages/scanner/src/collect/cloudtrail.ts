// CloudTrail — READ-ONLY (Describe*/Get*/List* only).
// Audit-logging posture the sweeps can't see: each trail's scope
// (multi-region/organization), delivery (S3/CW Logs/SNS), protection
// (KMS, log-file validation), whether it is actually logging
// (GetTrailStatus) and what it covers (GetEventSelectors), plus the
// CloudTrail Lake event data stores. NOT in the Cloud Control sweep;
// regional, not VPC-attached.
import {
  CloudTrailClient,
  DescribeTrailsCommand,
  GetEventDataStoreCommand,
  GetEventSelectorsCommand,
  GetTrailStatusCommand,
  paginateListEventDataStores,
  type AdvancedEventSelector,
} from '@aws-sdk/client-cloudtrail';
import type { RegionSnapshot } from '@atlas/schema';
import { AwsContext, guard } from '../aws.js';

/** True when an advanced event selector targets data events (a data resource field). */
function advancedSelectorHasDataEvents(selectors: AdvancedEventSelector[]): boolean {
  return selectors.some((sel) =>
    (sel.FieldSelectors ?? []).some(
      (fs) =>
        fs.Field?.startsWith('resources.') ||
        (fs.Field === 'eventCategory' && (fs.Equals ?? []).includes('Data')),
    ),
  );
}

export async function collectCloudTrail(
  ctx: AwsContext,
  region: string,
  out: RegionSnapshot,
): Promise<void> {
  const client = ctx.client(CloudTrailClient, region);

  // Trails + per-trail status and event selectors.
  await guard(out.errors, 'cloudtrail', 'DescribeTrails', async () => {
    // includeShadowTrails: false — otherwise every region echoes the
    // multi-region trails homed elsewhere and they show up duplicated.
    const described = await client.send(
      new DescribeTrailsCommand({ includeShadowTrails: false }),
    );
    for (const trail of described.trailList ?? []) {
      if (!trail.Name) continue;

      // Status — a failure here must not lose the trail.
      let isLogging: boolean | undefined;
      try {
        const status = await client.send(
          new GetTrailStatusCommand({ Name: trail.TrailARN ?? trail.Name }),
        );
        isLogging = status.IsLogging;
      } catch {
        // keep the trail without status
      }

      // Event selectors — classic and advanced forms.
      let includeManagementEvents: boolean | undefined;
      let hasDataEvents: boolean | undefined;
      try {
        const selectors = await client.send(
          new GetEventSelectorsCommand({ TrailName: trail.TrailARN ?? trail.Name }),
        );
        const classic = selectors.EventSelectors ?? [];
        const advanced = selectors.AdvancedEventSelectors ?? [];
        includeManagementEvents =
          classic.some((s) => s.IncludeManagementEvents === true) || advanced.length > 0;
        hasDataEvents =
          classic.some((s) => (s.DataResources ?? []).length > 0) ||
          advancedSelectorHasDataEvents(advanced);
      } catch {
        // keep the trail without selector detail
      }

      out.cloudTrailTrails.push({
        id: trail.Name,
        arn: trail.TrailARN,
        name: trail.Name,
        // Tags need a separate ListTags per trail (home region only) — skipped.
        tags: {},
        homeRegion: trail.HomeRegion,
        isMultiRegionTrail: trail.IsMultiRegionTrail,
        isOrganizationTrail: trail.IsOrganizationTrail,
        s3BucketName: trail.S3BucketName,
        kmsKeyId: trail.KmsKeyId,
        logFileValidationEnabled: trail.LogFileValidationEnabled,
        cloudWatchLogsLogGroupArn: trail.CloudWatchLogsLogGroupArn,
        snsTopicArn: trail.SnsTopicARN,
        isLogging,
        includeManagementEvents,
        hasDataEvents,
      });
    }
  });

  // CloudTrail Lake event data stores — paginated.
  await guard(out.errors, 'cloudtrail', 'ListEventDataStores', async () => {
    for await (const page of paginateListEventDataStores({ client }, {})) {
      for (const store of page.EventDataStores ?? []) {
        const arn = store.EventDataStoreArn;
        if (!arn && !store.Name) continue;

        // The list entry may already carry these; GetEventDataStore fills the
        // rest (status/retention are usually detail-only) — best-effort.
        let status: string | undefined = store.Status;
        let multiRegionEnabled = store.MultiRegionEnabled;
        let organizationEnabled = store.OrganizationEnabled;
        let retentionPeriod = store.RetentionPeriod;
        if (arn) {
          try {
            const detail = await client.send(
              new GetEventDataStoreCommand({ EventDataStore: arn }),
            );
            status = detail.Status ?? status;
            multiRegionEnabled = detail.MultiRegionEnabled ?? multiRegionEnabled;
            organizationEnabled = detail.OrganizationEnabled ?? organizationEnabled;
            retentionPeriod = detail.RetentionPeriod ?? retentionPeriod;
          } catch {
            // keep the store with whatever the list entry carried
          }
        }

        out.cloudTrailEventDataStores.push({
          id: store.Name ?? arn!,
          arn,
          name: store.Name,
          tags: {},
          status,
          multiRegionEnabled,
          organizationEnabled,
          retentionPeriod,
        });
      }
    }
  });
}
