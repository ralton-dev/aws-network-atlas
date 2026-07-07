// Glue — READ-ONLY (Get* only).
// Connections and dev endpoints are VPC-ATTACHED (subnet + security groups) —
// the ENIs Glue creates in the VPC are otherwise anonymous. Jobs carry the
// connection names that link them to those VPC-attached connections; crawlers
// and catalog databases round out the data-catalog inventory.
// Each resource type gets its own guard() block so a single permission gap
// doesn't lose the others.
import {
  GlueClient,
  paginateGetConnections,
  paginateGetCrawlers,
  paginateGetDatabases,
  paginateGetDevEndpoints,
  paginateGetJobs,
} from '@aws-sdk/client-glue';
import type { RegionSnapshot } from '@atlas/schema';
import { AwsContext, guard } from '../aws.js';

export async function collectGlue(
  ctx: AwsContext,
  region: string,
  out: RegionSnapshot,
): Promise<void> {
  const client = ctx.client(GlueClient, region);

  await guard(out.errors, 'glue', 'GetConnections', async () => {
    for await (const page of paginateGetConnections({ client }, {})) {
      for (const conn of page.ConnectionList ?? []) {
        const name = conn.Name;
        if (!name) continue;
        const phys = conn.PhysicalConnectionRequirements;
        out.glueConnections.push({
          id: name,
          name,
          // Tags need a separate GetTags per resource ARN — skipped.
          tags: {},
          connectionType: conn.ConnectionType,
          subnetId: phys?.SubnetId,
          securityGroupIds: phys?.SecurityGroupIdList ?? [],
          availabilityZone: phys?.AvailabilityZone,
        });
      }
    }
  });

  await guard(out.errors, 'glue', 'GetDevEndpoints', async () => {
    for await (const page of paginateGetDevEndpoints({ client }, {})) {
      for (const ep of page.DevEndpoints ?? []) {
        const name = ep.EndpointName;
        if (!name) continue;
        out.glueDevEndpoints.push({
          id: name,
          name,
          tags: {},
          status: ep.Status,
          vpcId: ep.VpcId,
          subnetId: ep.SubnetId,
          securityGroupIds: ep.SecurityGroupIds ?? [],
        });
      }
    }
  });

  await guard(out.errors, 'glue', 'GetJobs', async () => {
    for await (const page of paginateGetJobs({ client }, {})) {
      for (const job of page.Jobs ?? []) {
        const name = job.Name;
        if (!name) continue;
        out.glueJobs.push({
          id: name,
          name,
          tags: {},
          glueVersion: job.GlueVersion,
          workerType: job.WorkerType,
          connections: job.Connections?.Connections ?? [],
        });
      }
    }
  });

  await guard(out.errors, 'glue', 'GetCrawlers', async () => {
    for await (const page of paginateGetCrawlers({ client }, {})) {
      for (const crawler of page.Crawlers ?? []) {
        const name = crawler.Name;
        if (!name) continue;
        out.glueCrawlers.push({
          id: name,
          name,
          tags: {},
          state: crawler.State,
          databaseName: crawler.DatabaseName,
        });
      }
    }
  });

  await guard(out.errors, 'glue', 'GetDatabases', async () => {
    for await (const page of paginateGetDatabases({ client }, {})) {
      for (const db of page.DatabaseList ?? []) {
        const name = db.Name;
        if (!name) continue;
        // GetTables is deliberately NOT called — a per-database table
        // enumeration fans out badly on large catalogs and would stall the
        // scan; the database inventory is enough for the panel.
        out.glueDatabases.push({
          id: name,
          name,
          tags: {},
          description: db.Description,
          locationUri: db.LocationUri,
        });
      }
    }
  });
}
