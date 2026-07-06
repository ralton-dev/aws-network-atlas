import type { Snapshot, AnnotationMap } from '@atlas/schema';

declare global {
  interface Window {
    /** Injected by site/data/data.js (scanner-generated, classic script). */
    __ATLAS_DATA__?: Snapshot;
    /** Injected by site/data/annotations.js (scanner-generated). */
    __ATLAS_ANNOTATIONS__?: AnnotationMap;
  }
}

declare module 'elkjs/lib/elk.bundled.js' {
  import ELK from 'elkjs';
  export * from 'elkjs';
  export default ELK;
}

export {};
