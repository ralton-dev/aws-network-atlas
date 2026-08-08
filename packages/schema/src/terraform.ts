/**
 * Terraform state mappings, kept in committable sidecar files under
 * data/terraform/<stack>.json — one file per state file imported via
 * `atlas-scan tf-import`. Only resource IDENTIFIERS (address, type, id, arn,
 * importId) are ever extracted; raw state attributes frequently contain secrets
 * and must never land in this repo.
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
  /**
   * The type's **documented import id**, when it differs from `id`.
   *
   * An identifier, which is why it may travel: it is what `terraform import`
   * and an `import` block take, computed from the state by the type's rule in
   * `tf-import-blocks`. It is here because it is the only key a *nested*
   * resource has on both sides. `aws_security_group_rule`'s state `id` is
   * `sgrule-<hash>` and `aws_route`'s is `r-<rtb><hash>` — provider-synthesised
   * strings that correspond to nothing AWS returns — while the scanner keeps
   * those relationships inside their parent, where they have no id at all.
   * Both sides can derive this one, so it is the only way to tell a managed
   * nested resource from an unmanaged one.
   *
   * It composes attribute values (a rule's id ends in its CIDRs); it is not a
   * channel for them. Nothing that is not itself an import id may follow it —
   * see decision 6 of `TERRAFORM-IMPORT-BLOCKS.md`.
   *
   * **Optional, and absent is not "no import id".** A sidecar written before
   * this field existed simply lacks it, and so does any resource whose import
   * id is its `id`. A reader must treat absent as *cannot tell* and degrade to
   * a safe answer, never as *unmanaged*.
   */
  importId?: string;
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
