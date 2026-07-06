import { useMemo } from 'react';
import type { AtlasIndex, ResourceRef } from '../data.js';

const MAX_ITEMS_PER_GROUP = 100;

export interface InventoryPanelProps {
  index: AtlasIndex;
  onSelect(ref: ResourceRef): void;
}

interface Group {
  key: string;
  label: string;
  refs: ResourceRef[];
}

/**
 * Full inventory ("everything" scope): every scanned resource grouped by
 * account → region → service, including off-diagram resources from the
 * generic tagging sweep.
 */
export function InventoryPanel({ index, onSelect }: InventoryPanelProps): React.ReactElement {
  const byAccount = useMemo(() => {
    const accounts = new Map<string, Map<string, Map<string, Group>>>();
    for (const ref of index.all) {
      const service =
        ref.kind === 'generic' ? `${(ref.raw['service'] as string) ?? 'unknown'}` : ref.kind;
      const regionKey = ref.region || 'global';
      let regions = accounts.get(ref.accountId);
      if (!regions) accounts.set(ref.accountId, (regions = new Map()));
      let groups = regions.get(regionKey);
      if (!groups) regions.set(regionKey, (groups = new Map()));
      let group = groups.get(service);
      if (!group) groups.set(service, (group = { key: service, label: service, refs: [] }));
      group.refs.push(ref);
    }
    return accounts;
  }, [index]);

  return (
    <aside className="inventory-panel">
      <h2>Inventory</h2>
      {[...byAccount.entries()].map(([accountId, regions]) => (
        <details key={accountId} open={byAccount.size === 1}>
          <summary>
            {index.accountLabel(accountId)}
            <span className="count">
              {[...regions.values()].reduce(
                (n, groups) => n + [...groups.values()].reduce((m, g) => m + g.refs.length, 0),
                0,
              )}
            </span>
          </summary>
          {[...regions.entries()]
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([region, groups]) => (
              <details key={region} className="inventory-region">
                <summary>
                  {region}
                  <span className="count">
                    {[...groups.values()].reduce((m, g) => m + g.refs.length, 0)}
                  </span>
                </summary>
                {[...groups.values()]
                  .sort((a, b) => b.refs.length - a.refs.length || a.label.localeCompare(b.label))
                  .map((group) => (
                    <details key={group.key} className="inventory-service">
                      <summary>
                        {group.label}
                        <span className="count">{group.refs.length}</span>
                      </summary>
                      <ul>
                        {group.refs.slice(0, MAX_ITEMS_PER_GROUP).map((ref) => (
                          <li key={`${ref.kind}:${ref.id}`}>
                            <button className="inventory-item" onClick={() => onSelect(ref)}>
                              {ref.name ?? ref.id}
                            </button>
                          </li>
                        ))}
                        {group.refs.length > MAX_ITEMS_PER_GROUP && (
                          <li className="muted">
                            +{group.refs.length - MAX_ITEMS_PER_GROUP} more — use search
                          </li>
                        )}
                      </ul>
                    </details>
                  ))}
              </details>
            ))}
        </details>
      ))}
    </aside>
  );
}
