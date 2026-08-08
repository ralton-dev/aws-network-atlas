import { useMemo, useRef, useState } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { ScanError } from '@atlas/schema';
import type { AtlasIndex, ResourceRef } from '../data.js';
import type { AtlasEdgeData } from '../model/graph-types.js';
import { AwsLogo, iconFor } from '../icons.js';
import { consoleUrl } from '../console-link.js';
import { copyToClipboard, importBlockFor, type NestedBlock } from '../model/tf-import.js';
import { TerraformMark } from './nodes.js';

export type Selection =
  | { type: 'resource'; ref: ResourceRef }
  | { type: 'edge'; id: string; data: AtlasEdgeData }
  | { type: 'container'; id: string; label: string; errors: ScanError[] };

const HIDDEN_KEYS = new Set(['id', 'arn', 'name', 'tags', 'raw']);

const PANEL_WIDTH_KEY = 'atlas.details-width';
const DEFAULT_PANEL_WIDTH = 460;
const MIN_PANEL_WIDTH = 320;

function clampPanelWidth(w: number): number {
  return Math.min(Math.max(w, MIN_PANEL_WIDTH), Math.round(window.innerWidth * 0.7));
}

function savedPanelWidth(): number {
  // try/catch: localStorage can throw when the bundle runs from file://.
  try {
    const saved = Number(localStorage.getItem(PANEL_WIDTH_KEY));
    if (Number.isFinite(saved) && saved > 0) return clampPanelWidth(saved);
  } catch { /* fall through */ }
  return DEFAULT_PANEL_WIDTH;
}

/** The details sidebar chrome: drag the left edge to resize (double-click resets). */
function PanelShell({ children }: { children: React.ReactNode }): React.ReactElement {
  const [width, setWidth] = useState(savedPanelWidth);
  const drag = useRef<{ startX: number; startWidth: number } | null>(null);

  const persist = (w: number): void => {
    try { localStorage.setItem(PANEL_WIDTH_KEY, String(w)); } catch { /* file:// */ }
  };

  return (
    <aside className="details-panel" style={{ width }}>
      <div
        className="panel-resizer"
        title="Drag to resize · double-click to reset"
        onPointerDown={(e) => {
          e.preventDefault();
          drag.current = { startX: e.clientX, startWidth: width };
          e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          if (!drag.current) return;
          setWidth(clampPanelWidth(drag.current.startWidth + drag.current.startX - e.clientX));
        }}
        onPointerUp={(e) => {
          if (!drag.current) return;
          drag.current = null;
          e.currentTarget.releasePointerCapture(e.pointerId);
          persist(width);
        }}
        onDoubleClick={() => {
          setWidth(DEFAULT_PANEL_WIDTH);
          persist(DEFAULT_PANEL_WIDTH);
        }}
      />
      <div className="panel-scroll">{children}</div>
    </aside>
  );
}

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

/** Render a stack's repo as a link when it looks like one, else plain text. */
function RepoRef({ repo }: { repo: string }): React.ReactElement {
  const href = /^https?:\/\//.test(repo)
    ? repo
    : /^[\w.-]+\.[a-z]{2,}\//i.test(repo) // github.com/org/repo style slug
      ? `https://${repo}`
      : undefined;
  if (!href) return <code>{repo}</code>;
  return <a href={href} target="_blank" rel="noreferrer">{repo}</a>;
}

/**
 * The paste-this block for a resource no imported state claims.
 *
 * Finding drift is only half the job: the panel used to say "not claimed by any
 * imported state" and stop, leaving the reader to work out the Terraform type
 * and the import id themselves — and the import id is *not* the AWS id for a
 * large fraction of the estate (`aws_sqs_queue` wants the queue URL,
 * `aws_ecs_service` wants `cluster/service`). The rule table in
 * `tf-import-blocks` knows the difference; this renders what it says.
 *
 * It also renders what the snapshot keeps *inside* the resource. A security
 * group's rules are not nodes on the graph, so selecting an unmanaged group
 * used to offer an `aws_security_group` block and nothing else — a
 * half-adoption that looks complete, and the defect this panel was reported
 * for. Each nested resource now gets its own block.
 *
 * Nothing is hidden when there is no rule (decision 5): a resource the table
 * cannot type is shown commented out, with the reason, because silently
 * omitting it is how a resource gets forgotten.
 */
function ImportBlock({ subject }: { subject: ResourceRef }): React.ReactElement {
  const block = useMemo(() => importBlockFor(subject), [subject]);
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const { resolved, children, sharedChildComments } = block;
  const total = 1 + children.length;
  const unusable = children.filter((c) => !c.resolved.verified).length;

  const copy = (): void => {
    void copyToClipboard(block.text).then((ok) => {
      setCopyState(ok ? 'copied' : 'failed');
      window.setTimeout(() => setCopyState('idle'), 1800);
    });
  };

  return (
    <div className="tf-import">
      <div className="tf-import-head">
        <span className="tf-import-title">
          {total === 1 ? 'Import block' : `Import blocks (${total})`}
        </span>
        <button
          className={copyState === 'copied' ? 'tf-copy-btn is-copied' : 'tf-copy-btn'}
          onClick={copy}
          title={
            children.length === 0
              ? 'Copy this block to the clipboard'
              : `Copy all ${total} blocks — this resource and its ${children.length} nested resource${children.length === 1 ? '' : 's'}`
          }
        >
          {copyState === 'copied'
            ? 'Copied'
            : copyState === 'failed'
              ? 'Copy failed'
              : total === 1
                ? 'Copy'
                : `Copy all ${total}`}
        </button>
      </div>
      {resolved.type === '' && (
        <p className="tf-import-warn">
          The Terraform resource type for this <code>{subject.kind}</code> could not be
          determined, so the block below is commented out — it cannot be pasted as it stands.
          The block says which half is missing: either no rule covers this kind, or the kind
          spans several provider resources and the scan can't tell which this one is.
        </p>
      )}
      {resolved.type !== '' && !resolved.verified && (
        <p className="tf-import-warn">
          No rule computed an import id for <code>{resolved.type}</code>, so the id below is
          the scanned identifier. Check it against that resource's provider documentation
          before applying.
        </p>
      )}
      <pre className="tf-import-block">{block.parentText}</pre>
      {resolved.type !== '' && resolved.addressIsSuggestion && (
        <p className="tf-import-note">
          <code>{resolved.address}</code> is a <strong>suggested</strong> address — there is no
          state file to read a real one from, so it was built from this resource's name.
          Rename it to suit your module before pasting.
        </p>
      )}
      {children.length > 0 && (
        <NestedBlocks
          kind={subject.kind}
          blocks={children}
          sharedComments={sharedChildComments}
          unusable={unusable}
        />
      )}
    </div>
  );
}

/**
 * The nested terraform resources a scanned parent contains, rendered so a group
 * with a dozen rules stays readable.
 *
 * Two things make it readable, and both matter more than they look:
 *
 * - **The shared notes are stated once.** Every child block correctly carries
 *   the provider's warning about mixing `aws_security_group_rule` with inline
 *   rules — it is three lines, it is the warning a reader most needs, and it
 *   must survive into the clipboard because a pasted `.tf` file has no UI
 *   around it. Repeating it beside twelve near-identical stanzas is how a
 *   reader learns to skip it, so on screen it is hoisted into one callout and
 *   the stanzas below carry only what distinguishes them. `Copy` still copies
 *   the full text.
 * - **It collapses.** Open by default, because the whole point is that these
 *   were invisible; collapsible, because a default security group in a busy
 *   VPC has more rules than the panel is tall.
 */
function NestedBlocks({
  kind,
  blocks,
  sharedComments,
  unusable,
}: {
  kind: string;
  blocks: readonly NestedBlock[];
  sharedComments: readonly string[];
  unusable: number;
}): React.ReactElement {
  return (
    <details className="tf-nested" open>
      <summary>
        <span className="tf-nested-count">{blocks.length}</span>
        nested resource{blocks.length === 1 ? '' : 's'} inside this {kind}
      </summary>
      <p className="tf-import-note">
        Terraform models these as resources of their own, so the block above adopts the{' '}
        <code>{kind}</code> and leaves them unmanaged. Each needs its own import block.
        {unusable > 0 && (
          <>
            {' '}
            <strong>
              {unusable} of {blocks.length}
            </strong>{' '}
            could not be turned into a usable import id and {unusable === 1 ? 'is' : 'are'}{' '}
            emitted commented out, with the reason on the block.
          </>
        )}
      </p>
      {sharedComments.length > 0 && (
        <div className="tf-nested-notes">
          <span className="tf-nested-notes-title">Applies to every block below</span>
          <ul>
            {sharedComments.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
        </div>
      )}
      <ul className="tf-nested-list">
        {blocks.map((child) => (
          <li key={`${child.resolved.address}:${child.resolved.id}`}>
            <pre className="tf-import-block">{child.text}</pre>
          </li>
        ))}
      </ul>
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
      <PanelShell>
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
      </PanelShell>
    );
  }
  if (selection.type === 'edge') {
    const { data } = selection;
    const underlying = data.refId ? index.byKey.get(data.refId) : undefined;
    return (
      <PanelShell>
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
      </PanelShell>
    );
  }

  const { ref } = selection;
  const Icon = iconFor(ref.kind);
  const consoleHref = consoleUrl(ref);
  const annotation = index.annotationFor(ref);
  const tfBindings = index.terraformFor(ref);
  const tags = (ref.raw['tags'] ?? {}) as Record<string, string>;
  const properties = Object.entries(ref.raw).filter(
    ([k, v]) => !HIDDEN_KEYS.has(k) && v !== undefined,
  );

  return (
    <PanelShell>
      <header>
        {Icon && <Icon width={28} height={28} />}
        <h2>{ref.name ?? ref.id}</h2>
        {consoleHref && (
          <a
            className="console-link"
            href={consoleHref}
            target="_blank"
            rel="noreferrer"
            title="Open in the AWS console (requires a signed-in session for this account)"
          >
            <AwsLogo width={20} height={20} />
          </a>
        )}
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

      {tfBindings.length > 0 && (
        <section className="terraform">
          <h3 className="tf-heading"><TerraformMark size={15} /> Terraform</h3>
          {tfBindings.length > 1 && (
            <p className="muted">
              ⚠ Claimed by {tfBindings.length} state instances — likely imported into
              more than one stack.
            </p>
          )}
          <ul className="terraform-bindings">
            {tfBindings.map((b) => (
              <li key={`${b.stack}:${b.address}`}>
                <code className="tf-address">{b.address}</code>
                <div className="tf-origin">
                  stack <strong>{b.stack}</strong> · <RepoRef repo={b.repo} />
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
      {tfBindings.length === 0 && index.terraform.length > 0 && (
        <section className="terraform">
          <h3 className="tf-heading"><TerraformMark size={15} /> Terraform</h3>
          <p className="muted">
            Not claimed by any imported state ({index.terraform.length} stack
            {index.terraform.length === 1 ? '' : 's'} imported) — created outside
            Terraform, or managed by a stack that hasn't been imported.
          </p>
          <ImportBlock subject={ref} />
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
    </PanelShell>
  );
}
