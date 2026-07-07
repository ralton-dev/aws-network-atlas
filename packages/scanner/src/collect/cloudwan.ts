// AWS Cloud WAN (Network Manager) — READ-ONLY (List*/Get* only).
// Account-global: the API is served from us-west-2. Route tables can target a
// core network ARN, so without this collector those routes point at ghosts.
import {
  NetworkManagerClient,
  paginateListCoreNetworks,
  paginateListAttachments,
  GetCoreNetworkCommand,
} from '@aws-sdk/client-networkmanager';
import pLimit from 'p-limit';
import type { AccountSnapshot } from '@atlas/schema';
import { AwsContext, guard } from '../aws.js';
import { toTags, sortById } from '../util.js';

export async function collectCloudWan(
  ctx: AwsContext,
  out: AccountSnapshot['global'],
): Promise<void> {
  const errors = out.errors;
  const nm = ctx.client(NetworkManagerClient, 'us-west-2');
  const limit = pLimit(4);

  await guard(errors, 'networkmanager', 'ListCoreNetworks', async () => {
    const coreNetworks: AccountSnapshot['global']['coreNetworks'] = [];
    for await (const page of paginateListCoreNetworks({ client: nm }, {})) {
      for (const cn of page.CoreNetworks ?? []) {
        if (!cn.CoreNetworkId) continue;
        coreNetworks.push({
          id: cn.CoreNetworkId,
          arn: cn.CoreNetworkArn,
          name: toTags(cn.Tags)['Name'] || cn.CoreNetworkId,
          tags: toTags(cn.Tags),
          globalNetworkId: cn.GlobalNetworkId,
          state: cn.State,
          description: cn.Description,
          segments: [],
          edges: [],
          attachments: [],
        });
      }
    }

    await Promise.all(
      coreNetworks.map((cn) =>
        limit(async () => {
          await guard(errors, 'networkmanager', `GetCoreNetwork(${cn.id})`, async () => {
            const res = await nm.send(new GetCoreNetworkCommand({ CoreNetworkId: cn.id }));
            cn.segments = (res.CoreNetwork?.Segments ?? [])
              .map((s) => s.Name)
              .filter((n): n is string => !!n)
              .sort();
            cn.edges = (res.CoreNetwork?.Edges ?? [])
              .map((e) => ({ location: e.EdgeLocation, asn: e.Asn }))
              .sort((a, b) => (a.location ?? '').localeCompare(b.location ?? ''));
          });
          await guard(errors, 'networkmanager', `ListAttachments(${cn.id})`, async () => {
            for await (const page of paginateListAttachments(
              { client: nm },
              { CoreNetworkId: cn.id },
            )) {
              for (const att of page.Attachments ?? []) {
                if (!att.AttachmentId) continue;
                cn.attachments.push({
                  id: att.AttachmentId,
                  type: att.AttachmentType,
                  state: att.State,
                  edgeLocation: att.EdgeLocation,
                  resourceArn: att.ResourceArn,
                  segmentName: att.SegmentName,
                  ownerAccountId: att.OwnerAccountId,
                });
              }
            }
            sortById(cn.attachments);
          });
        }),
      ),
    );
    out.coreNetworks.push(...coreNetworks);
  });
}
