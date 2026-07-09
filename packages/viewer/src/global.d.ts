import type { Snapshot, AnnotationMap, TerraformStackFile } from '@atlas/schema';

declare global {
  interface Window {
    /** Injected by site/data/data.js (scanner-generated, classic script). */
    __ATLAS_DATA__?: Snapshot;
    /** Injected by site/data/annotations.js (scanner-generated). */
    __ATLAS_ANNOTATIONS__?: AnnotationMap;
    /** Injected by site/data/terraform.js (written by atlas-scan tf-import). */
    __ATLAS_TERRAFORM__?: TerraformStackFile[];
  }
}

declare module 'elkjs/lib/elk.bundled.js' {
  import ELK from 'elkjs';
  export * from 'elkjs';
  export default ELK;
}

export {};
