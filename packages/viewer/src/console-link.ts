import type { ResourceRef } from './data.js';

// The console's `/go/view?arn=…` endpoint resolves an ARN to that resource's
// console page server-side (the same redirect Resource Explorer uses), so one
// URL shape covers every service — no per-service page templates to maintain.
// Unresolvable ARNs land on a console 404, never a broken page.

// EC2-family kinds are scanned without an ARN, but their ARNs are
// deterministic: arn:aws:ec2:<region>:<account>:<type>/<id>.
const EC2_ARN_TYPE: Record<string, string> = {
  vpc: 'vpc',
  subnet: 'subnet',
  'route-table': 'route-table',
  igw: 'internet-gateway',
  eigw: 'egress-only-internet-gateway',
  nat: 'natgateway',
  eip: 'elastic-ip',
  nacl: 'network-acl',
  sg: 'security-group',
  eni: 'network-interface',
  vpce: 'vpc-endpoint',
  'vpce-service': 'vpc-endpoint-service',
  'prefix-list': 'prefix-list',
  'flow-log': 'vpc-flow-log',
  'dhcp-options': 'dhcp-options',
  'instance-connect-endpoint': 'instance-connect-endpoint',
  pcx: 'vpc-peering-connection',
  tgw: 'transit-gateway',
  'tgw-attachment': 'transit-gateway-attachment',
  'tgw-rt': 'transit-gateway-route-table',
  'tgw-connect-peer': 'transit-gateway-connect-peer',
  vgw: 'vpn-gateway',
  cgw: 'customer-gateway',
  vpn: 'vpn-connection',
  instance: 'instance',
};

function syntheticArn(ref: ResourceRef): string | undefined {
  const ec2Type = EC2_ARN_TYPE[ref.kind];
  if (ec2Type && ref.region) {
    // EC2-classic EIPs have a bare IP as id — no ARN exists for those.
    if (ref.kind === 'eip' && !ref.id.startsWith('eipalloc-')) return undefined;
    return `arn:aws:ec2:${ref.region}:${ref.accountId}:${ec2Type}/${ref.id}`;
  }
  switch (ref.kind) {
    case 's3':
      return `arn:aws:s3:::${ref.id}`;
    case 'zone':
      return `arn:aws:route53:::hostedzone/${ref.id}`;
    case 'dxgw':
      return `arn:aws:directconnect::${ref.accountId}:dx-gateway/${ref.id}`;
    case 'dx-connection':
      return `arn:aws:directconnect:${ref.region}:${ref.accountId}:dxcon/${ref.id}`;
    case 'dx-lag':
      return `arn:aws:directconnect:${ref.region}:${ref.accountId}:dxlag/${ref.id}`;
    case 'dx-vif':
      return `arn:aws:directconnect:${ref.region}:${ref.accountId}:dxvif/${ref.id}`;
    default:
      return undefined;
  }
}

/**
 * AWS console deep link for a resource, or undefined when we can't determine
 * an ARN. Opening it requires a console session in the resource's account.
 */
export function consoleUrl(ref: ResourceRef): string | undefined {
  const arn = ref.arn ?? syntheticArn(ref);
  if (!arn) return undefined;
  const domain = arn.startsWith('arn:aws-cn:')
    ? 'console.amazonaws.cn'
    : arn.startsWith('arn:aws-us-gov:')
      ? 'console.amazonaws-us-gov.com'
      : ref.region
        ? `${ref.region}.console.aws.amazon.com`
        : 'console.aws.amazon.com';
  return `https://${domain}/go/view?arn=${encodeURIComponent(arn)}`;
}
