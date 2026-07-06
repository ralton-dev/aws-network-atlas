/**
 * atlas.config.json — checked-in scanner configuration.
 */

export interface AccountConfig {
  /** AWS config/credentials profile name (from ~/.aws/config). */
  profile: string;
  /** Optional display name shown in the diagram (defaults to IAM alias or account id). */
  name?: string;
  /**
   * Regions to scan. Omit to auto-discover all enabled regions
   * (EC2 DescribeRegions).
   */
  regions?: string[];
  /** Regions to skip even when auto-discovered. */
  excludeRegions?: string[];
}

export interface AtlasConfig {
  accounts: AccountConfig[];
  /**
   * How to treat regions where nothing interesting was found:
   * "exclude" drops them from the snapshot entirely (listed in emptyRegions);
   * "annotate" keeps them with empty: true so the viewer can show them greyed out.
   */
  emptyRegions?: 'exclude' | 'annotate';
  /** Max concurrent regions scanned per account (default 4). */
  regionConcurrency?: number;
  /** Output directory for snapshots, relative to the config file (default "data"). */
  outDir?: string;
  /** Annotations directory, relative to the config file (default "annotations"). */
  annotationsDir?: string;
}

export const DEFAULT_CONFIG_FILENAME = 'atlas.config.json';
