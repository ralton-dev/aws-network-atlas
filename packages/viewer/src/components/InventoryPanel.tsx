import { useMemo } from 'react';
import type { AtlasIndex, ResourceRef } from '../data.js';

const MAX_ITEMS_PER_GROUP = 100;

export interface InventoryPanelProps {
  index: AtlasIndex;
  onSelect(ref: ResourceRef): void;
  /** Accounts currently drawn in the overview. Absent = no picker is shown. */
  selectedAccounts?: ReadonlySet<string>;
  /** Eye toggle on an account's summary line: flip that account in or out. */
  onToggleAccount?(accountId: string): void;
  /** Header *show all*: select every scanned account. */
  onSelectAllAccounts?(): void;
  /** Header *show none*: clear the selection (the overview goes empty). */
  onSelectNoAccounts?(): void;
}

type Regions = Map<string, Map<string, Group>>;
const NO_REGIONS: Regions = new Map();

/** Open eye when shown, struck-through eye when not. Decorative: the button carries the label. */
function EyeIcon({ open }: { open: boolean }): React.ReactElement {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z" />
      <circle cx="12" cy="12" r="3" />
      {!open && <line x1="3" y1="3" x2="21" y2="21" />}
    </svg>
  );
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
export function InventoryPanel({
  index,
  onSelect,
  selectedAccounts,
  onToggleAccount,
  onSelectAllAccounts,
  onSelectNoAccounts,
}: InventoryPanelProps): React.ReactElement {
  const byAccount = useMemo(() => {
    const accounts = new Map<string, Regions>();
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

  // The picker is on only when WP-3 hands us a selection. Then every scanned
  // account is listed (snapshot order), including one with no resources, so
  // it can still be switched on and the "n of m" count agrees with the list.
  const picker = selectedAccounts !== undefined;
  const accountIds = picker
    ? index.snapshot.accounts.map((a) => a.accountId)
    : [...byAccount.keys()];
  const shownCount = picker ? accountIds.filter((id) => selectedAccounts.has(id)).length : 0;

  return (
    <aside className="inventory-panel">
      <h2>Inventory</h2>
      {picker && (
        <div className="inventory-selection">
          <span className="inventory-selection-count">
            {shownCount} of {accountIds.length} shown
          </span>
          <button
            type="button"
            onClick={onSelectAllAccounts}
            disabled={shownCount === accountIds.length}
          >
            show all
          </button>
          <button type="button" onClick={onSelectNoAccounts} disabled={shownCount === 0}>
            show none
          </button>
        </div>
      )}
      {accountIds.map((accountId) => {
        const regions = byAccount.get(accountId) ?? NO_REGIONS;
        return (
          <details key={accountId} open={byAccount.size === 1}>
            <summary>
              {picker && (
                <button
                  type="button"
                  className="inventory-eye"
                  aria-pressed={selectedAccounts.has(accountId)}
                  aria-label={`Show ${index.accountLabel(accountId)} in overview`}
                  title={
                    selectedAccounts.has(accountId) ? 'Hide from overview' : 'Show in overview'
                  }
                  onClick={(event) => {
                    // The button sits inside <summary>: without this the click
                    // would also open/close the account's <details>.
                    event.preventDefault();
                    event.stopPropagation();
                    onToggleAccount?.(accountId);
                  }}
                >
                  <EyeIcon open={selectedAccounts.has(accountId)} />
                </button>
              )}
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
        );
      })}
    </aside>
  );
}
