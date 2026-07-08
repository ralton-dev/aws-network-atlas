// EMR — READ-ONLY (List*/Describe* only).
// Clusters are VPC-ATTACHED: Ec2InstanceAttributes carries the subnet(s) and
// the EMR-managed master/slave, service-access, and additional security
// groups — the network posture the tag sweep can't see — plus release label,
// state, instance collection type, master public DNS, and log URI.
import {
  EMRClient,
  ClusterState,
  DescribeClusterCommand,
  paginateListClusters,
} from '@aws-sdk/client-emr';
import type { RegionSnapshot } from '@atlas/schema';
import { AwsContext, guard } from '../aws.js';

/** Per-region cluster cap so a huge estate can't stall the scan. */
const MAX_CLUSTERS = 300;

/** Active-only states — terminated clusters linger in ListClusters for weeks. */
const ACTIVE_STATES: ClusterState[] = [
  ClusterState.STARTING,
  ClusterState.BOOTSTRAPPING,
  ClusterState.RUNNING,
  ClusterState.WAITING,
];

export async function collectEmr(
  ctx: AwsContext,
  region: string,
  out: RegionSnapshot,
): Promise<void> {
  await guard(out.errors, 'emr', 'ListClusters', async () => {
    const client = ctx.client(EMRClient, region);

    let count = 0;
    paging: for await (const page of paginateListClusters(
      { client },
      { ClusterStates: ACTIVE_STATES },
    )) {
      for (const summary of page.Clusters ?? []) {
        const clusterId = summary.Id;
        if (!clusterId) continue;
        if (count >= MAX_CLUSTERS) {
          out.errors.push({
            service: 'emr',
            operation: 'ListClusters truncated',
            message: `stopped after ${MAX_CLUSTERS} clusters; results for this region are incomplete`,
          });
          break paging;
        }
        count++;

        // DescribeCluster carries the VPC attributes/release/log URI — a
        // per-cluster failure must not lose the cluster itself.
        try {
          const detail = await client.send(new DescribeClusterCommand({ ClusterId: clusterId }));
          const cluster = detail.Cluster;
          const attrs = cluster?.Ec2InstanceAttributes;

          out.emrClusters.push({
            id: clusterId,
            arn: cluster?.ClusterArn ?? summary.ClusterArn,
            name: cluster?.Name ?? summary.Name,
            // Tags come back on DescribeCluster but as a plain list; the
            // detailed key/value sweep already covers tagged clusters — skipped.
            tags: {},
            state: cluster?.Status?.State ?? summary.Status?.State,
            releaseLabel: cluster?.ReleaseLabel,
            subnetIds: [attrs?.Ec2SubnetId, ...(attrs?.RequestedEc2SubnetIds ?? [])].filter(
              (s): s is string => !!s,
            ),
            securityGroupIds: [
              attrs?.EmrManagedMasterSecurityGroup,
              attrs?.EmrManagedSlaveSecurityGroup,
              attrs?.ServiceAccessSecurityGroup,
              ...(attrs?.AdditionalMasterSecurityGroups ?? []),
              ...(attrs?.AdditionalSlaveSecurityGroups ?? []),
            ].filter((sg): sg is string => !!sg),
            availabilityZone: attrs?.Ec2AvailabilityZone,
            instanceCollectionType: cluster?.InstanceCollectionType,
            masterPublicDnsName: cluster?.MasterPublicDnsName,
            logUri: cluster?.LogUri,
          });
        } catch {
          // keep the ListClusters-level fields
          out.emrClusters.push({
            id: clusterId,
            arn: summary.ClusterArn,
            name: summary.Name,
            tags: {},
            state: summary.Status?.State,
            subnetIds: [],
            securityGroupIds: [],
          });
        }
      }
    }
  });
}
