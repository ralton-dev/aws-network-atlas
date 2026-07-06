/**
 * User-authored annotations, kept in committable sidecar files under
 * annotations/*.yaml. Keys are resource ARNs or AWS-native IDs (vpc-…,
 * subnet-…, i-…). The bundler merges every annotations file into the
 * viewer data bundle, so editing an annotation never requires a re-scan.
 */

export interface AnnotationLink {
  label: string;
  /** Any URL: https://…, or a relative repo path to e.g. Terraform code. */
  url: string;
}

export interface Annotation {
  /** Optional display title override. */
  title?: string;
  /** Markdown description shown in the resource details panel. */
  description?: string;
  links?: AnnotationLink[];
  /** Free-form labels, searchable alongside names/tags. */
  labels?: string[];
}

/** Shape of each annotations/*.yaml file. */
export interface AnnotationsFile {
  annotations: Record<string, Annotation>;
}

/** Merged map keyed by ARN or resource id. */
export type AnnotationMap = Record<string, Annotation>;
