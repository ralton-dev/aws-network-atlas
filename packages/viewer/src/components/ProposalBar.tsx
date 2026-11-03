import type { Proposal } from '@atlas/proposal';

/**
 * Which side of an active proposal the canvas draws (decision 50). The union
 * is laid out once; the mode only hides: *current* hides `added`, *proposed*
 * hides `removed`, *both* hides neither.
 */
export type ProposalMode = 'current' | 'proposed' | 'both';

const MODES: readonly { mode: ProposalMode; label: string; title: string }[] = [
  { mode: 'current', label: 'Current', title: 'The estate as scanned: hide what the proposal adds' },
  { mode: 'proposed', label: 'Proposed', title: 'The estate after the proposal: hide what it removes' },
  { mode: 'both', label: 'Both', title: 'Everything: added, removed and changed, each marked' },
];

export interface ProposalBarProps {
  /** Every loaded proposal, in the order the select lists them (`loadProposals()`). */
  proposals: readonly Proposal[];
  /**
   * The active proposal's `id`, or `undefined` for none. An id that names no
   * proposal in `proposals` renders as none.
   */
  activeId: string | undefined;
  /** Meaningful only while a proposal is active; the toggle is not drawn otherwise. */
  mode: ProposalMode;
  /**
   * The active proposal's `base.generatedAt` differs from the loaded
   * snapshot's (decision 46). The badge shows the proposal's base date; the
   * caller decides staleness, the bar only draws it.
   */
  stale: boolean;
  /** The select changed: a proposal's id, or `undefined` for `none`. */
  onSelect(id: string | undefined): void;
  onMode(mode: ProposalMode): void;
}

/**
 * The proposal strip under the toolbar: pick a proposal, pick which side of it
 * to draw, and read what the colours mean. Pure presentational — it holds no
 * state and reads no globals; the caller owns the active id, the mode and the
 * URL (decision 51). The caller mounts it only when `proposals` is non-empty.
 */
export function ProposalBar({
  proposals,
  activeId,
  mode,
  stale,
  onSelect,
  onMode,
}: ProposalBarProps): React.ReactElement {
  const active = activeId === undefined ? undefined : proposals.find((p) => p.id === activeId);

  return (
    <div className={active ? 'proposal-bar is-active' : 'proposal-bar'}>
      <label className="proposal-pick">
        <span className="proposal-pick-label">Proposal</span>
        <select
          value={active?.id ?? ''}
          onChange={(e) => onSelect(e.target.value === '' ? undefined : e.target.value)}
        >
          <option value="">none</option>
          {proposals.map((p) => (
            <option key={p.id} value={p.id}>
              {p.id}
            </option>
          ))}
        </select>
      </label>
      {active && (
        <>
          <span className="proposal-title" title={active.description ?? active.title}>
            {active.title}
          </span>
          {stale && (
            <span
              className="proposal-stale"
              title="This proposal was designed against a different scan. It is still drawn; check it against what is scanned now."
            >
              stale · base {new Date(active.base.generatedAt).toLocaleString()}
            </span>
          )}
          <div className="proposal-toggle" role="group" aria-label="Draw">
            {MODES.map((m) => (
              <button
                key={m.mode}
                type="button"
                className={m.mode === mode ? 'is-active' : ''}
                aria-pressed={m.mode === mode}
                title={m.title}
                onClick={() => onMode(m.mode)}
              >
                {m.label}
              </button>
            ))}
          </div>
          <div className="proposal-legend" aria-label="Legend">
            <span className="proposal-legend-item">
              <span className="proposal-swatch is-added" /> proposed
            </span>
            <span className="proposal-legend-item">
              <span className="proposal-swatch is-removed" /> to remove
            </span>
            <span className="proposal-legend-item">
              <span className="proposal-swatch is-changed" /> changed
            </span>
          </div>
        </>
      )}
    </div>
  );
}
