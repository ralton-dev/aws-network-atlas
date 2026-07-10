// Amazon FSx — READ-ONLY (Describe* only).
// File systems (Windows / Lustre / ONTAP / OpenZFS) are VPC-ATTACHED network
// storage holding real data, the direct peer of EFS: each carries its VpcId,
// SubnetIds and ENIs straight off the file system — the placement the tag
// sweep can't see — plus DNS name, storage capacity/type, lifecycle, and the
// deployment type from the type-specific configuration block. The name is the
// Name tag (FSx has no native name field). Nested detail (ONTAP/OpenZFS
// volumes, storage virtual machines, snapshots, data repository associations)
// is NOT collected in v1 — those types stay in the tagged-inventory sweep.
import { FSxClient, paginateDescribeFileSystems } from '@aws-sdk/client-fsx';
import type { RegionSnapshot } from '@atlas/schema';
import { AwsContext, guard } from '../aws.js';
import { toTags, nameTag } from '../util.js';

/** Per-region file-system cap so a huge estate can't stall the scan. */
const MAX_FILE_SYSTEMS = 200;

export async function collectFsx(
  ctx: AwsContext,
  region: string,
  out: RegionSnapshot,
): Promise<void> {
  await guard(out.errors, 'fsx', 'DescribeFileSystems', async () => {
    const client = ctx.client(FSxClient, region);

    let count = 0;
    paging: for await (const page of paginateDescribeFileSystems({ client }, {})) {
      for (const fs of page.FileSystems ?? []) {
        if (!fs.FileSystemId) continue;
        if (count >= MAX_FILE_SYSTEMS) {
          out.errors.push({
            service: 'fsx',
            operation: 'DescribeFileSystems truncated',
            message: `stopped after ${MAX_FILE_SYSTEMS} file systems; results for this region are incomplete`,
          });
          break paging;
        }
        count++;

        const tags = toTags(fs.Tags);
        // The deployment type lives on the per-type configuration block.
        const cfg =
          fs.WindowsConfiguration ??
          fs.LustreConfiguration ??
          fs.OntapConfiguration ??
          fs.OpenZFSConfiguration;
        out.fsxFileSystems.push({
          id: fs.FileSystemId,
          arn: fs.ResourceARN,
          name: nameTag(tags),
          tags,
          fileSystemType: fs.FileSystemType ?? 'UNKNOWN',
          vpcId: fs.VpcId,
          subnetIds: fs.SubnetIds ?? [],
          networkInterfaceIds: fs.NetworkInterfaceIds,
          dnsName: fs.DNSName,
          storageCapacityGiB: fs.StorageCapacity,
          storageType: fs.StorageType,
          deploymentType: cfg?.DeploymentType,
          lifecycle: fs.Lifecycle,
        });
      }
    }
  });
}
