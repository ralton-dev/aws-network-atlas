/**
 * Terraform state mappings, kept in committable sidecar files under
 * data/terraform/<stack>.json — one file per state file imported via
 * `atlas-scan tf-import`. Only resource IDENTIFIERS (address, type, id, arn)
 * are ever extracted; raw state attributes frequently contain secrets and
 * must never land in this repo.
 */

/** One managed AWS resource instance extracted from a Terraform state. */
export interface TerraformResourceInstance {
  /** Full resource address: `module.networking.aws_vpc.main["eu"]`. */
  address: string;
  /** Terraform resource type: `aws_vpc`. */
  type: string;
  /** The provider's `id` attribute — matches the scanner's AWS-native id. */
  id?: string;
  /** The `arn` attribute, when the resource has one. */
  arn?: string;
}

/** Shape of each data/terraform/<stack>.json file. */
export interface TerraformStackFile {
  version: 1;
  /** Stack name, e.g. "prod-network" — unique across imported states. */
  stack: string;
  /** Repo/project the Terraform code lives in: URL or `org/repo` slug. */
  repo: string;
  /** Where the state was read from (file path, S3 URI…) — provenance only. */
  source?: string;
  importedAt: string;
  terraformVersion?: string;
  /** State serial + lineage, to tell whether a re-import actually changed. */
  serial?: number;
  lineage?: string;
  resources: TerraformResourceInstance[];
}

/** A scanned resource ↔ Terraform instance match, as shown in the viewer. */
export interface TerraformBinding {
  stack: string;
  repo: string;
  address: string;
  type: string;
}
