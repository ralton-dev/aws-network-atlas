// Amazon Redshift Serverless — READ-ONLY (List* only).
// A separate API from provisioned Redshift clusters. The workgroup is the
// VPC-ATTACHED compute half — subnets, security groups, an endpoint and a
// publiclyAccessible flag (a potentially internet-facing data warehouse the
// tag sweep can't see when untagged). The namespace is the data/identity
// half: admin user, database name, KMS key, default IAM role. The workgroup's
// vpcId comes off the endpoint's VPC endpoints when present; otherwise
// derive.ts resolves it from a scanned subnet. Tags are not returned by the
// List calls and are deliberately not fetched per-resource (no N+1
// ListTagsForResource fan-out — the OpenSearch collector sets the precedent).
import {
  RedshiftServerlessClient,
  paginateListWorkgroups,
  paginateListNamespaces,
} from '@aws-sdk/client-redshift-serverless';
import type { RegionSnapshot } from '@atlas/schema';
import { AwsContext, guard } from '../aws.js';

/** Per-region caps so a huge estate can't stall the scan. */
const MAX_WORKGROUPS = 200;
const MAX_NAMESPACES = 200;

export async function collectRedshiftServerless(
  ctx: AwsContext,
  region: string,
  out: RegionSnapshot,
): Promise<void> {
  const client = ctx.client(RedshiftServerlessClient, region);

  await guard(out.errors, 'redshift-serverless', 'ListWorkgroups', async () => {
    let count = 0;
    paging: for await (const page of paginateListWorkgroups({ client }, {})) {
      for (const wg of page.workgroups ?? []) {
        if (!wg.workgroupName) continue;
        if (count >= MAX_WORKGROUPS) {
          out.errors.push({
            service: 'redshift-serverless',
            operation: 'ListWorkgroups truncated',
            message: `stopped after ${MAX_WORKGROUPS} workgroups; results for this region are incomplete`,
          });
          break paging;
        }
        count++;

        // Each endpoint VPC endpoint carries the VPC it lives in.
        const vpcId = (wg.endpoint?.vpcEndpoints ?? [])
          .map((e) => e.vpcId)
          .find((v): v is string => !!v);
        out.redshiftServerlessWorkgroups.push({
          id: wg.workgroupName,
          arn: wg.workgroupArn,
          name: wg.workgroupName,
          tags: {},
          namespaceName: wg.namespaceName,
          status: wg.status,
          vpcId,
          subnetIds: wg.subnetIds ?? [],
          securityGroupIds: wg.securityGroupIds ?? [],
          publiclyAccessible: wg.publiclyAccessible,
          endpointAddress: wg.endpoint?.address,
          endpointPort: wg.endpoint?.port,
          baseCapacity: wg.baseCapacity,
          enhancedVpcRouting: wg.enhancedVpcRouting,
        });
      }
    }
  });

  await guard(out.errors, 'redshift-serverless', 'ListNamespaces', async () => {
    let count = 0;
    paging: for await (const page of paginateListNamespaces({ client }, {})) {
      for (const ns of page.namespaces ?? []) {
        if (!ns.namespaceName) continue;
        if (count >= MAX_NAMESPACES) {
          out.errors.push({
            service: 'redshift-serverless',
            operation: 'ListNamespaces truncated',
            message: `stopped after ${MAX_NAMESPACES} namespaces; results for this region are incomplete`,
          });
          break paging;
        }
        count++;

        out.redshiftServerlessNamespaces.push({
          id: ns.namespaceName,
          arn: ns.namespaceArn,
          name: ns.namespaceName,
          tags: {},
          adminUsername: ns.adminUsername,
          dbName: ns.dbName,
          kmsKeyId: ns.kmsKeyId,
          defaultIamRoleArn: ns.defaultIamRoleArn,
          status: ns.status,
        });
      }
    }
  });
}
