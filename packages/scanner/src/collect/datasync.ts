// DataSync — READ-ONLY (List*/Describe* only).
// Agents using PrivateLink and EFS/FSx locations are VPC-ATTACHED (subnet +
// security groups) — the ENIs DataSync creates in the VPC are otherwise
// anonymous. Tasks wire source location → destination location, which is the
// transfer data flow.
// Each resource type gets its own guard() block so a single permission gap
// doesn't lose the others.
import {
  DataSyncClient,
  DescribeAgentCommand,
  DescribeLocationEfsCommand,
  DescribeLocationFsxLustreCommand,
  DescribeLocationFsxOntapCommand,
  DescribeLocationFsxOpenZfsCommand,
  DescribeLocationFsxWindowsCommand,
  DescribeTaskCommand,
  paginateListAgents,
  paginateListLocations,
  paginateListTasks,
} from '@aws-sdk/client-datasync';
import type { RegionSnapshot } from '@atlas/schema';
import { AwsContext, guard } from '../aws.js';

const lastSegment = (arn: string): string => arn.split('/').pop() ?? arn;

/** Map a LocationUri scheme to a stable locationType. */
function locationTypeFromUri(uri: string | undefined): string | undefined {
  const scheme = uri?.split('://')[0];
  if (!scheme) return undefined;
  switch (scheme) {
    case 'fsxw':
      return 'fsxWindows';
    case 'fsxl':
      return 'fsxLustre';
    case 'fsxn':
      return 'fsxOntap';
    case 'fsxz':
      return 'fsxOpenZfs';
    default:
      return scheme; // s3, efs, nfs, smb, hdfs, object-storage, azure-blob, …
  }
}

export async function collectDataSync(
  ctx: AwsContext,
  region: string,
  out: RegionSnapshot,
): Promise<void> {
  const client = ctx.client(DataSyncClient, region);

  await guard(out.errors, 'datasync', 'ListAgents', async () => {
    for await (const page of paginateListAgents({ client }, {})) {
      for (const entry of page.Agents ?? []) {
        const arn = entry.AgentArn;
        if (!arn) continue;
        const agent = await client.send(new DescribeAgentCommand({ AgentArn: arn }));
        const plc = agent.PrivateLinkConfig;
        out.dataSyncAgents.push({
          id: lastSegment(arn),
          arn,
          name: agent.Name ?? entry.Name,
          // Tags need a separate ListTagsForResource per ARN — skipped.
          tags: {},
          status: agent.Status,
          endpointType: agent.EndpointType,
          vpcEndpointId: plc?.VpcEndpointId,
          subnetArns: (plc?.SubnetArns ?? []).filter((s): s is string => !!s),
          securityGroupArns: (plc?.SecurityGroupArns ?? []).filter((s): s is string => !!s),
        });
      }
    }
  });

  await guard(out.errors, 'datasync', 'ListLocations', async () => {
    for await (const page of paginateListLocations({ client }, {})) {
      for (const entry of page.Locations ?? []) {
        const arn = entry.LocationArn;
        if (!arn) continue;
        const locationType = locationTypeFromUri(entry.LocationUri);
        let subnetArn: string | undefined;
        let securityGroupArns: string[] = [];
        // Only the VPC-attached location kinds warrant a detail call (bounded
        // fan-out); s3/nfs/smb/object-storage/… carry no VPC attachment, so
        // the list entry alone is enough. Each detail call gets its own
        // try/catch so one odd location doesn't lose the rest.
        try {
          if (locationType === 'efs') {
            const d = await client.send(new DescribeLocationEfsCommand({ LocationArn: arn }));
            subnetArn = d.Ec2Config?.SubnetArn;
            securityGroupArns = d.Ec2Config?.SecurityGroupArns ?? [];
          } else if (locationType === 'fsxWindows') {
            const d = await client.send(
              new DescribeLocationFsxWindowsCommand({ LocationArn: arn }),
            );
            securityGroupArns = d.SecurityGroupArns ?? [];
          } else if (locationType === 'fsxLustre') {
            const d = await client.send(
              new DescribeLocationFsxLustreCommand({ LocationArn: arn }),
            );
            securityGroupArns = d.SecurityGroupArns ?? [];
          } else if (locationType === 'fsxOntap') {
            const d = await client.send(
              new DescribeLocationFsxOntapCommand({ LocationArn: arn }),
            );
            securityGroupArns = d.SecurityGroupArns ?? [];
          } else if (locationType === 'fsxOpenZfs') {
            const d = await client.send(
              new DescribeLocationFsxOpenZfsCommand({ LocationArn: arn }),
            );
            securityGroupArns = d.SecurityGroupArns ?? [];
          }
        } catch (err) {
          const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
          out.errors.push({
            service: 'datasync',
            operation: `DescribeLocation(${arn})`,
            message,
          });
        }
        out.dataSyncLocations.push({
          id: lastSegment(arn),
          arn,
          name: entry.LocationUri ?? lastSegment(arn),
          tags: {},
          locationType,
          locationUri: entry.LocationUri,
          subnetArn,
          securityGroupArns,
        });
      }
    }
  });

  await guard(out.errors, 'datasync', 'ListTasks', async () => {
    for await (const page of paginateListTasks({ client }, {})) {
      for (const entry of page.Tasks ?? []) {
        const arn = entry.TaskArn;
        if (!arn) continue;
        const task = await client.send(new DescribeTaskCommand({ TaskArn: arn }));
        out.dataSyncTasks.push({
          id: lastSegment(arn),
          arn,
          name: task.Name ?? entry.Name,
          tags: {},
          status: task.Status,
          sourceLocationArn: task.SourceLocationArn,
          destinationLocationArn: task.DestinationLocationArn,
        });
      }
    }
  });
}
