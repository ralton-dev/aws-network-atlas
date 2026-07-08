// Transfer Family — READ-ONLY (List*/Describe* only).
// Servers are VPC-ATTACHED when EndpointType=VPC (or VPC_ENDPOINT):
// DescribeServer's EndpointDetails carries the vpc/subnets/security groups —
// the network posture the tag sweep can't see — plus protocols, identity
// provider type, backing storage domain (S3/EFS), state, and user count.
import {
  TransferClient,
  DescribeServerCommand,
  paginateListServers,
} from '@aws-sdk/client-transfer';
import type { RegionSnapshot } from '@atlas/schema';
import { AwsContext, guard } from '../aws.js';

export async function collectTransfer(
  ctx: AwsContext,
  region: string,
  out: RegionSnapshot,
): Promise<void> {
  await guard(out.errors, 'transfer', 'ListServers', async () => {
    const client = ctx.client(TransferClient, region);

    for await (const page of paginateListServers({ client }, {})) {
      for (const summary of page.Servers ?? []) {
        const serverId = summary.ServerId;
        if (!serverId) continue;

        // DescribeServer carries the protocols + VPC endpoint details — a
        // per-server failure must not lose the server itself.
        try {
          const detail = await client.send(new DescribeServerCommand({ ServerId: serverId }));
          const server = detail.Server;
          const endpoint = server?.EndpointDetails;

          out.transferServers.push({
            id: serverId,
            arn: server?.Arn ?? summary.Arn,
            name: serverId,
            // Tags come back on DescribeServer but as a plain list; the
            // detailed key/value sweep already covers tagged servers — skipped.
            tags: {},
            state: server?.State ?? summary.State,
            endpointType: server?.EndpointType ?? summary.EndpointType,
            protocols: server?.Protocols ?? [],
            identityProviderType: server?.IdentityProviderType ?? summary.IdentityProviderType,
            domain: server?.Domain ?? summary.Domain,
            vpcId: endpoint?.VpcId,
            subnetIds: endpoint?.SubnetIds ?? [],
            securityGroupIds: endpoint?.SecurityGroupIds ?? [],
            vpcEndpointId: endpoint?.VpcEndpointId,
            userCount: server?.UserCount ?? summary.UserCount,
          });
        } catch {
          // keep the ListServers-level fields
          out.transferServers.push({
            id: serverId,
            arn: summary.Arn,
            name: serverId,
            tags: {},
            state: summary.State,
            endpointType: summary.EndpointType,
            protocols: [],
            identityProviderType: summary.IdentityProviderType,
            domain: summary.Domain,
            subnetIds: [],
            securityGroupIds: [],
            userCount: summary.UserCount,
          });
        }
      }
    }
  });
}
