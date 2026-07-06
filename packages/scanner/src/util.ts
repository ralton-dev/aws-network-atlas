import type { Tags } from '@atlas/schema';

/** AWS SDK tag list -> plain record. */
export function toTags(tagList?: Array<{ Key?: string; Value?: string }>): Tags {
  const tags: Tags = {};
  for (const t of tagList ?? []) {
    if (t.Key !== undefined) tags[t.Key] = t.Value ?? '';
  }
  return tags;
}

/** The Name tag, if set and non-empty. */
export function nameTag(tags: Tags): string | undefined {
  const name = tags['Name'];
  return name && name.trim() !== '' ? name : undefined;
}

export interface ParsedArn {
  partition: string;
  service: string;
  region: string;
  accountId: string;
  /** Everything after the account id, e.g. "function:my-fn" or "table/users". */
  resource: string;
  /** Best-effort resource type, e.g. "function", "table"; "" when the ARN has no type segment. */
  resourceType: string;
  /** Best-effort resource name/id (last path segment). */
  resourceName: string;
}

export function parseArn(arn: string): ParsedArn | undefined {
  // arn:partition:service:region:account-id:resource
  const parts = arn.split(':');
  if (parts.length < 6 || parts[0] !== 'arn') return undefined;
  const resource = parts.slice(5).join(':');
  let resourceType = '';
  let resourceName = resource;
  const colonIdx = resource.indexOf(':');
  const slashIdx = resource.indexOf('/');
  if (slashIdx !== -1 && (colonIdx === -1 || slashIdx < colonIdx)) {
    resourceType = resource.slice(0, slashIdx);
    resourceName = resource.slice(slashIdx + 1);
  } else if (colonIdx !== -1) {
    resourceType = resource.slice(0, colonIdx);
    resourceName = resource.slice(colonIdx + 1);
  }
  // For nested paths keep the last segment as the display name.
  const lastSlash = resourceName.lastIndexOf('/');
  const displayName = lastSlash !== -1 ? resourceName.slice(lastSlash + 1) : resourceName;
  return {
    partition: parts[1] ?? '',
    service: parts[2] ?? '',
    region: parts[3] ?? '',
    accountId: parts[4] ?? '',
    resource,
    resourceType,
    resourceName: displayName,
  };
}

/** Sort an array of resources by id in place and return it. */
export function sortById<T extends { id: string }>(items: T[]): T[] {
  return items.sort((a, b) => a.id.localeCompare(b.id));
}
