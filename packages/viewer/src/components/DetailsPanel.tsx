import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { ScanError } from '@atlas/schema';
import type { AtlasIndex, ResourceRef } from '../data.js';
import type { AtlasEdgeData } from '../model/graph-types.js';
import { iconFor } from '../icons.js';

export type Selection =
  | { type: 'resource'; ref: ResourceRef }
  | { type: 'edge'; id: string; data: AtlasEdgeData }
  | { type: 'container'; id: string; label: string; errors: ScanError[] };

const HIDDEN_KEYS = new Set(['id', 'arn', 'name', 'tags', 'raw']);

function PropertyValue({ value }: { value: unknown }): React.ReactElement {
  if (value === null || value === undefined) return <em>—</em>;
  if (typeof value === 'boolean') return <>{value ? 'yes' : 'no'}</>;
  if (typeof value === 'string' || typeof value === 'number') return <>{String(value)}</>;
  if (Array.isArray(value)) {
    if (value.length === 0) return <em>none</em>;
    if (value.every((v) => typeof v === 'string' || typeof v === 'number')) {
      return <>{value.join(', ')}</>;
    }
    return (
      <details>
        <summary>{value.length} item(s)</summary>
        <pre>{JSON.stringify(value, null, 2)}</pre>
      </details>
    );
  }
  return (
    <details>
      <summary>object</summary>
      <pre>{JSON.stringify(value, null, 2)}</pre>
    </details>
  );
}

function annotationHint(ref: ResourceRef): string {
  const key = ref.arn ?? ref.id;
  return `# annotations/my-notes.yaml
"${key}":
  description: |
    What this ${ref.kind} is for…
  links:
    - label: Terraform
      url: ../terraform/${ref.kind}.tf`;
}

export interface DetailsPanelProps {
  index: AtlasIndex;
  selection: Selection;
  onClose(): void;
  onOpenVpc(vpcId: string): void;
  /** Open the focus view: this resource plus everything connected to it. */
  onFocus?(ref: ResourceRef): void;
  onSelectRef(ref: ResourceRef): void;
  /** Hide this resource's node on the diagram (declutter). */
  onHide?(ref: ResourceRef): void;
}

export function DetailsPanel({ index, selection, onClose, onOpenVpc, onFocus, onSelectRef, onHide }: DetailsPanelProps): React.ReactElement {
  if (selection.type === 'container') {
    const { label, errors } = selection;
    return (
      <aside className="details-panel">
        <header>
          <h2>{label}</h2>
          <button className="close-btn" onClick={onClose}>×</button>
        </header>
        <div className="details-meta">
          <span className="badge badge-warning">⚠ scan had errors</span>
        </div>
        <p className="scan-error-note muted">
          This scan hit {errors.length} error{errors.length === 1 ? '' : 's'}, so the
          data shown here may be incomplete. Grant the read permission for each API
          call below and re-scan to fill the gaps.
        </p>
        <h3>Scan errors ({errors.length})</h3>
        <ul className="scan-errors">
          {errors.map((e, i) => (
            <li key={i}>
              <code>{e.service} · {e.operation}</code>
              <p>{e.message}</p>
            </li>
          ))}
        </ul>
      </aside>
    );
  }
  if (selection.type === 'edge') {
    const { data } = selection;
    const underlying = data.refId ? index.byKey.get(data.refId) : undefined;
    return (
      <aside className="details-panel">
        <header>
          <h2>{data.title ?? 'Connection'}</h2>
          <button className="close-btn" onClick={onClose}>×</button>
        </header>
        {underlying && (
          <button className="link-btn" onClick={() => onSelectRef(underlying)}>
            View {underlying.kind} {underlying.name ?? underlying.id}
          </button>
        )}
        {data.routes && data.routes.length > 0 ? (
          <>
            <h3>{data.columns ? 'Rules' : 'Routes'}</h3>
            <table className="kv-table routes-table">
              <thead>
                <tr>
                  <th>{data.columns?.[0] ?? 'From'}</th>
                  <th>{data.columns?.[1] ?? 'Destination'}</th>
                  <th>{data.columns?.[2] ?? 'State'}</th>
                </tr>
              </thead>
              <tbody>
                {data.routes.map((r, i) => (
                  <tr key={i} className={r.state === 'blackhole' ? 'is-blackhole' : ''}>
                    <td>{r.from}</td>
                    <td><code>{r.dest}</code></td>
                    <td>{[r.state, r.routeType].filter(Boolean).join(' · ') || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        ) : (
          <p className="muted">No route details recorded for this connection.</p>
        )}
      </aside>
    );
  }

  const { ref } = selection;
  const Icon = iconFor(ref.kind);
  const annotation = index.annotationFor(ref);
  const tags = (ref.raw['tags'] ?? {}) as Record<string, string>;
  const properties = Object.entries(ref.raw).filter(
    ([k, v]) => !HIDDEN_KEYS.has(k) && v !== undefined,
  );

  return (
    <aside className="details-panel">
      <header>
        {Icon && <Icon width={28} height={28} />}
        <h2>{ref.name ?? ref.id}</h2>
        <button className="close-btn" onClick={onClose}>×</button>
      </header>
      <div className="details-meta">
        <span className={`kind-chip kind-${ref.kind}`}>{ref.kind}</span>
        <span>{index.accountLabel(ref.accountId)}</span>
        {ref.region && <span>{ref.region}</span>}
      </div>
      {ref.kind === 'vpc' && (
        <button className="link-btn" onClick={() => onOpenVpc(ref.id)}>Open VPC diagram →</button>
      )}
      {ref.vpcId && ref.kind !== 'vpc' && (
        <button className="link-btn" onClick={() => onOpenVpc(ref.vpcId!)}>
          Open VPC diagram ({ref.vpcId}) →
        </button>
      )}
      {onFocus && (
        <button
          className="link-btn"
          onClick={() => onFocus(ref)}
          title="Open a view scoped to this resource and everything connected to it"
        >
          Focus on connections →
        </button>
      )}
      {onHide && (
        <button
          className="link-btn hide-btn"
          onClick={() => onHide(ref)}
          title="Hide this node on the diagram (Layers → Show all to restore)"
        >
          Hide from diagram
        </button>
      )}

      {annotation && (
        <section className="annotation">
          <h3>{annotation.title ?? 'Notes'}</h3>
          {annotation.description && (
            <div className="annotation-body">
              <Markdown remarkPlugins={[remarkGfm]}>{annotation.description}</Markdown>
            </div>
          )}
          {annotation.links && annotation.links.length > 0 && (
            <ul className="annotation-links">
              {annotation.links.map((l) => (
                <li key={l.url}>
                  <a href={l.url} target="_blank" rel="noreferrer">{l.label}</a>
                </li>
              ))}
            </ul>
          )}
          {annotation.labels && annotation.labels.length > 0 && (
            <div className="resource-badges">
              {annotation.labels.map((label) => (
                <span key={label} className="badge">{label}</span>
              ))}
            </div>
          )}
        </section>
      )}

      <h3>Identifiers</h3>
      <table className="kv-table">
        <tbody>
          <tr><th>id</th><td><code>{ref.id}</code></td></tr>
          {ref.arn && <tr><th>arn</th><td><code className="arn">{ref.arn}</code></td></tr>}
        </tbody>
      </table>

      {properties.length > 0 && (
        <>
          <h3>Properties</h3>
          <table className="kv-table">
            <tbody>
              {properties.map(([k, v]) => (
                <tr key={k}>
                  <th>{k}</th>
                  <td><PropertyValue value={v} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {Object.keys(tags).length > 0 && (
        <>
          <h3>Tags</h3>
          <table className="kv-table">
            <tbody>
              {Object.entries(tags).map(([k, v]) => (
                <tr key={k}><th>{k}</th><td>{v}</td></tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {!annotation && (
        <section className="annotation-hint">
          <h3>Add a note</h3>
          <p className="muted">Create a committable annotation for this resource:</p>
          <pre>{annotationHint(ref)}</pre>
          <p className="muted">then run <code>npm run bundle</code> (or any scan).</p>
        </section>
      )}
    </aside>
  );
}
