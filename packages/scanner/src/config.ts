import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { DEFAULT_CONFIG_FILENAME, type AtlasConfig } from '@atlas/schema';

export interface ResolvedConfig extends Required<Omit<AtlasConfig, 'accounts'>> {
  accounts: AtlasConfig['accounts'];
  /** Absolute path of the directory containing the config file (or cwd). */
  rootDir: string;
}

const DEFAULTS = {
  emptyRegions: 'exclude' as const,
  regionConcurrency: 4,
  outDir: 'data',
  annotationsDir: 'annotations',
};

/**
 * Where the user actually invoked the tool from. npm workspace scripts run
 * with cwd set to the PACKAGE directory (packages/scanner), which is never
 * where atlas.config.json or the repo-root data/site directories live —
 * npm records the original directory in INIT_CWD.
 */
function invocationDir(): string {
  return process.env['INIT_CWD'] ?? process.cwd();
}

/** Walk up from `start` looking for atlas.config.json. */
function findConfigUpwards(start: string): string | undefined {
  let dir = path.resolve(start);
  for (;;) {
    const candidate = path.join(dir, DEFAULT_CONFIG_FILENAME);
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * Load atlas.config.json. CLI --profile flags override the account list so
 * the tool works with zero config for a quick single-account scan.
 */
export async function loadConfig(opts: {
  configPath?: string;
  profiles?: string[];
  regions?: string[];
}): Promise<ResolvedConfig> {
  const configPath = opts.configPath
    ? path.resolve(invocationDir(), opts.configPath)
    : findConfigUpwards(invocationDir());

  let fileConfig: AtlasConfig | undefined;
  if (configPath && existsSync(configPath)) {
    fileConfig = JSON.parse(await readFile(configPath, 'utf8')) as AtlasConfig;
    if (fileConfig.accounts !== undefined && !Array.isArray(fileConfig.accounts)) {
      throw new Error(`${configPath}: "accounts" must be an array of { profile, … } objects`);
    }
  } else if (opts.configPath) {
    throw new Error(`Config file not found: ${opts.configPath}`);
  }

  let accounts = fileConfig?.accounts ?? [];
  if (opts.profiles && opts.profiles.length > 0) {
    accounts = opts.profiles.map((profile) => {
      // Keep per-account settings from the config file when the profile matches.
      const fromFile = fileConfig?.accounts?.find((a) => a.profile === profile);
      return fromFile ?? { profile };
    });
  }
  if (accounts.length === 0) {
    accounts = [{ profile: process.env['AWS_PROFILE'] ?? 'default' }];
  }
  if (opts.regions && opts.regions.length > 0) {
    accounts = accounts.map((a) => ({ ...a, regions: opts.regions }));
  }

  return {
    accounts,
    emptyRegions: fileConfig?.emptyRegions ?? DEFAULTS.emptyRegions,
    regionConcurrency: fileConfig?.regionConcurrency ?? DEFAULTS.regionConcurrency,
    outDir: fileConfig?.outDir ?? DEFAULTS.outDir,
    annotationsDir: fileConfig?.annotationsDir ?? DEFAULTS.annotationsDir,
    rootDir: configPath ? path.dirname(configPath) : invocationDir(),
  };
}
