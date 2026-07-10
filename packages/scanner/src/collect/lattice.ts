// VPC Lattice — READ-ONLY (List* only). Service networks stitch VPCs to
// services outside classic routing; VPC endpoints of type ServiceNetwork
// already reference them, so the atlas needs the other side too. Target
// groups are what sits BEHIND a Lattice service (instances/IPs/Lambdas/ALBs
// in a VPC), and resource gateways / resource configurations are the newer
// Lattice "resource" model — the gateway is VPC-attached (subnets + SGs).
import {
  VPCLatticeClient,
  paginateListResourceConfigurations,
  paginateListResourceGateways,
  paginateListServiceNetworks,
  paginateListServices,
  paginateListServiceNetworkVpcAssociations,
  paginateListServiceNetworkServiceAssociations,
  paginateListTargetGroups,
  paginateListTargets,
} from '@aws-sdk/client-vpc-lattice';
import pLimit from 'p-limit';
import type { RegionSnapshot } from '@atlas/schema';
import { AwsContext, guard } from '../aws.js';

/** Per-region target-group cap so a huge estate can't stall the scan. */
const MAX_TARGET_GROUPS = 200;
/** Per-group registered-target cap (target lists can be large); the nested
 *  list is silently truncated like the DNS Firewall domain lists. */
const MAX_TARGETS_PER_GROUP = 50;
/** Per-region caps for the resource model (mirrors MAX_TARGET_GROUPS). */
const MAX_RESOURCE_GATEWAYS = 200;
const MAX_RESOURCE_CONFIGURATIONS = 200;

export async function collectLattice(
  ctx: AwsContext,
  region: string,
  out: RegionSnapshot,
): Promise<void> {
  const errors = out.errors;
  const lattice = ctx.client(VPCLatticeClient, region);
  const limit = pLimit(4);

  await guard(errors, 'vpc-lattice', 'ListServiceNetworks', async () => {
    const networks: RegionSnapshot['latticeServiceNetworks'] = [];
    for await (const page of paginateListServiceNetworks({ client: lattice }, {})) {
      for (const sn of page.items ?? []) {
        if (!sn.id) continue;
        networks.push({
          id: sn.id,
          arn: sn.arn,
          name: sn.name,
          tags: {},
          numberOfAssociatedServices: sn.numberOfAssociatedServices,
          numberOfAssociatedVpcs: sn.numberOfAssociatedVPCs,
          authType: undefined,
          vpcAssociations: [],
          serviceAssociations: [],
        });
      }
    }
    await Promise.all(
      networks.map((sn) =>
        limit(async () => {
          await guard(
            errors,
            'vpc-lattice',
            `ListServiceNetworkVpcAssociations(${sn.name ?? sn.id})`,
            async () => {
              for await (const page of paginateListServiceNetworkVpcAssociations(
                { client: lattice },
                { serviceNetworkIdentifier: sn.id },
              )) {
                for (const assoc of page.items ?? []) {
                  sn.vpcAssociations.push({ vpcId: assoc.vpcId, status: assoc.status });
                }
              }
              sn.vpcAssociations.sort((a, b) => (a.vpcId ?? '').localeCompare(b.vpcId ?? ''));
            },
          );
          await guard(
            errors,
            'vpc-lattice',
            `ListServiceNetworkServiceAssociations(${sn.name ?? sn.id})`,
            async () => {
              for await (const page of paginateListServiceNetworkServiceAssociations(
                { client: lattice },
                { serviceNetworkIdentifier: sn.id },
              )) {
                for (const assoc of page.items ?? []) {
                  sn.serviceAssociations.push({
                    serviceArn: assoc.serviceArn,
                    serviceName: assoc.serviceName,
                    status: assoc.status,
                  });
                }
              }
              sn.serviceAssociations.sort((a, b) =>
                (a.serviceArn ?? '').localeCompare(b.serviceArn ?? ''),
              );
            },
          );
        }),
      ),
    );
    out.latticeServiceNetworks.push(...networks);
  });

  await guard(errors, 'vpc-lattice', 'ListServices', async () => {
    for await (const page of paginateListServices({ client: lattice }, {})) {
      for (const svc of page.items ?? []) {
        if (!svc.id) continue;
        out.latticeServices.push({
          id: svc.id,
          arn: svc.arn,
          name: svc.name,
          tags: {},
          dnsEntry: svc.dnsEntry?.domainName,
          customDomainName: svc.customDomainName,
          status: svc.status,
          authType: undefined,
        });
      }
    }
  });

  await guard(errors, 'vpc-lattice', 'ListTargetGroups', async () => {
    const groups: RegionSnapshot['latticeTargetGroups'] = [];
    let count = 0;
    paging: for await (const page of paginateListTargetGroups({ client: lattice }, {})) {
      for (const tg of page.items ?? []) {
        if (!tg.id) continue;
        if (count >= MAX_TARGET_GROUPS) {
          errors.push({
            service: 'vpc-lattice',
            operation: 'ListTargetGroups truncated',
            message: `stopped after ${MAX_TARGET_GROUPS} target groups; results for this region are incomplete`,
          });
          break paging;
        }
        count++;
        groups.push({
          id: tg.id,
          arn: tg.arn,
          name: tg.name,
          tags: {},
          type: tg.type,
          status: tg.status,
          vpcId: tg.vpcIdentifier,
          port: tg.port,
          protocol: tg.protocol,
          ipAddressType: tg.ipAddressType,
          serviceArns: tg.serviceArns ?? [],
          targets: [],
        });
      }
    }
    await Promise.all(
      groups.map((tg) =>
        limit(() =>
          guard(errors, 'vpc-lattice', `ListTargets(${tg.name ?? tg.id})`, async () => {
            paging: for await (const page of paginateListTargets(
              { client: lattice },
              { targetGroupIdentifier: tg.id },
            )) {
              for (const target of page.items ?? []) {
                if (!target.id) continue;
                if ((tg.targets ??= []).length >= MAX_TARGETS_PER_GROUP) break paging;
                tg.targets.push({ id: target.id, status: target.status });
              }
            }
          }),
        ),
      ),
    );
    out.latticeTargetGroups.push(...groups);
  });

  await guard(errors, 'vpc-lattice', 'ListResourceGateways', async () => {
    let count = 0;
    paging: for await (const page of paginateListResourceGateways({ client: lattice }, {})) {
      for (const gw of page.items ?? []) {
        if (!gw.id) continue;
        if (count >= MAX_RESOURCE_GATEWAYS) {
          errors.push({
            service: 'vpc-lattice',
            operation: 'ListResourceGateways truncated',
            message: `stopped after ${MAX_RESOURCE_GATEWAYS} resource gateways; results for this region are incomplete`,
          });
          break paging;
        }
        count++;
        out.latticeResourceGateways.push({
          id: gw.id,
          arn: gw.arn,
          name: gw.name,
          tags: {},
          vpcId: gw.vpcIdentifier,
          subnetIds: gw.subnetIds ?? [],
          securityGroupIds: gw.securityGroupIds ?? [],
          status: gw.status,
        });
      }
    }
  });

  // Port ranges live only on GetResourceConfiguration (an N+1 fan-out) and
  // are deliberately not fetched — the summary carries the topology.
  await guard(errors, 'vpc-lattice', 'ListResourceConfigurations', async () => {
    let count = 0;
    paging: for await (const page of paginateListResourceConfigurations({ client: lattice }, {})) {
      for (const rc of page.items ?? []) {
        if (!rc.id) continue;
        if (count >= MAX_RESOURCE_CONFIGURATIONS) {
          errors.push({
            service: 'vpc-lattice',
            operation: 'ListResourceConfigurations truncated',
            message: `stopped after ${MAX_RESOURCE_CONFIGURATIONS} resource configurations; results for this region are incomplete`,
          });
          break paging;
        }
        count++;
        out.latticeResourceConfigurations.push({
          id: rc.id,
          arn: rc.arn,
          name: rc.name,
          tags: {},
          type: rc.type,
          resourceGatewayId: rc.resourceGatewayId,
          status: rc.status,
          amazonManaged: rc.amazonManaged,
        });
      }
    }
  });
}
