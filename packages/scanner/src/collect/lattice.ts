// VPC Lattice — READ-ONLY (List* only). Service networks stitch VPCs to
// services outside classic routing; VPC endpoints of type ServiceNetwork
// already reference them, so the atlas needs the other side too.
import {
  VPCLatticeClient,
  paginateListServiceNetworks,
  paginateListServices,
  paginateListServiceNetworkVpcAssociations,
  paginateListServiceNetworkServiceAssociations,
} from '@aws-sdk/client-vpc-lattice';
import pLimit from 'p-limit';
import type { RegionSnapshot } from '@atlas/schema';
import { AwsContext, guard } from '../aws.js';

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
}
