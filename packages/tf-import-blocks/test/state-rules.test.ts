/**
 * The Tier B rule table, pinned per type.
 *
 * Every expected value here was read off `website/docs/r/<page>.html.markdown`
 * in `hashicorp/terraform-provider-aws` on `main` (2026-08-07), from the
 * `id = "…"` block — **not** the `identity = { … }` block those pages now print
 * first, which decision 3 forbids. If you change one of these, re-read the page
 * it cites in `src/rules/state.ts`; do not adjust it to match the code.
 *
 * The table is asserted to be *complete*: a rule added to `src/rules/state.ts`
 * with no case here fails `the case table covers every resolver`. That is what
 * stops the table drifting into a sample.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CONFLICTS, resolveStateResource, ruleForType, type StateAttributes } from '../src/index.js';
import { RULES } from '../src/rules/state.js';

interface Case {
  readonly type: string;
  readonly attrs: StateAttributes;
  readonly expected: string;
}

/** `{ id }` only — the type whose native id really is its import id. */
const byId = (type: string, id: string): Case => ({ type, attrs: { id }, expected: id });

const CASES: readonly Case[] = [
  // ── EC2 / VPC: native id is the import id ────────────────────────────────
  byId('aws_vpc', 'vpc-0a1b2c3d4e5f60718'),
  byId('aws_subnet', 'subnet-0aa11bb22cc33dd44'),
  byId('aws_route_table', 'rtb-4e616f6d69'),
  byId('aws_internet_gateway', 'igw-c0a643a9'),
  byId('aws_egress_only_internet_gateway', 'eigw-015e0e244e24dfe8a'),
  byId('aws_nat_gateway', 'nat-05dba92075d71c408'),
  byId('aws_network_acl', 'acl-7aaabd18'),
  byId('aws_network_acl_association', 'aclassoc-02baf37f20966b3e6'),
  byId('aws_security_group', 'sg-903004f8'),
  byId('aws_network_interface', 'eni-e5aa89a3'),
  byId('aws_network_interface_attachment', 'eni-attach-0a33842b4ec347c4c'),
  byId('aws_vpc_endpoint', 'vpce-3ecf2a57'),
  byId('aws_vpc_endpoint_service', 'vpce-svc-0f97a19d3fa8220bc'),
  byId('aws_ec2_managed_prefix_list', 'pl-0570a1d2d725c16be'),
  byId('aws_flow_log', 'fl-1a2b3c4d'),
  byId('aws_vpc_dhcp_options', 'dopt-d9070ebb'),
  byId('aws_ec2_instance_connect_endpoint', 'eice-012345678'),
  byId('aws_vpc_peering_connection', 'pcx-111aaa111'),
  byId('aws_ec2_transit_gateway', 'tgw-12345678'),
  byId('aws_ec2_transit_gateway_route_table', 'tgw-rtb-12345678'),
  byId('aws_ec2_transit_gateway_vpc_attachment', 'tgw-attach-12345678'),
  byId('aws_vpn_gateway', 'vgw-9a4cacf3'),
  byId('aws_customer_gateway', 'cgw-b4dc3961'),
  byId('aws_vpn_connection', 'vpn-40f41529'),
  byId('aws_dx_connection', 'dxcon-ffre0ec3'),
  byId('aws_dx_gateway', 'abcd1234-dcba-5678-be23-cdef9876ab45'),
  byId('aws_ec2_client_vpn_endpoint', 'cvpn-endpoint-0ac3a1abbccddd666'),
  byId('aws_instance', 'i-12345678'),
  byId('aws_launch_template', 'lt-12345678'),
  byId('aws_ebs_volume', 'vol-049df61146c4d7901'),
  byId('aws_eip_association', 'eipassoc-ab12c345'),
  {
    // The EC2-Classic trap in reverse: `allocation_id` is authoritative, so an
    // id holding a bare public IP can never leak into the output.
    type: 'aws_eip',
    attrs: { id: '203.0.113.5', allocation_id: 'eipalloc-00a10e96', public_ip: '203.0.113.5' },
    expected: 'eipalloc-00a10e96',
  },
  {
    type: 'aws_vpc_dhcp_options_association',
    attrs: { id: 'dopt-d9070ebb-vpc-0f001273ec18911b1', vpc_id: 'vpc-0f001273ec18911b1' },
    expected: 'vpc-0f001273ec18911b1',
  },
  {
    type: 'aws_vpc_security_group_ingress_rule',
    attrs: { id: 'sgr-02108b27edd666983', security_group_rule_id: 'sgr-02108b27edd666983' },
    expected: 'sgr-02108b27edd666983',
  },
  {
    type: 'aws_vpc_security_group_egress_rule',
    attrs: { id: 'sgr-02108b27edd666983', security_group_rule_id: 'sgr-02108b27edd666983' },
    expected: 'sgr-02108b27edd666983',
  },

  // ── EC2 / VPC composites ─────────────────────────────────────────────────
  {
    // The state id is the provider's synthetic `r-<rtb><hashcode>`.
    type: 'aws_route',
    attrs: {
      id: 'r-rtb-656C65616E6F721080289494',
      route_table_id: 'rtb-656C65616E6F72',
      destination_cidr_block: '0.0.0.0/0',
    },
    expected: 'rtb-656C65616E6F72_0.0.0.0/0',
  },
  {
    type: 'aws_route_table_association',
    attrs: { subnet_id: 'subnet-6777656e646f6c796e', route_table_id: 'rtb-656c65616e6f72' },
    expected: 'subnet-6777656e646f6c796e/rtb-656c65616e6f72',
  },
  {
    // The state id is `sgrule-<hashcode>` and is never importable.
    type: 'aws_security_group_rule',
    attrs: {
      id: 'sgrule-1859128000',
      security_group_id: 'sg-6e616f6d69',
      type: 'ingress',
      protocol: 'tcp',
      from_port: 8000,
      to_port: 8000,
      cidr_blocks: ['10.0.3.0/24'],
    },
    expected: 'sg-6e616f6d69_ingress_tcp_8000_8000_10.0.3.0/24',
  },
  {
    // `egress` is a boolean and `rule_number` a number — `str()` cannot read
    // either, which is why `scalar()` exists.
    type: 'aws_network_acl_rule',
    attrs: { network_acl_id: 'acl-7aaabd18', rule_number: 100, protocol: 'tcp', egress: false },
    expected: 'acl-7aaabd18:100:tcp:false',
  },
  {
    type: 'aws_vpc_endpoint_route_table_association',
    attrs: { vpc_endpoint_id: 'vpce-aaaaaaaa', route_table_id: 'rtb-bbbbbbbb' },
    expected: 'vpce-aaaaaaaa/rtb-bbbbbbbb',
  },
  {
    type: 'aws_vpc_endpoint_subnet_association',
    attrs: { vpc_endpoint_id: 'vpce-aaaaaaaa', subnet_id: 'subnet-bbbbbbbbbbbbbbbbb' },
    expected: 'vpce-aaaaaaaa/subnet-bbbbbbbbbbbbbbbbb',
  },
  {
    type: 'aws_ec2_managed_prefix_list_entry',
    attrs: { prefix_list_id: 'pl-0570a1d2d725c16be', cidr: '10.0.3.0/24' },
    expected: 'pl-0570a1d2d725c16be,10.0.3.0/24',
  },
  {
    type: 'aws_ec2_transit_gateway_route',
    attrs: { transit_gateway_route_table_id: 'tgw-rtb-12345678', destination_cidr_block: '0.0.0.0/0' },
    expected: 'tgw-rtb-12345678_0.0.0.0/0',
  },
  {
    type: 'aws_ec2_transit_gateway_route_table_association',
    attrs: {
      transit_gateway_route_table_id: 'tgw-rtb-12345678',
      transit_gateway_attachment_id: 'tgw-attach-87654321',
    },
    expected: 'tgw-rtb-12345678_tgw-attach-87654321',
  },
  {
    type: 'aws_ec2_transit_gateway_route_table_propagation',
    attrs: {
      transit_gateway_route_table_id: 'tgw-rtb-12345678',
      transit_gateway_attachment_id: 'tgw-attach-87654321',
    },
    expected: 'tgw-rtb-12345678_tgw-attach-87654321',
  },
  {
    type: 'aws_ec2_client_vpn_network_association',
    attrs: {
      client_vpn_endpoint_id: 'cvpn-endpoint-0ac3a1abbccddd666',
      association_id: 'cvpn-assoc-0b8db902465d069ad',
    },
    expected: 'cvpn-endpoint-0ac3a1abbccddd666,cvpn-assoc-0b8db902465d069ad',
  },
  {
    type: 'aws_dx_gateway_association',
    attrs: { dx_gateway_id: '345508c3-7215-4aef-9832-07c125d5bd0f', associated_gateway_id: 'vgw-98765432' },
    expected: '345508c3-7215-4aef-9832-07c125d5bd0f/vgw-98765432',
  },
  {
    type: 'aws_volume_attachment',
    attrs: { device_name: '/dev/sdh', volume_id: 'vol-049df61146c4d7901', instance_id: 'i-12345678' },
    expected: '/dev/sdh:vol-049df61146c4d7901:i-12345678',
  },

  // ── load balancing ───────────────────────────────────────────────────────
  {
    type: 'aws_lb',
    attrs: { arn: 'arn:aws:elasticloadbalancing:us-west-2:123456789012:loadbalancer/app/my-lb/50dc6c495c0c9188' },
    expected: 'arn:aws:elasticloadbalancing:us-west-2:123456789012:loadbalancer/app/my-lb/50dc6c495c0c9188',
  },
  {
    type: 'aws_lb_listener',
    attrs: { arn: 'arn:aws:elasticloadbalancing:us-west-2:1874:listener/app/front/8e4497da/9ab28ade' },
    expected: 'arn:aws:elasticloadbalancing:us-west-2:1874:listener/app/front/8e4497da/9ab28ade',
  },
  {
    type: 'aws_lb_listener_rule',
    attrs: { arn: 'arn:aws:elasticloadbalancing:us-west-2:1874:listener-rule/app/test/8e4497da/9ab28ade/67b3d2d3' },
    expected: 'arn:aws:elasticloadbalancing:us-west-2:1874:listener-rule/app/test/8e4497da/9ab28ade/67b3d2d3',
  },
  {
    type: 'aws_lb_target_group',
    attrs: { arn: 'arn:aws:elasticloadbalancing:us-west-2:1874:targetgroup/app-front-end/20cfe21448b66314' },
    expected: 'arn:aws:elasticloadbalancing:us-west-2:1874:targetgroup/app-front-end/20cfe21448b66314',
  },
  {
    // Underscore-joined, so both halves keep their own colons and slashes.
    type: 'aws_lb_listener_certificate',
    attrs: {
      listener_arn: 'arn:aws:elasticloadbalancing:us-west-2:123456789012:listener/app/test/8e4497da/9ab28ade',
      certificate_arn: 'arn:aws:iam::123456789012:server-certificate/tf-acc-test-6453083910015726063',
    },
    expected:
      'arn:aws:elasticloadbalancing:us-west-2:123456789012:listener/app/test/8e4497da/9ab28ade_' +
      'arn:aws:iam::123456789012:server-certificate/tf-acc-test-6453083910015726063',
  },
  {
    type: 'aws_lb_target_group_attachment',
    attrs: {
      target_group_arn: 'arn:aws:elasticloadbalancing:us-west-2:123456789012:targetgroup/my-tg/abc123',
      target_id: 'i-0123456789abcdef0',
      port: 8080,
    },
    expected:
      'arn:aws:elasticloadbalancing:us-west-2:123456789012:targetgroup/my-tg/abc123,i-0123456789abcdef0,8080',
  },

  // ── DNS ──────────────────────────────────────────────────────────────────
  byId('aws_route53_zone', 'Z1D633PJN98FT9'),
  {
    type: 'aws_route53_record',
    attrs: { zone_id: 'Z4KAPRWWNC7JR', name: 'www.example.com', type: 'A', set_identifier: 'blue' },
    expected: 'Z4KAPRWWNC7JR_www.example.com_A_blue',
  },
  {
    type: 'aws_route53_zone_association',
    attrs: { zone_id: 'Z123456ABCDEFG', vpc_id: 'vpc-12345678', vpc_region: 'us-east-2' },
    expected: 'Z123456ABCDEFG:vpc-12345678:us-east-2',
  },
  byId('aws_route53_resolver_endpoint', 'rslvr-in-abcdef01234567890'),
  byId('aws_route53_resolver_rule', 'rslvr-rr-0123456789abcdef0'),
  byId('aws_route53_resolver_rule_association', 'rslvr-rrassoc-97242eaf88example'),

  // ── WAF / edge ───────────────────────────────────────────────────────────
  {
    type: 'aws_wafv2_web_acl',
    attrs: {
      id: 'a1b2c3d4-d5f6-7777-8888-9999aaaabbbbcccc',
      name: 'edge-acl',
      scope: 'REGIONAL',
      arn: 'arn:aws:wafv2:eu-west-1:111122223333:regional/webacl/edge-acl/a1b2c3d4',
    },
    expected: 'a1b2c3d4-d5f6-7777-8888-9999aaaabbbbcccc/edge-acl/REGIONAL',
  },
  {
    // Scope comes from the record, not from region emptiness: a CLOUDFRONT
    // resource still sits in a state whose provider block has a region.
    type: 'aws_wafv2_ip_set',
    attrs: { id: 'a1b2c3d4-d5f6-7777-8888-9999aaaabbbbcccc', name: 'example', scope: 'CLOUDFRONT' },
    expected: 'a1b2c3d4-d5f6-7777-8888-9999aaaabbbbcccc/example/CLOUDFRONT',
  },
  {
    type: 'aws_wafv2_rule_group',
    attrs: { id: 'a1b2c3d4-d5f6-7777-8888-9999aaaabbbbcccc', name: 'example', scope: 'REGIONAL' },
    expected: 'a1b2c3d4-d5f6-7777-8888-9999aaaabbbbcccc/example/REGIONAL',
  },
  {
    type: 'aws_wafv2_web_acl_association',
    attrs: {
      web_acl_arn: 'arn:aws:wafv2:us-west-2:123456789012:regional/webacl/test/a1b2c3d4',
      resource_arn: 'arn:aws:apigateway:us-west-2::/restapis/abcde/stages/name',
    },
    expected:
      'arn:aws:wafv2:us-west-2:123456789012:regional/webacl/test/a1b2c3d4,' +
      'arn:aws:apigateway:us-west-2::/restapis/abcde/stages/name',
  },
  {
    type: 'aws_wafv2_web_acl_logging_configuration',
    attrs: { resource_arn: 'arn:aws:wafv2:us-west-2:123456789012:regional/webacl/test-logs/a1b2c3d4' },
    expected: 'arn:aws:wafv2:us-west-2:123456789012:regional/webacl/test-logs/a1b2c3d4',
  },
  byId('aws_cloudfront_distribution', 'E74FTE3EXAMPLE'),
  {
    type: 'aws_globalaccelerator_accelerator',
    attrs: { arn: 'arn:aws:globalaccelerator::111111111111:accelerator/abcd1234' },
    expected: 'arn:aws:globalaccelerator::111111111111:accelerator/abcd1234',
  },
  byId('aws_networkmanager_core_network', 'core-network-0d47f6t230mz46dy4'),
  {
    type: 'aws_networkfirewall_firewall',
    attrs: { arn: 'arn:aws:network-firewall:us-west-1:123456789012:firewall/example' },
    expected: 'arn:aws:network-firewall:us-west-1:123456789012:firewall/example',
  },
  {
    type: 'aws_networkfirewall_firewall_policy',
    attrs: { arn: 'arn:aws:network-firewall:us-west-1:123456789012:firewall-policy/example' },
    expected: 'arn:aws:network-firewall:us-west-1:123456789012:firewall-policy/example',
  },
  {
    type: 'aws_networkfirewall_rule_group',
    attrs: { arn: 'arn:aws:network-firewall:us-west-1:123456789012:stateful-rulegroup/example' },
    expected: 'arn:aws:network-firewall:us-west-1:123456789012:stateful-rulegroup/example',
  },

  // ── API Gateway v1 ───────────────────────────────────────────────────────
  byId('aws_api_gateway_rest_api', '12345abcde'),
  byId('aws_api_gateway_api_key', '8bklk8bl1k3sB38D9B3l0enyWT8c09B30lkq0blk'),
  byId('aws_api_gateway_usage_plan', 'usage-plan-12345'),
  {
    type: 'aws_api_gateway_rest_api_policy',
    attrs: { id: '12345abcde', rest_api_id: '12345abcde' },
    expected: '12345abcde',
  },
  {
    type: 'aws_api_gateway_domain_name',
    attrs: { id: 'dev.example.com', domain_name: 'dev.example.com' },
    expected: 'dev.example.com',
  },
  {
    type: 'aws_api_gateway_resource',
    attrs: { id: '67890fghij', rest_api_id: '12345abcde' },
    expected: '12345abcde/67890fghij',
  },
  {
    type: 'aws_api_gateway_deployment',
    attrs: { id: '1122334', rest_api_id: 'aabbccddee' },
    expected: 'aabbccddee/1122334',
  },
  {
    type: 'aws_api_gateway_authorizer',
    attrs: { id: 'example', rest_api_id: '12345abcde' },
    expected: '12345abcde/example',
  },
  {
    type: 'aws_api_gateway_request_validator',
    attrs: { id: '67890fghij', rest_api_id: '12345abcde' },
    expected: '12345abcde/67890fghij',
  },
  {
    type: 'aws_api_gateway_model',
    attrs: { rest_api_id: '12345abcde', name: 'example' },
    expected: '12345abcde/example',
  },
  {
    type: 'aws_api_gateway_stage',
    attrs: { rest_api_id: '12345abcde', stage_name: 'example' },
    expected: '12345abcde/example',
  },
  {
    type: 'aws_api_gateway_gateway_response',
    attrs: { rest_api_id: '12345abcde', response_type: 'UNAUTHORIZED' },
    expected: '12345abcde/UNAUTHORIZED',
  },
  {
    type: 'aws_api_gateway_usage_plan_key',
    attrs: { usage_plan_id: '12345abcde', key_id: 'zzz' },
    expected: '12345abcde/zzz',
  },
  {
    type: 'aws_api_gateway_method',
    attrs: { rest_api_id: '12345abcde', resource_id: '67890fghij', http_method: 'GET' },
    expected: '12345abcde/67890fghij/GET',
  },
  {
    type: 'aws_api_gateway_integration',
    attrs: { rest_api_id: '12345abcde', resource_id: '67890fghij', http_method: 'GET' },
    expected: '12345abcde/67890fghij/GET',
  },
  {
    type: 'aws_api_gateway_method_response',
    attrs: { rest_api_id: '12345abcde', resource_id: '67890fghij', http_method: 'GET', status_code: '200' },
    expected: '12345abcde/67890fghij/GET/200',
  },
  {
    type: 'aws_api_gateway_integration_response',
    attrs: { rest_api_id: '12345abcde', resource_id: '67890fghij', http_method: 'GET', status_code: '200' },
    expected: '12345abcde/67890fghij/GET/200',
  },
  {
    type: 'aws_api_gateway_base_path_mapping',
    attrs: { domain_name: 'example.com', base_path: 'base-path' },
    expected: 'example.com/base-path',
  },

  // ── API Gateway v2 ───────────────────────────────────────────────────────
  byId('aws_apigatewayv2_api', 'aabbccddee'),
  {
    type: 'aws_apigatewayv2_route',
    attrs: { api_id: 'aabbccddee', id: '1122334' },
    expected: 'aabbccddee/1122334',
  },
  {
    type: 'aws_apigatewayv2_integration',
    attrs: { api_id: 'aabbccddee', id: '1122334' },
    expected: 'aabbccddee/1122334',
  },
  {
    type: 'aws_apigatewayv2_stage',
    attrs: { api_id: 'aabbccddee', name: 'example-stage' },
    expected: 'aabbccddee/example-stage',
  },

  // ── IAM: principals by name, policies by ARN — not the same rule ─────────
  { type: 'aws_iam_role', attrs: { id: 'app-task', name: 'app-task' }, expected: 'app-task' },
  { type: 'aws_iam_user', attrs: { id: 'example-user', name: 'example-user' }, expected: 'example-user' },
  { type: 'aws_iam_group', attrs: { id: 'developers', name: 'developers' }, expected: 'developers' },
  {
    type: 'aws_iam_instance_profile',
    attrs: { id: 'app-instance-profile-1', name: 'app-instance-profile-1' },
    expected: 'app-instance-profile-1',
  },
  {
    type: 'aws_iam_policy',
    attrs: { id: 'arn:aws:iam::123456789012:policy/UsersManageOwnCredentials', arn: 'arn:aws:iam::123456789012:policy/UsersManageOwnCredentials' },
    expected: 'arn:aws:iam::123456789012:policy/UsersManageOwnCredentials',
  },
  {
    type: 'aws_iam_saml_provider',
    attrs: { arn: 'arn:aws:iam::123456789012:saml-provider/SAMLADFS' },
    expected: 'arn:aws:iam::123456789012:saml-provider/SAMLADFS',
  },
  {
    type: 'aws_iam_openid_connect_provider',
    attrs: { arn: 'arn:aws:iam::123456789012:oidc-provider/accounts.google.com' },
    expected: 'arn:aws:iam::123456789012:oidc-provider/accounts.google.com',
  },
  {
    type: 'aws_iam_account_alias',
    attrs: { id: 'my-account-alias', account_alias: 'my-account-alias' },
    expected: 'my-account-alias',
  },
  {
    type: 'aws_iam_role_policy_attachment',
    attrs: { role: 'app-task', policy_arn: 'arn:aws:iam::111122223333:policy/app-read' },
    expected: 'app-task/arn:aws:iam::111122223333:policy/app-read',
  },
  {
    type: 'aws_iam_user_policy_attachment',
    attrs: { user: 'test-user', policy_arn: 'arn:aws:iam::111122223333:policy/test-policy' },
    expected: 'test-user/arn:aws:iam::111122223333:policy/test-policy',
  },
  {
    type: 'aws_iam_group_policy_attachment',
    attrs: { group: 'test-group', policy_arn: 'arn:aws:iam::111122223333:policy/test-policy' },
    expected: 'test-group/arn:aws:iam::111122223333:policy/test-policy',
  },
  {
    // Colon, not slash — inline policies and attachments use different joins.
    type: 'aws_iam_role_policy',
    attrs: { role: 'role_of_mypolicy_name', name: 'mypolicy_name' },
    expected: 'role_of_mypolicy_name:mypolicy_name',
  },
  {
    type: 'aws_iam_user_policy',
    attrs: { user: 'user_of_mypolicy_name', name: 'mypolicy_name' },
    expected: 'user_of_mypolicy_name:mypolicy_name',
  },
  {
    type: 'aws_iam_group_policy',
    attrs: { group: 'group_of_mypolicy_name', name: 'mypolicy_name' },
    expected: 'group_of_mypolicy_name:mypolicy_name',
  },
  {
    type: 'aws_iam_user_group_membership',
    attrs: { user: 'user1', groups: ['group1', 'group2'] },
    expected: 'user1/group1/group2',
  },

  // ── IAM Identity Center / Organizations ──────────────────────────────────
  {
    type: 'aws_ssoadmin_permission_set',
    attrs: {
      arn: 'arn:aws:sso:::permissionSet/ssoins-2938j0x8920sbj72/ps-80383020jr9302rk',
      instance_arn: 'arn:aws:sso:::instance/ssoins-2938j0x8920sbj72',
    },
    expected:
      'arn:aws:sso:::permissionSet/ssoins-2938j0x8920sbj72/ps-80383020jr9302rk,' +
      'arn:aws:sso:::instance/ssoins-2938j0x8920sbj72',
  },
  {
    type: 'aws_ssoadmin_managed_policy_attachment',
    attrs: {
      managed_policy_arn: 'arn:aws:iam::aws:policy/ReadOnlyAccess',
      permission_set_arn: 'arn:aws:sso:::permissionSet/ssoins-2938j0x8920sbj72/ps-80383020jr9302rk',
      instance_arn: 'arn:aws:sso:::instance/ssoins-2938j0x8920sbj72',
    },
    expected:
      'arn:aws:iam::aws:policy/ReadOnlyAccess,' +
      'arn:aws:sso:::permissionSet/ssoins-2938j0x8920sbj72/ps-80383020jr9302rk,' +
      'arn:aws:sso:::instance/ssoins-2938j0x8920sbj72',
  },
  {
    type: 'aws_ssoadmin_account_assignment',
    attrs: {
      principal_id: 'f81d4fae-7dec-11d0-a765-00a0c91e6bf6',
      principal_type: 'GROUP',
      target_id: '1234567890',
      target_type: 'AWS_ACCOUNT',
      permission_set_arn: 'arn:aws:sso:::permissionSet/ssoins-0123456789abcdef/ps-0123456789abcdef',
      instance_arn: 'arn:aws:sso:::instance/ssoins-0123456789abcdef',
    },
    expected:
      'f81d4fae-7dec-11d0-a765-00a0c91e6bf6,GROUP,1234567890,AWS_ACCOUNT,' +
      'arn:aws:sso:::permissionSet/ssoins-0123456789abcdef/ps-0123456789abcdef,' +
      'arn:aws:sso:::instance/ssoins-0123456789abcdef',
  },
  {
    type: 'aws_identitystore_group',
    attrs: { identity_store_id: 'd-9c6705e95c', group_id: 'b8a1c340-8031-7071-a2fb-7dc540320c30' },
    expected: 'd-9c6705e95c/b8a1c340-8031-7071-a2fb-7dc540320c30',
  },
  {
    type: 'aws_identitystore_user',
    attrs: { identity_store_id: 'd-9c6705e95c', user_id: '065212b4-9061-703b-5876-13a517ae2a7c' },
    expected: 'd-9c6705e95c/065212b4-9061-703b-5876-13a517ae2a7c',
  },
  byId('aws_organizations_organization', 'o-1234567'),
  byId('aws_organizations_organizational_unit', 'ou-1234567'),
  byId('aws_organizations_account', '111111111111'),
  byId('aws_organizations_policy', 'p-12345678'),
  {
    type: 'aws_organizations_policy_attachment',
    attrs: { target_id: '123456789012', policy_id: 'p-12345678' },
    expected: '123456789012:p-12345678',
  },
  {
    type: 'aws_organizations_delegated_administrator',
    attrs: { account_id: '123456789012', service_principal: 'config.amazonaws.com' },
    expected: '123456789012/config.amazonaws.com',
  },

  // ── S3 ───────────────────────────────────────────────────────────────────
  {
    type: 'aws_s3_bucket',
    attrs: { id: 'acme-assets-eu-west-1', bucket: 'acme-assets-eu-west-1' },
    expected: 'acme-assets-eu-west-1',
  },
  { type: 'aws_s3_bucket_policy', attrs: { bucket: 'my-tf-test-bucket' }, expected: 'my-tf-test-bucket' },
  { type: 'aws_s3_bucket_notification', attrs: { bucket: 'bucket-name' }, expected: 'bucket-name' },
  { type: 'aws_s3_bucket_public_access_block', attrs: { bucket: 'my-bucket' }, expected: 'my-bucket' },
  { type: 'aws_s3_bucket_versioning', attrs: { bucket: 'bucket-name' }, expected: 'bucket-name' },
  {
    // A cross-account bucket appends the owner; a same-account one must not.
    type: 'aws_s3_bucket_lifecycle_configuration',
    attrs: { bucket: 'bucket-name', expected_bucket_owner: '123456789012' },
    expected: 'bucket-name,123456789012',
  },
  {
    type: 'aws_s3_bucket_server_side_encryption_configuration',
    attrs: { bucket: 'bucket-name' },
    expected: 'bucket-name',
  },

  // ── ECR ──────────────────────────────────────────────────────────────────
  { type: 'aws_ecr_repository', attrs: { id: 'test-service', name: 'test-service' }, expected: 'test-service' },
  { type: 'aws_ecr_repository_policy', attrs: { repository: 'example' }, expected: 'example' },
  { type: 'aws_ecr_lifecycle_policy', attrs: { repository: 'tf-example' }, expected: 'tf-example' },

  // ── compute and containers ───────────────────────────────────────────────
  { type: 'aws_autoscaling_group', attrs: { id: 'example', name: 'example' }, expected: 'example' },
  { type: 'aws_ecs_cluster', attrs: { name: 'stateless-app' }, expected: 'stateless-app' },
  {
    // Both halves derived: the state id is the service ARN and `cluster` is the
    // cluster ARN. The most likely place in this table to be plausibly wrong.
    type: 'aws_ecs_service',
    attrs: {
      id: 'arn:aws:ecs:eu-west-1:111122223333:service/prod-cluster/web',
      arn: 'arn:aws:ecs:eu-west-1:111122223333:service/prod-cluster/web',
      name: 'web',
      cluster: 'arn:aws:ecs:eu-west-1:111122223333:cluster/prod-cluster',
    },
    expected: 'prod-cluster/web',
  },
  {
    type: 'aws_ecs_task_definition',
    attrs: { arn: 'arn:aws:ecs:us-east-1:012345678910:task-definition/mytaskfamily:123' },
    expected: 'arn:aws:ecs:us-east-1:012345678910:task-definition/mytaskfamily:123',
  },
  { type: 'aws_eks_cluster', attrs: { id: 'example', name: 'example' }, expected: 'example' },
  {
    // Colon, not slash — EKS is the odd one out among the cluster/child pairs.
    type: 'aws_eks_node_group',
    attrs: { cluster_name: 'example-cluster', node_group_name: 'example-group' },
    expected: 'example-cluster:example-group',
  },
  {
    type: 'aws_eks_addon',
    attrs: { cluster_name: 'example-cluster', addon_name: 'example-addon' },
    expected: 'example-cluster:example-addon',
  },
  {
    type: 'aws_lambda_function',
    attrs: {
      id: 'orders-worker',
      function_name: 'orders-worker',
      arn: 'arn:aws:lambda:eu-west-1:111122223333:function:orders-worker',
    },
    expected: 'orders-worker',
  },
  {
    type: 'aws_lambda_alias',
    attrs: { function_name: 'example', name: 'production' },
    expected: 'example/production',
  },
  {
    type: 'aws_lambda_event_source_mapping',
    attrs: { id: '12345kxodurf3443', uuid: '12345kxodurf3443' },
    expected: '12345kxodurf3443',
  },
  {
    type: 'aws_lambda_layer_version',
    attrs: { arn: 'arn:aws:lambda:us-west-2:123456789012:layer:example:1' },
    expected: 'arn:aws:lambda:us-west-2:123456789012:layer:example:1',
  },
  {
    // The qualifier is glued to the function name, not appended at the end.
    type: 'aws_lambda_permission',
    attrs: {
      function_name: 'my_test_lambda_function',
      statement_id: 'AllowExecutionFromCloudWatch',
      qualifier: 'qualifier_name',
    },
    expected: 'my_test_lambda_function:qualifier_name/AllowExecutionFromCloudWatch',
  },
  {
    type: 'aws_appautoscaling_target',
    attrs: {
      id: 'service/prod-cluster/web',
      service_namespace: 'ecs',
      resource_id: 'service/prod-cluster/web',
      scalable_dimension: 'ecs:service:DesiredCount',
    },
    expected: 'ecs/service/prod-cluster/web/ecs:service:DesiredCount',
  },
  {
    type: 'aws_appautoscaling_policy',
    attrs: {
      service_namespace: 'ecs',
      resource_id: 'service/prod-cluster/web',
      scalable_dimension: 'ecs:service:DesiredCount',
      name: 'scale-out',
    },
    expected: 'ecs/service/prod-cluster/web/ecs:service:DesiredCount/scale-out',
  },

  // ── data stores ──────────────────────────────────────────────────────────
  { type: 'aws_db_instance', attrs: { id: 'core-db', identifier: 'core-db' }, expected: 'core-db' },
  { type: 'aws_db_subnet_group', attrs: { name: 'production-subnet-group' }, expected: 'production-subnet-group' },
  { type: 'aws_db_parameter_group', attrs: { name: 'rds-pg' }, expected: 'rds-pg' },
  { type: 'aws_rds_cluster', attrs: { cluster_identifier: 'aurora-prod-cluster' }, expected: 'aurora-prod-cluster' },
  {
    type: 'aws_rds_cluster_instance',
    attrs: { identifier: 'aurora-cluster-instance-1' },
    expected: 'aurora-cluster-instance-1',
  },
  { type: 'aws_elasticache_cluster', attrs: { cluster_id: 'my_cluster' }, expected: 'my_cluster' },
  {
    type: 'aws_elasticache_replication_group',
    attrs: { replication_group_id: 'replication-group-1' },
    expected: 'replication-group-1',
  },
  { type: 'aws_elasticache_subnet_group', attrs: { name: 'tf-test-cache-subnet' }, expected: 'tf-test-cache-subnet' },
  { type: 'aws_elasticache_parameter_group', attrs: { name: 'redis-params' }, expected: 'redis-params' },
  { type: 'aws_elasticache_user', attrs: { user_id: 'userId1' }, expected: 'userId1' },
  { type: 'aws_elasticache_user_group', attrs: { user_group_id: 'userGroupId1' }, expected: 'userGroupId1' },
  { type: 'aws_elasticache_serverless_cache', attrs: { name: 'my_cluster' }, expected: 'my_cluster' },
  byId('aws_efs_file_system', 'fs-6fa144c6'),
  byId('aws_efs_mount_target', 'fsmt-52a643fb'),
  byId('aws_efs_access_point', 'fsap-52a643fb'),
  { type: 'aws_opensearch_domain', attrs: { domain_name: 'search-prod' }, expected: 'search-prod' },
  {
    type: 'aws_msk_cluster',
    attrs: { arn: 'arn:aws:kafka:us-west-2:123456789012:cluster/example/279c0212-3' },
    expected: 'arn:aws:kafka:us-west-2:123456789012:cluster/example/279c0212-3',
  },
  {
    type: 'aws_redshift_cluster',
    attrs: { cluster_identifier: 'tf-redshift-cluster-12345' },
    expected: 'tf-redshift-cluster-12345',
  },
  byId('aws_mq_broker', 'a1b2c3d4-d5f6-7777-8888-9999aaaabbbbcccc'),
  { type: 'aws_dynamodb_table', attrs: { id: 'GameScores', name: 'GameScores' }, expected: 'GameScores' },
  {
    // The key *values* are not attributes of their own — they live inside the
    // `item` JSON, keyed by the attribute names in `hash_key` / `range_key`.
    type: 'aws_dynamodb_table_item',
    attrs: {
      table_name: 'example-name',
      hash_key: 'exampleHashKey',
      range_key: 'exampleRangeKey',
      item: '{"exampleHashKey":{"S":"something"},"exampleRangeKey":{"S":"something-else"}}',
    },
    expected: 'example-name,something,something-else',
  },
  { type: 'aws_neptune_cluster', attrs: { cluster_identifier: 'my-cluster' }, expected: 'my-cluster' },
  { type: 'aws_docdb_cluster', attrs: { cluster_identifier: 'docdb-prod-cluster' }, expected: 'docdb-prod-cluster' },
  { type: 'aws_memorydb_cluster', attrs: { name: 'my-cluster' }, expected: 'my-cluster' },
  byId('aws_transfer_server', 's-12345678'),
  byId('aws_elastic_beanstalk_environment', 'e-rpqsewtp2j'),
  byId('aws_emr_cluster', 'j-123456ABCDEF'),

  // ── keys, certificates, secrets ──────────────────────────────────────────
  byId('aws_kms_key', '1234abcd-12ab-34cd-56ef-1234567890ab'),
  { type: 'aws_kms_alias', attrs: { name: 'alias/my-key-alias' }, expected: 'alias/my-key-alias' },
  {
    type: 'aws_acm_certificate',
    attrs: { arn: 'arn:aws:acm:eu-central-1:123456789012:certificate/7e7a28d2' },
    expected: 'arn:aws:acm:eu-central-1:123456789012:certificate/7e7a28d2',
  },
  {
    type: 'aws_secretsmanager_secret',
    attrs: { arn: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:example-123456' },
    expected: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:example-123456',
  },
  {
    // Pipe, not slash or comma.
    type: 'aws_secretsmanager_secret_version',
    attrs: {
      secret_id: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:example-123456',
      version_id: 'xxxxx-xxxxxxx-xxxxxxx-xxxxx',
    },
    expected: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:example-123456|xxxxx-xxxxxxx-xxxxxxx-xxxxx',
  },

  // ── logs, events, messaging ──────────────────────────────────────────────
  { type: 'aws_cloudwatch_log_group', attrs: { id: '/aws/lambda/worker', name: '/aws/lambda/worker' }, expected: '/aws/lambda/worker' },
  { type: 'aws_cloudwatch_metric_alarm', attrs: { alarm_name: 'alarm-12345' }, expected: 'alarm-12345' },
  { type: 'aws_cloudwatch_event_bus', attrs: { name: 'example-event-bus' }, expected: 'example-event-bus' },
  {
    type: 'aws_cloudwatch_event_rule',
    attrs: { event_bus_name: 'example-event-bus', name: 'capture-console-sign-in' },
    expected: 'example-event-bus/capture-console-sign-in',
  },
  {
    type: 'aws_cloudwatch_event_target',
    attrs: { event_bus_name: 'default', rule: 'rule-name', target_id: 'target-id' },
    expected: 'default/rule-name/target-id',
  },
  {
    type: 'aws_sns_topic',
    attrs: { arn: 'arn:aws:sns:us-west-2:123456789012:my-topic' },
    expected: 'arn:aws:sns:us-west-2:123456789012:my-topic',
  },
  {
    type: 'aws_sns_topic_subscription',
    attrs: { arn: 'arn:aws:sns:us-west-2:123456789012:my-topic:8a21d249-4329' },
    expected: 'arn:aws:sns:us-west-2:123456789012:my-topic:8a21d249-4329',
  },
  {
    // The queue URL, never the ARN — and on this path the state id happens to
    // be the URL too, which is the trap the whole package exists to close.
    type: 'aws_sqs_queue',
    attrs: {
      id: 'https://sqs.eu-west-1.amazonaws.com/111122223333/orders',
      url: 'https://sqs.eu-west-1.amazonaws.com/111122223333/orders',
      arn: 'arn:aws:sqs:eu-west-1:111122223333:orders',
    },
    expected: 'https://sqs.eu-west-1.amazonaws.com/111122223333/orders',
  },
  {
    type: 'aws_sqs_queue_policy',
    attrs: { queue_url: 'https://sqs.eu-west-1.amazonaws.com/111122223333/orders' },
    expected: 'https://sqs.eu-west-1.amazonaws.com/111122223333/orders',
  },
  {
    type: 'aws_sfn_state_machine',
    attrs: { arn: 'arn:aws:states:eu-west-1:123456789098:stateMachine:bar' },
    expected: 'arn:aws:states:eu-west-1:123456789098:stateMachine:bar',
  },
  { type: 'aws_kinesis_stream', attrs: { name: 'example-stream' }, expected: 'example-stream' },
  {
    type: 'aws_kinesis_firehose_delivery_stream',
    attrs: { arn: 'arn:aws:firehose:us-east-1:123456789012:deliverystream/example' },
    expected: 'arn:aws:firehose:us-east-1:123456789012:deliverystream/example',
  },

  // ── analytics and integration ────────────────────────────────────────────
  {
    type: 'aws_glue_catalog_database',
    attrs: { catalog_id: '123456789012', name: 'my_database' },
    expected: '123456789012:my_database',
  },
  {
    type: 'aws_glue_catalog_table',
    attrs: { catalog_id: '123456789012', database_name: 'MyDatabase', name: 'MyTable' },
    expected: '123456789012:MyDatabase:MyTable',
  },
  { type: 'aws_glue_job', attrs: { name: 'example' }, expected: 'example' },
  { type: 'aws_glue_crawler', attrs: { name: 'MyJob' }, expected: 'MyJob' },
  { type: 'aws_dms_endpoint', attrs: { endpoint_id: 'test-dms-endpoint-tf' }, expected: 'test-dms-endpoint-tf' },
  {
    type: 'aws_datasync_task',
    attrs: { arn: 'arn:aws:datasync:us-east-1:123456789012:task/task-12345678901234567' },
    expected: 'arn:aws:datasync:us-east-1:123456789012:task/task-12345678901234567',
  },

  // ── identity and directory ───────────────────────────────────────────────
  byId('aws_cognito_user_pool', 'us-west-2_abc123'),
  {
    type: 'aws_cognito_user_pool_client',
    attrs: { user_pool_id: 'us-west-2_abc123', id: '3ho4ek12345678909nh3fmhpko' },
    expected: 'us-west-2_abc123/3ho4ek12345678909nh3fmhpko',
  },
  { type: 'aws_cognito_user_pool_domain', attrs: { domain: 'auth.example.org' }, expected: 'auth.example.org' },
  byId('aws_cognito_identity_pool', 'us-west-2:1a234567-8901-234b-5cde-f6789g01h2i3'),
  byId('aws_directory_service_directory', 'd-926724cf57'),

  // ── sharing, governance, security posture ────────────────────────────────
  {
    type: 'aws_ram_resource_share',
    attrs: { arn: 'arn:aws:ram:eu-west-1:123456789012:resource-share/73da1ab9' },
    expected: 'arn:aws:ram:eu-west-1:123456789012:resource-share/73da1ab9',
  },
  {
    type: 'aws_ram_resource_association',
    attrs: {
      resource_share_arn: 'arn:aws:ram:eu-west-1:123456789012:resource-share/73da1ab9',
      resource_arn: 'arn:aws:ec2:eu-west-1:123456789012:subnet/subnet-12345678',
    },
    expected:
      'arn:aws:ram:eu-west-1:123456789012:resource-share/73da1ab9,' +
      'arn:aws:ec2:eu-west-1:123456789012:subnet/subnet-12345678',
  },
  {
    type: 'aws_ram_principal_association',
    attrs: {
      resource_share_arn: 'arn:aws:ram:eu-west-1:123456789012:resource-share/73da1ab9',
      principal: '123456789012',
    },
    expected: 'arn:aws:ram:eu-west-1:123456789012:resource-share/73da1ab9,123456789012',
  },
  { type: 'aws_config_config_rule', attrs: { name: 'example' }, expected: 'example' },
  { type: 'aws_config_configuration_recorder', attrs: { name: 'example' }, expected: 'example' },
  {
    type: 'aws_cloudtrail',
    attrs: { arn: 'arn:aws:cloudtrail:us-east-1:123456789012:trail/my-sample-trail' },
    expected: 'arn:aws:cloudtrail:us-east-1:123456789012:trail/my-sample-trail',
  },
  byId('aws_guardduty_detector', '00b00fd5aecc0ab60a708659477e9617'),
  { type: 'aws_backup_vault', attrs: { name: 'TestVault' }, expected: 'TestVault' },
  byId('aws_backup_plan', 'abc123'),
  {
    // Pipe-separated, and the second half is the selection's own id.
    type: 'aws_backup_selection',
    attrs: { plan_id: 'abcd1234', id: 'efgh5678' },
    expected: 'abcd1234|efgh5678',
  },
  byId('aws_securityhub_account', '123456789012'),
  { type: 'aws_accessanalyzer_analyzer', attrs: { analyzer_name: 'example' }, expected: 'example' },
  byId('aws_macie2_account', 'abcd1'),
];

/** Types the provider publishes no import for. Blocks are still emitted. */
const NOT_IMPORTABLE: readonly string[] = [
  'aws_autoscaling_attachment',
  'aws_iam_group_membership',
  'aws_vpn_connection_route',
  'aws_vpn_gateway_attachment',
];

const byTypeInModule = new Map(RULES.map((rule) => [rule.type, rule]));

test('every fromState resolver produces the documented import id', () => {
  const wrong: string[] = [];
  for (const testCase of CASES) {
    const rule = byTypeInModule.get(testCase.type);
    if (rule?.fromState === undefined) {
      wrong.push(`${testCase.type}: no fromState registered`);
      continue;
    }
    const actual = rule.fromState(testCase.attrs);
    if (actual !== testCase.expected) {
      wrong.push(`${testCase.type}\n  expected ${JSON.stringify(testCase.expected)}\n  actual   ${JSON.stringify(actual)}`);
    }
  }
  assert.deepEqual(wrong, []);
});

test('the case table covers every resolver, and every rule is one or the other', () => {
  const covered = new Set(CASES.map((c) => c.type));
  assert.equal(covered.size, CASES.length, 'duplicate type in the case table');

  const resolvers = RULES.filter((r) => r.notImportable === undefined).map((r) => r.type);
  assert.deepEqual(
    resolvers.filter((type) => !covered.has(type)),
    [],
    'resolver with no case — add one rather than trusting it',
  );
  assert.deepEqual(
    [...covered].filter((type) => !byTypeInModule.has(type)),
    [],
    'case for a type this module no longer registers',
  );
  assert.deepEqual(
    RULES.filter((r) => r.notImportable !== undefined)
      .map((r) => r.type)
      .sort(),
    [...NOT_IMPORTABLE].sort(),
  );
  // Every rule cites the page its format came from — the doc field is not
  // decoration, it is how the next person re-verifies without guessing.
  assert.deepEqual(
    RULES.filter((r) => r.doc === undefined).map((r) => r.type),
    [],
  );
});

test('a Route 53 record with an empty name keeps its double underscore', () => {
  // r/route53_record: "If the record name is the empty string, it can be
  // omitted". `str()` rejects '' and would silently drop the part, so this is
  // the case the module's `text()` helper exists for.
  const apex = ruleForType('aws_route53_record')?.fromState?.({
    id: 'Z4KAPRWWNC7JR__NS',
    zone_id: 'Z4KAPRWWNC7JR',
    name: '',
    type: 'NS',
    ttl: 172800,
  });
  assert.equal(apex, 'Z4KAPRWWNC7JR__NS');
});

test('the ECS cluster name is derived from the cluster ARN, or from the service ARN', () => {
  const rule = ruleForType('aws_ecs_service')?.fromState;
  assert.ok(rule !== undefined);

  // The real-state shape: `cluster` holds the cluster ARN, not the name.
  assert.equal(
    rule({ name: 'web', cluster: 'arn:aws:ecs:eu-west-1:111122223333:cluster/prod-cluster' }),
    'prod-cluster/web',
  );
  // A hand-written config may set the bare name; it must survive untouched.
  assert.equal(rule({ name: 'web', cluster: 'prod-cluster' }), 'prod-cluster/web');
  // `cluster` is Optional, so fall back to the long-form service ARN.
  assert.equal(
    rule({ name: 'web', arn: 'arn:aws:ecs:eu-west-1:111122223333:service/prod-cluster/web' }),
    'prod-cluster/web',
  );
  // The pre-2019 short-form ARN names no cluster. Guessing `default` here would
  // import the wrong service or none; `undefined` earns an honest `# VERIFY`.
  assert.equal(rule({ name: 'web', arn: 'arn:aws:ecs:eu-west-1:111122223333:service/web' }), undefined);
});

test('composite resolvers refuse to fall back to the state id', () => {
  // Each of these has a state id that is a *different string*, so a partial
  // composition must yield undefined rather than the id. This is the assertion
  // that stops a future "fall back to id, it usually works" edit.
  const cases: ReadonlyArray<[string, StateAttributes]> = [
    ['aws_route', { id: 'r-rtb-656C65616E6F721080289494', route_table_id: 'rtb-656C65616E6F72' }],
    ['aws_security_group_rule', { id: 'sgrule-1859128000', security_group_id: 'sg-6e616f6d69', type: 'ingress' }],
    ['aws_ecs_service', { id: 'arn:aws:ecs:eu-west-1:111122223333:service/prod-cluster/web' }],
    ['aws_wafv2_web_acl', { id: 'a1b2c3d4', name: 'edge-acl' }],
    ['aws_route53_record', { id: 'Z4KAPRWWNC7JR__NS', zone_id: 'Z4KAPRWWNC7JR' }],
    ['aws_iam_role_policy_attachment', { id: 'app-task/arn:aws:iam::1:policy/p', role: 'app-task' }],
    ['aws_network_acl_rule', { id: 'nacl-rule', network_acl_id: 'acl-7aaabd18', rule_number: 100 }],
  ];
  for (const [type, attrs] of cases) {
    assert.equal(ruleForType(type)?.fromState?.(attrs), undefined, type);
  }
});

test('a security group rule keeps every source, in a parseable order', () => {
  const rule = ruleForType('aws_security_group_rule')?.fromState;
  assert.ok(rule !== undefined);
  // The provider's importer classifies each trailing token by content, so
  // ordering is free; what must not happen is a source being dropped.
  assert.equal(
    rule({
      security_group_id: 'sg-4973616163',
      type: 'ingress',
      protocol: 'tcp',
      from_port: 100,
      to_port: 121,
      cidr_blocks: ['10.1.0.0/16', '10.2.0.0/16'],
      ipv6_cidr_blocks: ['2001:db8::/48', '2002:db8::/48'],
    }),
    'sg-4973616163_ingress_tcp_100_121_10.1.0.0/16_10.2.0.0/16_2001:db8::/48_2002:db8::/48',
  );
  // `from_port: 0` and `self: true` are meaningful values, not absences.
  assert.equal(
    rule({
      security_group_id: 'sg-656c65616e6f72',
      type: 'egress',
      protocol: 'all',
      from_port: 0,
      to_port: 0,
      cidr_blocks: [],
      self: true,
    }),
    'sg-656c65616e6f72_egress_all_0_0_self',
  );
  // A rule with no source at all cannot be expressed — "all parts are required".
  assert.equal(
    rule({
      security_group_id: 'sg-1',
      type: 'egress',
      protocol: 'all',
      from_port: 0,
      to_port: 0,
      cidr_blocks: [],
    }),
    undefined,
  );
});

test('not-importable types are flagged, not left to the generic fallback', () => {
  for (const type of NOT_IMPORTABLE) {
    const rule = ruleForType(type);
    assert.ok(rule !== undefined, `${type} has no rule at all`);
    assert.ok(
      rule.notImportable !== undefined && rule.notImportable.length > 20,
      `${type} needs a reason a user can act on`,
    );
    assert.equal(rule.fromState, undefined, `${type} cannot be both`);

    // Decision 5: the block is still emitted, loudly, so a state move does not
    // lose the resource. Losing it silently is the worse failure.
    const resolved = resolveStateResource({
      address: `${type}.example`,
      type,
      attributes: { id: 'some-id' },
    });
    assert.equal(resolved.id, 'some-id');
    assert.equal(resolved.verified, false);
    assert.ok(resolved.comments.some((c) => c.startsWith(`NOT IMPORTABLE: ${type} —`)));
  }
});

test('aws_s3_object stays ruleless — the golden file depends on it', () => {
  // awkward.expected.tf asserts the `# VERIFY` fallback *and* decision 9's
  // `${`/quote escaping through this one type. Registering a rule for it here
  // (or in scanned-network.ts / scanned-workload.ts) invalidates a fixture no
  // package owns after WP-A.
  assert.equal(byTypeInModule.get('aws_s3_object'), undefined);
  assert.equal(ruleForType('aws_s3_object'), undefined);
});

test('the registry serves this module rules, not a colliding declaration', () => {
  // `registry.ts` merges by type and the first declaration of a field wins, so
  // a `fromState` declared in scanned-network.ts or scanned-workload.ts would
  // silently shadow the one asserted above. That is a boundary violation, and
  // this is where it surfaces by name rather than as a mystery in the golden.
  const mine = new Set(RULES.map((r) => r.type));
  assert.deepEqual(
    CONFLICTS.filter((c) => c.field === 'fromState' && mine.has(c.type)).map((c) => c.type),
    [],
  );

  const shadowed: string[] = [];
  for (const testCase of CASES) {
    if (ruleForType(testCase.type)?.fromState?.(testCase.attrs) !== testCase.expected) {
      shadowed.push(testCase.type);
    }
  }
  assert.deepEqual(shadowed, []);
});
