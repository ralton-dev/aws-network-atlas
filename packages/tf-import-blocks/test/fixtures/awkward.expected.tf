## The specification, hand-written. This is what `importsFromState` must emit
## for awkward.tfstate.json once the rule tables are filled. Do not adjust it to
## match the code — adjust the code.
##
## Lines beginning with `##` are annotations for the reader and are STRIPPED
## before comparison (see golden.test.ts / stripAnnotations). Everything else,
## including blank lines, is compared byte for byte. Provider doc pages are
## `website/docs/r/<type>.html.markdown` in hashicorp/terraform-provider-aws on
## `main`, read 2026-08-07.
##
## Absent from this file, and that is the assertion:
##   - the deposed aws_nat_gateway instance (nat-0deadbeef…) — one address, one block
##   - data.aws_ami.ubuntu and random_password.db  (decision 11)
##
## The `# account … · region …` line (decision 10) appears only where the
## resource's `arn` attribute disclosed both. A raw state carries no provider
## configuration, so for aws_route, aws_route53_record, aws_security_group_rule,
## aws_nat_gateway, aws_s3_bucket and aws_s3_object there is genuinely nothing
## to say and the line is omitted rather than filled with "unknown".
##
## r/db_instance — "import DB Instances using the `identifier`"
# account 111122223333 · region eu-west-1
import {
  to = aws_db_instance.core
  id = "core-db"
}

## r/ecs_service — id = "cluster-name/service-name". The state id is the service
## ARN (ecs/service.go: SetId(Service.ServiceArn)), and the `cluster` attribute
## is the cluster ARN, so both halves need deriving.
# account 111122223333 · region eu-west-1
import {
  to = aws_ecs_service.web
  id = "prod-cluster/web"
}

## r/iam_role_policy_attachment — "the role name and policy arn separated by `/`"
import {
  to = aws_iam_role_policy_attachment.app
  id = "app-task/arn:aws:iam::111122223333:policy/app-read"
}

## r/lambda_function — "import Lambda Functions using the `function_name`"
# account 111122223333 · region eu-west-1
import {
  to = aws_lambda_function.worker
  id = "orders-worker"
}

## r/nat_gateway — "import NAT Gateways using the `id`". Count index preserved,
## and the deposed sibling at the same index_key produces no second block.
import {
  to = aws_nat_gateway.ngw[0]
  id = "nat-05dba92075d71c408"
}

## r/route — "import individual routes using `ROUTETABLEID_DESTINATION`". The
## state id is the provider's synthetic `r-<rtb><hashcode>` (ec2/id.go:
## routeCreateID) and is never a valid import id.
import {
  to = aws_route.default
  id = "rtb-656C65616E6F72_0.0.0.0/0"
}

## r/route53_record — "If the record name is the empty string, it can be
## omitted", giving the double underscore.
import {
  to = aws_route53_record.ns
  id = "Z4KAPRWWNC7JR__NS"
}

## r/route53_record — "If the record also contains a set identifier, append it"
import {
  to = aws_route53_record.www
  id = "Z4KAPRWWNC7JR_www.example.com_A_blue"
}

## r/s3_bucket — "import S3 bucket using the `bucket`". The ARN discloses
## neither account nor region, hence no context comment.
import {
  to = aws_s3_bucket.assets
  id = "acme-assets-eu-west-1"
}

## The no-rule case (decision 5): emitted with the state id and flagged, never
## dropped. It is also the escaping case (decision 9) — the key contains both a
## double quote and `${`, so the emitted string must contain \" and $${.
## KEEP IT RULELESS: registering aws_s3_object in any rule module changes this
## block and this file has no owner after WP-A.
# VERIFY: no rule for aws_s3_object — import id may not be the state id
import {
  to = aws_s3_object.weird
  id = "acme-assets-eu-west-1/reports/\"q1\"/$${env}/summary.txt"
}

## r/security_group_rule — `security_group_id`, `type`, `protocol`, `from_port`,
## `to_port` and the source(s), underscore-separated; all parts required. The
## state id is the provider's `sgrule-<hashcode>` and is never importable.
import {
  to = aws_security_group_rule.web_ingress
  id = "sg-6e616f6d69_ingress_tcp_8000_8000_10.0.3.0/24"
}

## r/sqs_queue — "import SQS Queues using the queue `url`". Here the state id
## happens to be the URL too (sqs/queue.go: SetId(QueueUrl)); it is the *scanned*
## path that stores the ARN and gets this wrong. See awkward.scanned.json.
# account 111122223333 · region eu-west-1
import {
  to = aws_sqs_queue.orders
  id = "https://sqs.eu-west-1.amazonaws.com/111122223333/orders"
}

## r/vpc — the control row. The native id really is the import id; if this block
## ever moves, something fundamental broke.
# account 111122223333 · region eu-west-1
import {
  to = aws_vpc.main
  id = "vpc-0a1b2c3d4e5f60718"
}

## r/wafv2_web_acl — "import WAFv2 Web ACLs using `ID/Name/Scope`". Scope comes
## from the resource, not from whether the region is empty.
# account 111122223333 · region eu-west-1
import {
  to = aws_wafv2_web_acl.edge
  id = "a1b2c3d4-d5f6-7777-8888-9999aaaabbbbcccc/edge-acl/REGIONAL"
}

## r/subnet — "import subnets using the subnet `id`". Quoted for_each key under
## a module, address preserved verbatim.
# account 111122223333 · region eu-west-1
import {
  to = module.net.aws_subnet.private["eu-west-1a"]
  id = "subnet-0aa11bb22cc33dd44"
}
