import { fromNodeProviderChain } from '@aws-sdk/credential-providers';
import { loadSharedConfigFiles } from '@smithy/shared-ini-file-loader';
import type { AwsCredentialIdentityProvider } from '@aws-sdk/types';
import type { ScanError } from '@atlas/schema';

/**
 * The region used for account-level calls (STS/IAM/Route53/S3/DX and region
 * discovery). Hardcoding us-east-1 would break GovCloud/China profiles, so
 * prefer the profile's own configured region.
 */
export async function resolveHomeRegion(profile: string): Promise<string> {
  try {
    const { configFile } = await loadSharedConfigFiles();
    return process.env['AWS_REGION'] ?? configFile[profile]?.['region'] ?? 'us-east-1';
  } catch {
    return 'us-east-1';
  }
}

/** Anything that looks like an AWS SDK v3 client constructor. */
type ClientCtor<C> = new (config: {
  region: string;
  credentials: AwsCredentialIdentityProvider;
  retryMode: string;
  maxAttempts: number;
}) => C;

/**
 * Per-account context: shared credential provider plus a client cache so each
 * (service, region) pair constructs exactly one client.
 */
export class AwsContext {
  readonly profile: string;
  readonly homeRegion: string;
  readonly credentials: AwsCredentialIdentityProvider;
  private readonly cache = new Map<string, unknown>();

  constructor(profile: string, homeRegion = 'us-east-1') {
    this.profile = profile;
    this.homeRegion = homeRegion;
    // The node provider chain resolves static keys, SSO sessions, process
    // credentials, and assumed roles from ~/.aws/config for the profile.
    this.credentials = fromNodeProviderChain({ profile });
  }

  client<C>(Ctor: ClientCtor<C>, region: string): C {
    const key = `${Ctor.name}:${region}`;
    let client = this.cache.get(key) as C | undefined;
    if (!client) {
      client = new Ctor({
        region,
        credentials: this.credentials,
        // Adaptive mode client-side rate-limits after throttling responses —
        // important when fanning out Describe* calls across many regions.
        retryMode: 'adaptive',
        maxAttempts: 8,
      });
      this.cache.set(key, client);
    }
    return client;
  }
}

/**
 * Run a collector step, converting failures into recorded ScanErrors instead
 * of aborting the scan (partial permissions are normal with read-only roles).
 */
export async function guard(
  errors: ScanError[],
  service: string,
  operation: string,
  fn: () => Promise<void>,
): Promise<void> {
  try {
    await fn();
  } catch (err) {
    const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    errors.push({ service, operation, message });
  }
}
