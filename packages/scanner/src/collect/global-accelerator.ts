// AWS Global Accelerator — READ-ONLY (List* only). Account-global; the API
// is only served from us-west-2 (any-region requests are rejected).
// An accelerator is a public entry point that routes straight to ALBs/NLBs/
// EIPs/EC2 across regions — a first-class internet → workload path.
import {
  GlobalAcceleratorClient,
  paginateListAccelerators,
  paginateListListeners,
  paginateListEndpointGroups,
} from '@aws-sdk/client-global-accelerator';
import pLimit from 'p-limit';
import type { AccountSnapshot } from '@atlas/schema';
import { AwsContext, guard } from '../aws.js';

type AcceleratorOut = AccountSnapshot['global']['globalAccelerators'][number];
type ListenerOut = AcceleratorOut['listeners'][number];

export async function collectGlobalAccelerator(
  ctx: AwsContext,
  out: AccountSnapshot['global'],
): Promise<void> {
  const errors = out.errors;
  const client = ctx.client(GlobalAcceleratorClient, 'us-west-2');
  const limit = pLimit(4);

  await guard(errors, 'globalaccelerator', 'ListAccelerators', async () => {
    const accelerators: AcceleratorOut[] = [];
    const listenerArnsByAccelerator = new Map<string, string[]>();

    for await (const page of paginateListAccelerators({ client }, {})) {
      for (const a of page.Accelerators ?? []) {
        if (!a.AcceleratorArn) continue;
        accelerators.push({
          id: a.AcceleratorArn,
          arn: a.AcceleratorArn,
          name: a.Name,
          tags: {},
          dnsName: a.DnsName,
          status: a.Status,
          enabled: a.Enabled,
          ipAddressType: a.IpAddressType,
          ipAddresses: (a.IpSets ?? []).flatMap((s) => s.IpAddresses ?? []).sort(),
          listeners: [],
        });
      }
    }

    await Promise.all(
      accelerators.map((acc) =>
        limit(() =>
          guard(errors, 'globalaccelerator', `ListListeners(${acc.name ?? acc.id})`, async () => {
            const listenerArns: string[] = [];
            for await (const page of paginateListListeners(
              { client },
              { AcceleratorArn: acc.id },
            )) {
              for (const l of page.Listeners ?? []) {
                if (!l.ListenerArn) continue;
                listenerArns.push(l.ListenerArn);
                acc.listeners.push({
                  protocol: l.Protocol,
                  portRanges: (l.PortRanges ?? []).map((p) => ({
                    fromPort: p.FromPort,
                    toPort: p.ToPort,
                  })),
                  endpointGroups: [],
                });
              }
            }
            listenerArnsByAccelerator.set(acc.id, listenerArns);
          }),
        ),
      ),
    );

    await Promise.all(
      accelerators.map((acc) =>
        limit(async () => {
          const listenerArns = listenerArnsByAccelerator.get(acc.id) ?? [];
          for (let i = 0; i < listenerArns.length; i++) {
            const listenerArn = listenerArns[i]!;
            const listener: ListenerOut | undefined = acc.listeners[i];
            if (!listener) continue;
            await guard(
              errors,
              'globalaccelerator',
              `ListEndpointGroups(${acc.name ?? acc.id})`,
              async () => {
                for await (const page of paginateListEndpointGroups(
                  { client },
                  { ListenerArn: listenerArn },
                )) {
                  for (const g of page.EndpointGroups ?? []) {
                    listener.endpointGroups.push({
                      region: g.EndpointGroupRegion,
                      trafficDialPercentage: g.TrafficDialPercentage,
                      endpoints: (g.EndpointDescriptions ?? []).map((e) => ({
                        endpointId: e.EndpointId,
                        weight: e.Weight,
                        clientIpPreservation: e.ClientIPPreservationEnabled,
                        healthState: e.HealthState,
                      })),
                    });
                  }
                }
              },
            );
          }
        }),
      ),
    );

    out.globalAccelerators.push(...accelerators);
  });
}
