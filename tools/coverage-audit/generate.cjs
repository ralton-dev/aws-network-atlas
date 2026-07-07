#!/usr/bin/env node
/**
 * Full-estate coverage audit generator.
 *
 * Produces docs/coverage.html: every AWS resource type that can be created
 * (the CloudFormation resource registry — the authoritative "what exists"
 * spine) measured against what this tool COLLECTS and what it DRAWS.
 *
 * This is deliberately measured against the WHOLE registry, not a
 * self-selected "networking surface" — so nothing can hide by being declared
 * out of scope. (~93% of AWS resource types have no dedicated collector; this
 * page is the honest source of truth for that.)
 *
 * SELF-CHECKING: the collected-tier inputs are cross-checked against the real
 * source at build time. If a collector is added or removed from the schema, or
 * the Cloud Control sweep list changes, without the matching audit input being
 * updated, generation FAILS with a clear message rather than silently going
 * stale. That is what keeps this page trustworthy over time.
 *
 * Usage:  node tools/coverage-audit/generate.js   (or: npm run coverage)
 */
'use strict';
const fs = require('fs');
const path = require('path');
const https = require('https');
const zlib = require('zlib');

const ROOT = path.resolve(__dirname, '..', '..');
const CACHE = path.join(__dirname, '.cache');
const SPEC_URL = 'https://d1uauaxba7bl26.cloudfront.net/latest/gzip/CloudFormationResourceSpecification.json';
const SPEC_PATH = path.join(CACHE, 'cfn-spec.json');
const OUT_HTML = path.join(ROOT, 'docs', 'coverage.html');
const DISPLAY_MAP_PATH = path.join(__dirname, 'display-map.json');
const SCHEMA_PATH = path.join(ROOT, 'packages', 'schema', 'src', 'snapshot.ts');
const CLOUDCONTROL_PATH = path.join(ROOT, 'packages', 'scanner', 'src', 'collect', 'cloudcontrol.ts');

function die(msg) { console.error('\n[coverage-audit] ERROR: ' + msg + '\n'); process.exit(1); }

// ---------------------------------------------------------------------------
// 1. The CloudFormation resource registry (column 1 — the universe)
// ---------------------------------------------------------------------------
async function loadSpec() {
  if (fs.existsSync(SPEC_PATH)) return JSON.parse(fs.readFileSync(SPEC_PATH, 'utf8'));
  fs.mkdirSync(CACHE, { recursive: true });
  console.log('[coverage-audit] downloading CloudFormation resource specification…');
  const gz = await new Promise((resolve, reject) => {
    https.get(SPEC_URL, (res) => {
      if (res.statusCode !== 200) return reject(new Error('HTTP ' + res.statusCode));
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    }).on('error', reject);
  });
  const json = zlib.gunzipSync(gz).toString('utf8');
  fs.writeFileSync(SPEC_PATH, json);
  return JSON.parse(json);
}

// ---------------------------------------------------------------------------
// 2. What the scanner actually collects (column 2)
// ---------------------------------------------------------------------------

// Detailed collectors: CFN type -> { field: schema collection, attrs: summary }.
// `field` is cross-checked against the real schema below; if you add a
// collector, add its type(s) here (and a display-map.json entry) or the build
// fails.
const DETAILED = {
  'AWS::EC2::VPC': { field: 'vpcs', attrs: 'cidrBlocks, ipv6, isDefault, state, dhcpOptionsId, enableDnsSupport, enableDnsHostnames, tags' },
  'AWS::EC2::Subnet': { field: 'subnets', attrs: 'vpcId, cidr, ipv6, AZ, availableIpCount, mapPublicIp, routeTableId, isPublic' },
  'AWS::EC2::RouteTable': { field: 'routeTables', attrs: 'vpcId, isMain, subnet+gateway assocs, full routes[]' },
  'AWS::EC2::Route': { field: 'routeTables', attrs: 'captured inside routeTables.routes[]' },
  'AWS::EC2::SubnetRouteTableAssociation': { field: 'routeTables', attrs: 'captured as routeTables.subnetAssociations' },
  'AWS::EC2::InternetGateway': { field: 'internetGateways', attrs: 'vpcIds' },
  'AWS::EC2::VPCGatewayAttachment': { field: 'internetGateways', attrs: 'captured as igw/vgw vpc attachment' },
  'AWS::EC2::EgressOnlyInternetGateway': { field: 'egressOnlyInternetGateways', attrs: 'vpcId' },
  'AWS::EC2::NatGateway': { field: 'natGateways', attrs: 'vpcId, subnetId, connectivityType, state, addresses' },
  'AWS::EC2::EIP': { field: 'elasticIps', attrs: 'publicIp, privateIp, instanceId, eniId, associationId' },
  'AWS::EC2::EIPAssociation': { field: 'elasticIps', attrs: 'captured as elasticIps.associationId' },
  'AWS::EC2::NetworkAcl': { field: 'networkAcls', attrs: 'vpcId, isDefault, subnetIds, full entries[]' },
  'AWS::EC2::NetworkAclEntry': { field: 'networkAcls', attrs: 'captured inside networkAcls.entries[]' },
  'AWS::EC2::SecurityGroup': { field: 'securityGroups', attrs: 'vpcId, description, full ingress[]+egress[] rules' },
  'AWS::EC2::SecurityGroupIngress': { field: 'securityGroups', attrs: 'captured inside securityGroups.ingress[]' },
  'AWS::EC2::SecurityGroupEgress': { field: 'securityGroups', attrs: 'captured inside securityGroups.egress[]' },
  'AWS::EC2::NetworkInterface': { field: 'networkInterfaces', attrs: 'vpcId, subnetId, AZ, type, privateIps, publicIp, sgIds, attachedTo, requesterId' },
  'AWS::EC2::VPCEndpoint': { field: 'vpcEndpoints', attrs: 'serviceName, type, subnetIds, routeTableIds, eniIds, privateDns, policyDocument' },
  'AWS::EC2::VPCEndpointService': { field: 'vpcEndpointServices', attrs: 'serviceName, NLB/GWLB arns, allowedPrincipals, connections' },
  'AWS::EC2::PrefixList': { field: 'prefixLists', attrs: 'cidrs, ownerId, maxEntries' },
  'AWS::EC2::FlowLog': { field: 'flowLogs', attrs: 'resourceId, trafficType, destType, destination, status, aggInterval' },
  'AWS::EC2::DHCPOptions': { field: 'dhcpOptions', attrs: 'options map, vpcIds' },
  'AWS::EC2::InstanceConnectEndpoint': { field: 'instanceConnectEndpoints', attrs: 'vpcId, subnetId, sgIds, preserveClientIp' },
  'AWS::EC2::VPCPeeringConnection': { field: 'peeringConnections', attrs: 'requester+accepter (vpc/acct/region/cidrs), status' },
  'AWS::EC2::TransitGateway': { field: 'transitGateways', attrs: 'ownerId, state, asn, default assoc/propagation RT ids' },
  'AWS::EC2::TransitGatewayAttachment': { field: 'transitGatewayAttachments', attrs: 'tgwId, resourceType, resourceId, subnetIds, peer' },
  'AWS::EC2::TransitGatewayVpcAttachment': { field: 'transitGatewayAttachments', attrs: 'captured as transitGatewayAttachments (vpc)' },
  'AWS::EC2::TransitGatewayPeeringAttachment': { field: 'transitGatewayAttachments', attrs: 'captured as transitGatewayAttachments (peering)' },
  'AWS::EC2::TransitGatewayRouteTable': { field: 'transitGatewayRouteTables', attrs: 'tgwId, routes[], associations, propagations' },
  'AWS::EC2::TransitGatewayConnect': { field: 'transitGatewayConnectPeers', attrs: 'attachment captured via connect peers' },
  'AWS::EC2::TransitGatewayConnectPeer': { field: 'transitGatewayConnectPeers', attrs: 'attachmentId, insideCidrs, peerAddress, bgpAsn' },
  'AWS::EC2::VPNGateway': { field: 'vpnGateways', attrs: 'vpcIds, asn, state' },
  'AWS::EC2::CustomerGateway': { field: 'customerGateways', attrs: 'ipAddress, bgpAsn, state' },
  'AWS::EC2::VPNConnection': { field: 'vpnConnections', attrs: 'vgw/tgw/cgw ids, tunnels, staticRoutes, cidrs' },
  'AWS::EC2::ClientVpnEndpoint': { field: 'clientVpnEndpoints', attrs: 'clientCidr, dnsServers, sgIds, subnets, splitTunnel, routes, authRules' },
  'AWS::DirectConnect::Connection': { field: 'dxConnections', attrs: 'location, bandwidth, vlan, partnerName, lagId, ownerAccount' },
  'AWS::DirectConnect::Lag': { field: 'dxLags', attrs: 'location, bandwidth, connectionIds, state, ownerAccount' },
  'AWS::DirectConnect::DirectConnectGateway': { field: 'directConnectGateways', attrs: 'ownerAccount, asn, state, associations (VGW/TGW)' },
  'AWS::DirectConnect::DirectConnectGatewayAssociation': { field: 'directConnectGateways', attrs: 'captured inside directConnectGateways.associations[]' },
  'AWS::DirectConnect::PrivateVirtualInterface': { field: 'dxVirtualInterfaces', attrs: 'vifType, vlan, bgpAsn, gateway ids, addresses, routeFilterPrefixes, bgpPeers' },
  'AWS::DirectConnect::PublicVirtualInterface': { field: 'dxVirtualInterfaces', attrs: 'vifType, vlan, bgpAsn, addresses, routeFilterPrefixes, bgpPeers' },
  'AWS::DirectConnect::TransitVirtualInterface': { field: 'dxVirtualInterfaces', attrs: 'vifType, vlan, bgpAsn, dxGatewayId, addresses, bgpPeers' },
  'AWS::ElasticLoadBalancingV2::LoadBalancer': { field: 'loadBalancers', attrs: 'type, scheme, vpc, subnets, AZs, sgIds, dnsName, listeners+rules' },
  'AWS::ElasticLoadBalancing::LoadBalancer': { field: 'loadBalancers', attrs: 'classic ELB: listeners, instanceIds' },
  'AWS::ElasticLoadBalancingV2::TargetGroup': { field: 'targetGroups', attrs: 'protocol, port, vpc, targetType, lbArns, targets+health' },
  'AWS::ElasticLoadBalancingV2::Listener': { field: 'loadBalancers', attrs: 'captured inside loadBalancers.listeners[]' },
  'AWS::ElasticLoadBalancingV2::ListenerRule': { field: 'loadBalancers', attrs: 'captured inside listeners.rules[]' },
  'AWS::EC2::Instance': { field: 'instances', attrs: 'type, state, vpc, subnet, AZ, privateIp, publicIp, sgIds, imageId, launchTime, platform, instanceProfileArn' },
  'AWS::AutoScaling::AutoScalingGroup': { field: 'autoScalingGroups', attrs: 'subnetIds, instanceIds, min/max/desired, targetGroupArns' },
  'AWS::Lambda::Function': { field: 'lambdaFunctions', attrs: 'runtime, roleArn, vpcConfig, functionUrl+authType' },
  'AWS::RDS::DBInstance': { field: 'rdsInstances', attrs: 'engine, class, clusterId, subnets, sgIds, endpoint, multiAz, publiclyAccessible, AZ' },
  'AWS::RDS::DBCluster': { field: 'rdsClusters', attrs: 'engine, members, subnets, sgIds, endpoint, readerEndpoint, multiAz' },
  'AWS::RDS::DBProxy': { field: 'rdsProxies', attrs: 'engineFamily, endpoint, vpc, subnets, sgIds, requireTls' },
  'AWS::ECS::Service': { field: 'ecsServices', attrs: 'cluster, launchType, desired/running, subnets, sgIds, assignPublicIp' },
  'AWS::EKS::Cluster': { field: 'eksClusters', attrs: 'version, endpoint, vpc, subnets, sgIds, public/private access' },
  'AWS::ElastiCache::CacheCluster': { field: 'elastiCacheClusters', attrs: 'engine, nodeType, numNodes, vpc, subnets, sgIds' },
  'AWS::ElastiCache::ReplicationGroup': { field: 'elastiCacheReplicationGroups', attrs: 'status, members, clusterMode, failover, endpoints' },
  'AWS::ElastiCache::ServerlessCache': { field: 'elastiCacheServerlessCaches', attrs: 'engine, status, endpoint, subnets, sgIds' },
  'AWS::EFS::FileSystem': { field: 'efsFileSystems', attrs: 'state, encrypted, perfMode, vpcId, mountTargets(subnet/ip/AZ/sg)' },
  'AWS::OpenSearchService::Domain': { field: 'openSearchDomains', attrs: 'version, endpoint, inVpc, vpc, subnets, sgIds' },
  'AWS::Elasticsearch::Domain': { field: 'openSearchDomains', attrs: 'legacy ES domain (same collector)' },
  'AWS::MSK::Cluster': { field: 'mskClusters', attrs: 'type, state, kafkaVersion, brokerNodes, subnets, sgIds' },
  'AWS::Redshift::Cluster': { field: 'redshiftClusters', attrs: 'nodeType, numNodes, vpc, subnets, sgIds, publiclyAccessible, endpoint, AZ' },
  'AWS::AmazonMQ::Broker': { field: 'mqBrokers', attrs: 'engineType, deploymentMode, publiclyAccessible, subnets, sgIds' },
  'AWS::KMS::Key': { field: 'kmsKeys', attrs: 'aliases, keyManager, state, usage, spec, rotationEnabled, multiRegion' },
  'AWS::CertificateManager::Certificate': { field: 'acmCertificates', attrs: 'domainName, SANs, status, type, inUseBy, notAfter' },
  'AWS::SecretsManager::Secret': { field: 'secrets', attrs: 'METADATA only: description, rotation, dates, kmsKeyId (value never fetched)' },
  'AWS::WAFv2::WebACL': { field: 'wafWebAcls', attrs: 'scope, defaultAction, capacity, rules[], associatedResourceArns' },
  'AWS::WAFv2::IPSet': { field: 'wafIpSets', attrs: 'scope, ipVersion, addresses' },
  'AWS::WAFv2::RuleGroup': { field: 'wafRuleGroups', attrs: 'scope, capacity, rules[]' },
  'AWS::Route53Resolver::ResolverEndpoint': { field: 'resolverEndpoints', attrs: 'direction, vpc, subnets, ipAddresses, sgIds, status' },
  'AWS::Route53Resolver::ResolverRule': { field: 'resolverRules', attrs: 'domainName, ruleType, endpointId, targetIps, vpcAssocs' },
  'AWS::Route53Resolver::ResolverRuleAssociation': { field: 'resolverRules', attrs: 'captured as resolverRules.vpcAssociationIds' },
  'AWS::Route53Resolver::FirewallRuleGroup': { field: 'dnsFirewallRuleGroups', attrs: 'rules[], vpcAssociations, shareStatus' },
  'AWS::Route53Resolver::FirewallRuleGroupAssociation': { field: 'dnsFirewallRuleGroups', attrs: 'captured as vpcAssociations' },
  'AWS::Route53Resolver::ResolverQueryLoggingConfig': { field: 'resolverQueryLogConfigs', attrs: 'destinationArn, status, vpcIds' },
  'AWS::Route53Resolver::ResolverQueryLoggingConfigAssociation': { field: 'resolverQueryLogConfigs', attrs: 'captured as vpcIds' },
  'AWS::NetworkFirewall::Firewall': { field: 'networkFirewalls', attrs: 'vpc, subnets, policyArn, endpoints per-AZ, logDestinations' },
  'AWS::NetworkFirewall::FirewallPolicy': { field: 'networkFirewallPolicies', attrs: 'stateless/stateful default actions, ruleGroupRefs, ruleOrder, tlsConfigArn' },
  'AWS::NetworkFirewall::RuleGroup': { field: 'networkFirewallRuleGroups', attrs: 'type, capacity, stateless+stateful rules, rulesString, domainList' },
  'AWS::NetworkFirewall::TLSInspectionConfiguration': { field: 'networkFirewallTlsConfigs', attrs: 'certificateArns' },
  'AWS::ApiGateway::RestApi': { field: 'apiGateways', attrs: 'protocolType, endpointType, apiEndpoint, stages, vpcEndpointIds' },
  'AWS::ApiGatewayV2::Api': { field: 'apiGateways', attrs: 'HTTP/WS api: protocolType, apiEndpoint, stages' },
  'AWS::ApiGateway::VpcLink': { field: 'apiGatewayVpcLinks', attrs: 'v1: NLB targetArns' },
  'AWS::ApiGatewayV2::VpcLink': { field: 'apiGatewayVpcLinks', attrs: 'v2: subnetIds, sgIds' },
  'AWS::ApiGateway::DomainName': { field: 'apiGatewayDomainNames', attrs: 'domainName, endpointTypes, certs, mappings' },
  'AWS::ApiGatewayV2::DomainName': { field: 'apiGatewayDomainNames', attrs: 'v2 domain name + mappings' },
  'AWS::VpcLattice::ServiceNetwork': { field: 'latticeServiceNetworks', attrs: 'authType, vpcAssociations, serviceAssociations' },
  'AWS::VpcLattice::Service': { field: 'latticeServices', attrs: 'dnsEntry, customDomainName, authType, status' },
  'AWS::Logs::LogGroup': { field: 'logGroups', attrs: 'retentionDays, kmsKeyId, logGroupClass (NOT storedBytes)' },
  'AWS::Cognito::UserPool': { field: 'cognitoUserPools', attrs: 'passwordPolicy, mfaConfiguration, advancedSecurityMode, deletionProtection, domain, identityProviders, appClients (oauth flows/callbacks/idps)' },
  'AWS::Cognito::UserPoolClient': { field: 'cognitoUserPools', attrs: 'captured inside cognitoUserPools.appClients[]' },
  'AWS::Cognito::UserPoolDomain': { field: 'cognitoUserPools', attrs: 'captured as cognitoUserPools.domain' },
  'AWS::Cognito::UserPoolIdentityProvider': { field: 'cognitoUserPools', attrs: 'captured as cognitoUserPools.identityProviders' },
  'AWS::Cognito::IdentityPool': { field: 'cognitoIdentityPools', attrs: 'allowUnauthenticated, cognitoUserPoolProviders, saml/oidc providers, auth/unauth roleArns' },
  'AWS::Cognito::IdentityPoolRoleAttachment': { field: 'cognitoIdentityPools', attrs: 'captured as cognitoIdentityPools auth/unauth roleArns' },
  'AWS::DynamoDB::Table': { field: 'dynamoDbTables', attrs: 'keySchema, billingMode, SSE(KMS), streams, PITR, TTL, globalTableReplicas, deletionProtection' },
  'AWS::DynamoDB::GlobalTable': { field: 'dynamoDbTables', attrs: 'captured as dynamoDbTables.globalTableReplicas (multi-region)' },
  'AWS::ECR::Repository': { field: 'ecrRepositories', attrs: 'uri, imageTagMutability, scanOnPush, encryption(KMS/AES256), repositoryPolicy (cross-account), lifecyclePolicy' },
  'AWS::ECR::RegistryPolicy': { field: 'ecrRegistries', attrs: 'captured as ecrRegistries.registryPolicy' },
  'AWS::ECR::ReplicationConfiguration': { field: 'ecrRegistries', attrs: 'captured as ecrRegistries.replicationRules (cross-region/account image flow)' },
  'AWS::ECR::PullThroughCacheRule': { field: 'ecrRegistries', attrs: 'captured as ecrRegistries.pullThroughCacheRules' },
  'AWS::ECR::RegistryScanningConfiguration': { field: 'ecrRegistries', attrs: 'captured as ecrRegistries.scanningConfiguration' },
  'AWS::SNS::Topic': { field: 'snsTopics', attrs: 'policy (cross-account), kmsMasterKeyId, subscriptions (protocol+endpoint), fifo' },
  'AWS::SNS::Subscription': { field: 'snsTopics', attrs: 'captured inside snsTopics.subscriptions[]' },
  'AWS::SQS::Queue': { field: 'sqsQueues', attrs: 'policy, encryption (KMS/SQS-managed), redrivePolicy/DLQ, visibilityTimeout, fifo' },
  'AWS::SQS::QueuePolicy': { field: 'sqsQueues', attrs: 'captured as sqsQueues.policy' },
  'AWS::Events::EventBus': { field: 'eventBuses', attrs: 'policy (cross-account), rules with event pattern/schedule + target ARNs' },
  'AWS::Events::Rule': { field: 'eventBuses', attrs: 'captured inside eventBuses.rules[]' },
  'AWS::Pipes::Pipe': { field: 'eventBridgePipes', attrs: 'source/enrichment/target ARNs, self-managed-Kafka VPC subnets/SGs' },
  'AWS::Scheduler::Schedule': { field: 'eventBridgeSchedules', attrs: 'schedule expression, target ARN (cross-account), KMS' },
  'AWS::Scheduler::ScheduleGroup': { field: 'eventBridgeSchedules', attrs: 'captured as eventBridgeSchedules.groupName' },
  'AWS::StepFunctions::StateMachine': { field: 'sfnStateMachines', attrs: 'type (STANDARD/EXPRESS), roleArn, logging, tracing, KMS, integration ARNs parsed from ASL definition' },
  'AWS::Glue::Connection': { field: 'glueConnections', attrs: 'connectionType, VPC-attached: subnetId + securityGroupIds + AZ' },
  'AWS::Glue::DevEndpoint': { field: 'glueDevEndpoints', attrs: 'VPC-attached: vpcId/subnetId/securityGroupIds, status' },
  'AWS::Glue::Job': { field: 'glueJobs', attrs: 'glueVersion, workerType, connection refs' },
  'AWS::Glue::Crawler': { field: 'glueCrawlers', attrs: 'state, databaseName' },
  'AWS::Glue::Database': { field: 'glueDatabases', attrs: 'description, locationUri' },
  'AWS::DMS::ReplicationInstance': { field: 'dmsReplicationInstances', attrs: 'VPC-attached: vpc/subnetGroup/subnets/SGs, class, publiclyAccessible, multiAz, KMS, IPs' },
  'AWS::DMS::Endpoint': { field: 'dmsEndpoints', attrs: 'type (source/target), engine, server, port, sslMode, KMS' },
  'AWS::DMS::ReplicationTask': { field: 'dmsReplicationTasks', attrs: 'migrationType, source/target endpoint ARNs, instance ARN' },
  'AWS::DataSync::Agent': { field: 'dataSyncAgents', attrs: 'endpointType, VPC-attached PrivateLink: vpcEndpointId + subnetArns + securityGroupArns' },
  'AWS::DataSync::LocationEFS': { field: 'dataSyncLocations', attrs: 'VPC-attached: subnetArn + securityGroupArns (EFS/FSx)' },
  'AWS::DataSync::LocationS3': { field: 'dataSyncLocations', attrs: 'captured as dataSyncLocations (s3 — no VPC attachment)' },
  'AWS::DataSync::LocationNFS': { field: 'dataSyncLocations', attrs: 'captured as dataSyncLocations' },
  'AWS::DataSync::LocationSMB': { field: 'dataSyncLocations', attrs: 'captured as dataSyncLocations' },
  'AWS::DataSync::LocationFSxWindows': { field: 'dataSyncLocations', attrs: 'VPC-attached: securityGroupArns' },
  'AWS::DataSync::Task': { field: 'dataSyncTasks', attrs: 'source→destination location ARNs, status' },
  'AWS::Route53::HostedZone': { field: 'hostedZones', attrs: 'zoneName, privateZone, recordCount, vpcAssociations, A/AAAA/CNAME records' },
  'AWS::Route53::RecordSet': { field: 'hostedZones', attrs: 'captured inside hostedZones.records[]' },
  'AWS::Route53::RecordSetGroup': { field: 'hostedZones', attrs: 'captured inside hostedZones.records[]' },
  'AWS::S3::Bucket': { field: 's3Buckets', attrs: 'region, creationDate, tags (name-level only; no policy/ACL/encryption)' },
  'AWS::IAM::Role': { field: 'iamRoles', attrs: 'assumeRolePolicy, attachedManagedPolicyArns, inlinePolicyNames, maxSession, lastUsed' },
  'AWS::IAM::User': { field: 'iamUsers', attrs: 'groups, policies, consoleAccess, mfaCount, accessKeyIds, passwordLastUsed' },
  'AWS::IAM::Group': { field: 'iamGroups', attrs: 'policies, userNames' },
  'AWS::IAM::ManagedPolicy': { field: 'iamPolicies', attrs: 'attachmentCount, defaultVersionDocument, description' },
  'AWS::IAM::Policy': { field: 'iamPolicies', attrs: 'inline policy names surfaced on role/user/group' },
  'AWS::IAM::InstanceProfile': { field: 'iamInstanceProfiles', attrs: 'roleNames' },
  'AWS::CloudFront::Distribution': { field: 'cloudFrontDistributions', attrs: 'domainName, aliases, origins+detail, priceClass, webAclId' },
  'AWS::CloudFront::VpcOrigin': { field: 'cloudFrontVpcOrigins', attrs: 'status, endpointArn (private ALB/NLB/EC2)' },
  'AWS::GlobalAccelerator::Accelerator': { field: 'globalAccelerators', attrs: 'dnsName, ipAddresses, listeners+endpointGroups+endpoints' },
  'AWS::NetworkManager::CoreNetwork': { field: 'coreNetworks', attrs: 'globalNetworkId, segments, edges, attachments' },
};

// Extract the schema's real collection field names from the empty*() factories
// in snapshot.ts (each collection appears as `field: [],`). This is the source
// of truth we cross-check the DETAILED map against.
function schemaCollectionFields() {
  const src = fs.readFileSync(SCHEMA_PATH, 'utf8');
  const grab = (fnName) => {
    const start = src.indexOf('function ' + fnName);
    if (start < 0) die('could not find ' + fnName + '() in snapshot.ts — schema layout changed');
    const open = src.indexOf('{', start);
    let depth = 0, end = -1;
    for (let i = open; i < src.length; i++) { if (src[i] === '{') depth++; else if (src[i] === '}') { depth--; if (depth === 0) { end = i; break; } } }
    const body = src.slice(open, end);
    const fields = new Set();
    for (const m of body.matchAll(/(\w+)\s*:\s*\[\s*\]/g)) fields.add(m[1]);
    return fields;
  };
  const all = new Set([...grab('emptyRegionSnapshot'), ...grab('emptyGlobal')]);
  all.delete('errors'); // not a resource collection
  return all;
}

// Extract the Cloud Control untagged-catch sweep list from cloudcontrol.ts.
function cloudControlTypes() {
  const src = fs.readFileSync(CLOUDCONTROL_PATH, 'utf8');
  const start = src.indexOf('const TYPE_NAMES');
  if (start < 0) die('could not find TYPE_NAMES in cloudcontrol.ts — sweep layout changed');
  const end = src.indexOf('] as const', start);
  const block = src.slice(start, end);
  const types = new Set();
  for (const m of block.matchAll(/'(AWS::[^']+)'/g)) types.add(m[1]);
  if (types.size === 0) die('parsed zero Cloud Control TYPE_NAMES — check cloudcontrol.ts');
  return types;
}

function hasTags(def) {
  const p = def.Properties || {};
  return ['Tags', 'TagList', 'TagSet'].some((k) => Object.prototype.hasOwnProperty.call(p, k));
}

// ---------------------------------------------------------------------------
// Drift checks — fail loudly if the audit inputs no longer match the code.
// ---------------------------------------------------------------------------
function verifyInputs(displayMap, schemaFields) {
  const mappedFields = new Set(Object.values(DETAILED).map((d) => d.field));
  const expected = new Set([...schemaFields].filter((f) => f !== 'generic'));
  const missingFromMap = [...expected].filter((f) => !mappedFields.has(f));
  const staleInMap = [...mappedFields].filter((f) => !expected.has(f));
  if (missingFromMap.length)
    die('schema has collection(s) with no DETAILED CFN-type mapping (add them to generate.js):\n   ' + missingFromMap.join(', '));
  if (staleInMap.length)
    die('DETAILED maps field(s) that no longer exist in the schema (remove them):\n   ' + staleInMap.join(', '));
  const missingDisplay = [...mappedFields].filter((f) => !displayMap[f]);
  if (missingDisplay.length)
    die('display-map.json is missing entries for collection(s):\n   ' + missingDisplay.join(', '));
  console.log('[coverage-audit] drift check OK — ' + mappedFields.size + ' collections mapped, all have display classifications');
}

// ---------------------------------------------------------------------------
// 3. Classify every registry type + render
// ---------------------------------------------------------------------------
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function classify(spec, ccTypes) {
  const RT = spec.ResourceTypes || {};
  const rows = [];
  let nDetailed = 0, nCloudControl = 0, nTaggable = 0, nNone = 0;
  for (const type of Object.keys(RT).sort()) {
    const def = RT[type];
    const props = Object.keys(def.Properties || {}).sort();
    const service = type.split('::')[1];
    let tier, field = '', detail = '';
    if (DETAILED[type]) { tier = 'detailed'; field = DETAILED[type].field; detail = DETAILED[type].attrs; nDetailed++; }
    else if (ccTypes.has(type)) { tier = 'cloudcontrol'; detail = 'ARN + name + tags (untagged-catch sweep)'; nCloudControl++; }
    else if (hasTags(def)) { tier = 'taggable'; detail = 'ARN + name + tags — ONLY if tagged (Resource Groups Tagging API sweep)'; nTaggable++; }
    else { tier = 'none'; detail = 'not collected (no dedicated collector; not taggable)'; nNone++; }
    rows.push({ type, service, tier, field, detail, propCount: props.length, props });
  }
  return { rows, summary: { specVersion: spec.ResourceSpecificationVersion, total: rows.length,
    services: new Set(rows.map((r) => r.service)).size, nDetailed, nCloudControl, nTaggable, nNone } };
}

function render(rows, summary, displayMap, generatedAt) {
  const collected = (r) => r.tier === 'detailed' ? { k: 'detailed', t: 'Detailed' }
    : r.tier === 'cloudcontrol' ? { k: 'inv', t: 'Inventory (untagged-catch)' }
    : r.tier === 'taggable' ? { k: 'inv-tag', t: 'Inventory — if tagged' }
    : { k: 'none', t: 'Not collected' };
  const display = (r) => {
    if (r.tier === 'detailed') { const d = displayMap[r.field] || {}; return { k: d.render || 'panel-only', t: d.label || 'panel-only', n: d.note || '' }; }
    if (r.tier === 'cloudcontrol' || r.tier === 'taggable') return { k: 'panel-only', t: 'Inventory panel only — searchable list, never on graph', n: '' };
    return { k: 'none', t: 'Not displayed (not collected)', n: '' };
  };
  const enriched = rows.map((r) => { const c = collected(r), d = display(r); return { ...r, c, d }; });

  const svc = {};
  for (const r of enriched) { (svc[r.service] ??= { detailed: 0, inv: 0, none: 0, total: 0 }); svc[r.service].total++;
    if (r.tier === 'detailed') svc[r.service].detailed++; else if (r.tier === 'none') svc[r.service].none++; else svc[r.service].inv++; }

  const rowHtml = enriched.map((r) => `<tr data-svc="${esc(r.service)}" data-c="${r.c.k}" data-d="${r.d.k}" data-props="${esc(r.props.join(' '))}">
<td class="mono">${esc(r.type)}</td>
<td><span class="badge ${r.c.k}">${esc(r.c.t)}</span>${r.field ? `<div class="sub">&rarr; <code>${esc(r.field)}</code></div>` : ''}<div class="detail">${esc(r.detail)}</div></td>
<td><span class="badge d-${r.d.k}">${esc(r.d.t)}</span>${r.d.n ? `<div class="detail">${esc(r.d.n)}</div>` : ''}</td>
<td class="pc">${r.propCount}<div class="props">${esc(r.props.join(', '))}</div></td></tr>`).join('\n');

  const svcRollup = Object.entries(svc).sort((a, b) => b[1].total - a[1].total).map(([s, v]) => {
    const pct = Math.round((v.detailed / v.total) * 100);
    return `<tr><td class="mono">${esc(s)}</td><td>${v.total}</td><td class="c-detailed">${v.detailed}</td><td class="c-inv">${v.inv}</td><td class="c-none">${v.none}</td>
<td><div class="bar"><span style="width:${pct}%"></span></div><span class="pct">${pct}%</span></td></tr>`;
  }).join('\n');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AWS Full-Estate Coverage Audit</title>
<style>
:root{--bg:#fff;--fg:#1a1c20;--mut:#5b6270;--line:#e4e6ea;--card:#f6f7f9;--accent:#2456c9;
--det:#0a7d33;--det-bg:#e4f5e9;--inv:#8a6d00;--inv-bg:#fbf3d6;--invt:#9a7b10;--invt-bg:#fcf6e0;--non:#b42323;--non-bg:#fbe6e6;
--node:#0a4fb4;--node-bg:#e2ecfb;--edge:#6b3fa0;--edge-bg:#efe6fa;--panel:#54606f;--panel-bg:#e9ebef;}
@media (prefers-color-scheme:dark){:root{--bg:#15171b;--fg:#e7e9ec;--mut:#9aa2b0;--line:#2a2e35;--card:#1d2026;--accent:#6f9bff;
--det:#5fd487;--det-bg:#173a24;--inv:#e6c04a;--inv-bg:#3a2f10;--invt:#d9b64a;--invt-bg:#332b12;--non:#ff8080;--non-bg:#3a1a1a;
--node:#7fb0ff;--node-bg:#152a4d;--edge:#c4a3f0;--edge-bg:#2a1f42;--panel:#aeb6c2;--panel-bg:#282c33;}}
:root[data-theme=dark]{--bg:#15171b;--fg:#e7e9ec;--mut:#9aa2b0;--line:#2a2e35;--card:#1d2026;--accent:#6f9bff;
--det:#5fd487;--det-bg:#173a24;--inv:#e6c04a;--inv-bg:#3a2f10;--invt:#d9b64a;--invt-bg:#332b12;--non:#ff8080;--non-bg:#3a1a1a;
--node:#7fb0ff;--node-bg:#152a4d;--edge:#c4a3f0;--edge-bg:#2a1f42;--panel:#aeb6c2;--panel-bg:#282c33;}
:root[data-theme=light]{--bg:#fff;--fg:#1a1c20;--mut:#5b6270;--line:#e4e6ea;--card:#f6f7f9;--accent:#2456c9;
--det:#0a7d33;--det-bg:#e4f5e9;--inv:#8a6d00;--inv-bg:#fbf3d6;--invt:#9a7b10;--invt-bg:#fcf6e0;--non:#b42323;--non-bg:#fbe6e6;
--node:#0a4fb4;--node-bg:#e2ecfb;--edge:#6b3fa0;--edge-bg:#efe6fa;--panel:#54606f;--panel-bg:#e9ebef;}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}body{margin:0;background:var(--bg)}
.wrap{font:14px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;color:var(--fg);padding:28px 20px 90px;max-width:1500px;margin:0 auto;font-variant-numeric:tabular-nums}
h1{font-size:25px;margin:0 0 4px;letter-spacing:-.01em}.lede{color:var(--mut);margin:0 0 6px;max-width:920px}
.meta{color:var(--mut);font-size:12px;margin:0 0 18px}
.cards{display:flex;gap:12px;flex-wrap:wrap;margin:18px 0}
.kpi{background:var(--card);border:1px solid var(--line);border-radius:11px;padding:13px 18px;min-width:132px}
.kpi .n{font-size:27px;font-weight:700;letter-spacing:-.02em}.kpi .l{color:var(--mut);font-size:11px;text-transform:uppercase;letter-spacing:.05em;margin-top:2px}
.kpi.det .n{color:var(--det)}.kpi.inv .n{color:var(--inv)}.kpi.non .n{color:var(--non)}
h2{font-size:17px;margin:32px 0 10px;border-bottom:1px solid var(--line);padding-bottom:6px}
table{border-collapse:collapse;width:100%;font-size:13px}
th,td{text-align:left;padding:7px 10px;border-bottom:1px solid var(--line);vertical-align:top}
th{position:sticky;top:0;background:var(--bg);z-index:2;font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:var(--mut)}
.mono,code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px}
.badge{display:inline-block;padding:2px 8px;border-radius:20px;font-size:11px;font-weight:600;white-space:nowrap}
.badge.detailed{color:var(--det);background:var(--det-bg)}.badge.inv{color:var(--inv);background:var(--inv-bg)}
.badge.inv-tag{color:var(--invt);background:var(--invt-bg)}.badge.none,.badge.d-none{color:var(--non);background:var(--non-bg)}
.badge.d-node{color:var(--node);background:var(--node-bg)}.badge.d-edge{color:var(--edge);background:var(--edge-bg)}
.badge.d-panel-only{color:var(--panel);background:var(--panel-bg)}
.sub{font-size:11px;color:var(--mut);margin-top:3px}.detail{font-size:11px;color:var(--mut);margin-top:3px;max-width:440px}
.pc{text-align:right;color:var(--mut)}.props{display:none;font-size:10px;color:var(--mut);max-width:360px;text-align:left;margin-top:4px;line-height:1.4}
tr.show-props .props{display:block}
.controls{position:sticky;top:0;background:var(--bg);z-index:5;padding:11px 0;display:flex;gap:8px;flex-wrap:wrap;align-items:center;border-bottom:1px solid var(--line)}
input[type=search]{padding:7px 11px;border:1px solid var(--line);border-radius:8px;background:var(--card);color:var(--fg);min-width:240px;font-size:13px}
select{padding:7px;border:1px solid var(--line);border-radius:8px;background:var(--card);color:var(--fg);font-size:13px}
input:focus-visible,select:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
.count{color:var(--mut);font-size:12px;margin-left:auto;font-weight:600}
.bar{display:inline-block;width:84px;height:8px;background:var(--line);border-radius:4px;overflow:hidden;vertical-align:middle;margin-right:6px}
.bar span{display:block;height:100%;background:var(--det)}.pct{font-size:11px;color:var(--mut)}
.c-detailed{color:var(--det);font-weight:600}.c-inv{color:var(--inv)}.c-none{color:var(--non)}
details.rollup{margin:10px 0}summary{cursor:pointer;font-weight:600}summary:focus-visible{outline:2px solid var(--accent)}
.scroll{overflow-x:auto}
.note{background:var(--card);border-left:3px solid var(--accent);padding:11px 15px;border-radius:0 8px 8px 0;margin:14px 0;font-size:13px;color:var(--mut)}
.note b{color:var(--fg)}
</style>
</head>
<body>
<div class="wrap">
<h1>AWS Full-Estate Coverage Audit</h1>
<p class="lede">Every AWS resource type that can be created &mdash; the CloudFormation resource registry, the authoritative &ldquo;what exists&rdquo; spine &mdash; measured against what this tool <b>collects</b> and what it <b>draws on the diagram</b>. Measured against the <i>whole</i> registry, not a self-selected subset, so nothing hides.</p>
<p class="meta">Generated ${esc(generatedAt)} &middot; CloudFormation spec v${esc(summary.specVersion)} &middot; ${summary.total} resource types &middot; ${summary.services} services. Regenerate with <code>npm run coverage</code>.</p>
<div class="cards">
<div class="kpi"><div class="n">${summary.total}</div><div class="l">Resource types</div></div>
<div class="kpi det"><div class="n">${summary.nDetailed}</div><div class="l">Detailed collectors</div></div>
<div class="kpi inv"><div class="n">${summary.nCloudControl + summary.nTaggable}</div><div class="l">Inventory only</div></div>
<div class="kpi non"><div class="n">${summary.nNone}</div><div class="l">Not collected at all</div></div>
</div>
<div class="note"><b>How to read &ldquo;Collected&rdquo;:</b>
<span class="badge detailed">Detailed</span> = dedicated collector with typed attributes.
<span class="badge inv">Inventory (untagged-catch)</span> = one of the Cloud Control sweep types, caught regardless of tags.
<span class="badge inv-tag">Inventory &mdash; if tagged</span> = caught by the Resource Groups Tagging API <i>only if the resource carries a tag</i>; untagged instances are invisible.
<span class="badge none">Not collected</span> = no collector and not taggable &mdash; never seen.<br>
<b>&ldquo;Displayed&rdquo;:</b> <span class="badge d-node">node</span> = its own box on a graph view &middot; <span class="badge d-edge">edge</span> = only a connecting line/route &middot; <span class="badge d-panel-only">panel-only</span> = searchable list / details pane, never on the graph &middot; <span class="badge d-none">not displayed</span>.</div>

<details class="rollup"><summary>Per-service coverage rollup (${summary.services} services)</summary>
<div class="scroll"><table><thead><tr><th>Service</th><th>Types</th><th>Detailed</th><th>Inventory</th><th>None</th><th>Detailed coverage</th></tr></thead>
<tbody>${svcRollup}</tbody></table></div></details>

<h2>Full resource table</h2>
<div class="controls">
<input type="search" id="q" placeholder="Filter by type or attribute name…" aria-label="Filter">
<select id="fc" aria-label="Filter by collected tier"><option value="">Collected: all</option><option value="detailed">Detailed</option><option value="inv">Inventory (untagged-catch)</option><option value="inv-tag">Inventory — if tagged</option><option value="none">Not collected</option></select>
<select id="fd" aria-label="Filter by displayed tier"><option value="">Displayed: all</option><option value="node">Node on graph</option><option value="edge">Edge only</option><option value="panel-only">Panel only</option><option value="none">Not displayed</option></select>
<label style="font-size:12px;color:var(--mut)"><input type="checkbox" id="pp"> show attributes</label>
<span class="count" id="count"></span>
</div>
<div class="scroll"><table id="t"><thead><tr><th>Resource type</th><th>Collected</th><th>Displayed</th><th>CFN props</th></tr></thead>
<tbody>${rowHtml}</tbody></table></div>
</div>
<script>
const q=document.getElementById('q'),fc=document.getElementById('fc'),fd=document.getElementById('fd'),pp=document.getElementById('pp'),count=document.getElementById('count');
const rows=[...document.querySelectorAll('#t tbody tr')];
function apply(){const s=q.value.trim().toLowerCase(),c=fc.value,d=fd.value;let n=0;
for(const r of rows){const type=r.children[0].textContent.toLowerCase();const props=r.dataset.props.toLowerCase();
const vis=(!s||type.includes(s)||props.includes(s))&&(!c||r.dataset.c===c)&&(!d||r.dataset.d===d);
r.style.display=vis?'':'none';if(vis)n++;}
count.textContent=n+' / '+rows.length+' shown';}
function togglep(){for(const r of rows)r.classList.toggle('show-props',pp.checked);}
q.addEventListener('input',apply);fc.addEventListener('change',apply);fd.addEventListener('change',apply);pp.addEventListener('change',togglep);apply();
</script>
</body>
</html>`;
}

(async () => {
  const spec = await loadSpec();
  const displayMap = JSON.parse(fs.readFileSync(DISPLAY_MAP_PATH, 'utf8'));
  const schemaFields = schemaCollectionFields();
  verifyInputs(displayMap, schemaFields);
  const ccTypes = cloudControlTypes();
  const { rows, summary } = classify(spec, ccTypes);
  const generatedAt = new Date().toISOString().slice(0, 10);
  const html = render(rows, summary, displayMap, generatedAt);
  fs.mkdirSync(path.dirname(OUT_HTML), { recursive: true });
  fs.writeFileSync(OUT_HTML, html);
  console.log(`[coverage-audit] wrote ${path.relative(ROOT, OUT_HTML)} — ${summary.total} types, ` +
    `${summary.nDetailed} detailed / ${summary.nCloudControl + summary.nTaggable} inventory / ${summary.nNone} uncollected`);
})().catch((e) => die(e.stack || e.message));
