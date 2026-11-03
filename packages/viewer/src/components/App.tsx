import { useCallback, useEffect, useMemo, useState } from 'react';
import { buildIndex, type AtlasIndex, type ResourceRef } from '../data.js';
import { buildFocus } from '../model/focus.js';
import { buildOverview } from '../model/overview.js';
import { buildVpcDetail } from '../model/vpc-detail.js';
import {
  defaultSelection,
  formatAccountsParam,
  parseAccountsParam,
  withAccounts,
} from '../model/selection.js';
import { applyTerraformBadges } from '../model/terraform.js';
import { layoutGraph } from '../model/layout.js';
import type { AtlasEdge, AtlasGraph, AtlasNode, EdgeKind } from '../model/graph-types.js';
import {
  emptyHiddenState,
  hiddenCount,
  loadAccountSelection,
  loadHiddenState,
  loadInteractionMode,
  saveAccountSelection,
  saveHiddenState,
  saveInteractionMode,
  type HiddenState,
  type InteractionMode,
  type TfFilter,
} from '../model/view-state.js';
import { FlowView } from './FlowView.js';
import { SearchBar } from './SearchBar.js';
import { DetailsPanel, type Selection } from './DetailsPanel.js';
import { InventoryPanel } from './InventoryPanel.js';
import { LayersPanel } from './LayersPanel.js';

type Route =
  | { view: 'overview' }
  | { view: 'vpc'; vpcId: string }
  | { view: 'focus'; key: string };

/**
 * Anything that is not `#/vpc/…` or `#/focus/…` is the overview, whatever
 * query it carries; the overview's `?accounts=` param is read separately
 * (`parseAccountsParam`), because the selection is App state of its own.
 */
function parseHash(): Route {
  const vpc = /^#\/vpc\/([^/?]+)/.exec(window.location.hash);
  if (vpc?.[1]) return { view: 'vpc', vpcId: vpc[1] };
  const focus = /^#\/focus\/(.+)$/.exec(window.location.hash);
  if (focus?.[1]) return { view: 'focus', key: decodeURIComponent(focus[1]) };
  return { view: 'overview' };
}

/**
 * The hash for a view, and that view's identity: the URL, the `FlowView` key,
 * and the storage key of its saved positions and hidden state. The overview's
 * includes the selection (decisions 37 and 39) — `#/` when nothing is
 * selected, `#/?accounts=<id>,<id>` otherwise — so positions dragged for one
 * selection are never applied to another. VPC and focus routes never carry it.
 *
 * One exception, for decision 35: a single-account estate showing its one
 * account keeps plain `#/`, the hash and view key it had before the picker
 * existed, so the positions and hidden state already saved under it still
 * apply and the estate does not move at all. (`#/` parses as "no opinion",
 * which there falls through to the stored selection or the default — all.)
 */
function routeHash(route: Route, accounts: ReadonlySet<string>, scannedCount: number): string {
  if (route.view === 'vpc') return `#/vpc/${route.vpcId}`;
  if (route.view === 'focus') return `#/focus/${encodeURIComponent(route.key)}`;
  if (scannedCount === 1 && accounts.size === 1) return '#/';
  return `#/${formatAccountsParam(accounts)}`;
}

/** Route identity without the selection — what the route dedupe compares. */
function routeKey(route: Route): string {
  return routeHash(route, NO_ACCOUNTS, 0);
}

const NO_ACCOUNTS: ReadonlySet<string> = new Set();

function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  return a.size === b.size && [...a].every((id) => b.has(id));
}

/**
 * Keep only scanned account ids; `undefined` when a non-empty input loses
 * every id (a link or a remembered selection from another estate), so the
 * caller falls through to the next source. An empty input stays empty: a
 * stored *show none* is a choice, not an absence.
 */
function scannedOnly(index: AtlasIndex, ids: Set<string> | undefined): Set<string> | undefined {
  if (ids === undefined) return undefined;
  const kept = new Set(
    index.snapshot.accounts.map((a) => a.accountId).filter((id) => ids.has(id)),
  );
  return kept.size === 0 && ids.size > 0 ? undefined : kept;
}

/** Decision 37: the URL wins over `localStorage`, which wins over the default. */
function initialAccounts(index: AtlasIndex): Set<string> {
  return (
    scannedOnly(index, parseAccountsParam(window.location.hash)) ??
    scannedOnly(index, loadAccountSelection()) ??
    defaultSelection(index)
  );
}

const EMPTY_GRAPH: AtlasGraph = { nodes: [], edges: [] };

export function App(): React.ReactElement {
  const index = useMemo(buildIndex, []);
  const [route, setRouteState] = useState<Route>(parseHash);
  const [accounts, setAccounts] = useState<ReadonlySet<string>>(() => initialAccounts(index));
  // The laid-out graph and the view it was laid out for. "Loading" is derived:
  // the canvas waits whenever the graph on hand belongs to another view, so a
  // stale graph is never mounted under a new view's key.
  const [built, setBuilt] = useState<{ graphKey: string; graph: AtlasGraph }>({
    graphKey: '',
    graph: EMPTY_GRAPH,
  });
  const [selection, setSelection] = useState<Selection | undefined>();
  // Nothing selected means the reader's first move is in Inventory (decision 35).
  const [showInventory, setShowInventory] = useState(() => accounts.size === 0);
  const [showLayers, setShowLayers] = useState(false);
  const viewKey = routeHash(route, accounts, index.snapshot.accounts.length);
  // What the graph on hand was built from: the view plus, on the overview, the
  // selection spelt out in full. Equal to `viewKey` except in the one case
  // `routeHash` canonicalises (a single-account estate, where "all" and
  // "none" both have the URL `#/`). Also the `FlowView` key, so a different
  // selection always remounts onto its own layout.
  const graphKey =
    route.view === 'overview' ? `#/${formatAccountsParam(accounts)}` : viewKey;
  const [hidden, setHidden] = useState<HiddenState>(() => loadHiddenState(viewKey));
  const [mode, setMode] = useState<InteractionMode>(loadInteractionMode);
  // Decision 38: an empty selection on the overview builds nothing at all.
  const emptyOverview = route.view === 'overview' && accounts.size === 0;
  const graph = built.graphKey === graphKey ? built.graph : EMPTY_GRAPH;
  const loading = !emptyOverview && built.graphKey !== graphKey;

  // Decision 40: one derived index per selection. `withAccounts` returns a new
  // object on every filtering call, so without this the overview would rebuild
  // (and re-run ELK) on every render. Show-all returns `index` itself.
  const shown = useMemo(() => withAccounts(index, accounts), [index, accounts]);

  const toggleMode = useCallback(() => {
    const next: InteractionMode = mode === 'pan' ? 'arrange' : 'pan';
    setMode(next);
    saveInteractionMode(next);
  }, [mode]);

  const setRoute = useCallback(
    (next: Route) => {
      // Hash-based navigation — the History API doesn't work on file://.
      // Returning to the overview re-applies the current selection (decision 37).
      const hash = routeHash(next, accounts, index.snapshot.accounts.length);
      if (hash !== window.location.hash) window.location.hash = hash;
      // Dedupe by VALUE so the hashchange echo (or re-selecting the current
      // view) doesn't produce a new route object and re-run the ELK layout.
      setRouteState((prev) => (routeKey(prev) === routeKey(next) ? prev : next));
    },
    [index, accounts],
  );

  // Every selection change goes through here: remember it, and keep the
  // overview URL in step. Dedupe by value, like the route, so re-applying the
  // same selection never yields a new set (and so never a new derived index).
  const applyAccounts = useCallback(
    (next: ReadonlySet<string>) => {
      setAccounts((prev) => (sameSet(prev, next) ? prev : next));
      saveAccountSelection(next);
      if (route.view === 'overview') {
        const hash = routeHash(route, next, index.snapshot.accounts.length);
        // replace, not push: switching an account on is not a navigation.
        if (hash !== window.location.hash) window.location.replace(hash);
      }
    },
    [index, route],
  );

  useEffect(() => {
    const onHashChange = (): void => {
      const next = parseHash();
      setRouteState((prev) => (routeKey(prev) === routeKey(next) ? prev : next));
      if (next.view !== 'overview') return;
      // A pasted or back-navigated `?accounts=` wins; plain `#/` means "no
      // opinion" and keeps the current selection (the sync effect below then
      // writes it back into the URL). The echo of our own rewrite parses to
      // the same set and is deduped by value — it does not rebuild.
      const fromUrl = scannedOnly(index, parseAccountsParam(window.location.hash));
      if (fromUrl === undefined) return;
      setAccounts((prev) => (sameSet(prev, fromUrl) ? prev : fromUrl));
      saveAccountSelection(fromUrl);
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, [index]);

  // The overview URL always spells the selection: on a cold load that took it
  // from localStorage or the default, and after a hashchange to bare `#/`.
  useEffect(() => {
    // A bare URL with no hash is already the plain overview; leave it bare.
    if (route.view === 'overview' && viewKey !== (window.location.hash || '#/')) {
      window.location.replace(viewKey);
    }
  }, [route, viewKey]);

  // Only the overview depends on the selection; the VPC and focus views get
  // the full index and must not rebuild when an account is switched.
  const overviewIndex = route.view === 'overview' ? shown : undefined;

  useEffect(() => {
    // Decision 38: nothing selected, nothing to build — no buildOverview, no
    // ELK. The canvas renders the empty state straight away.
    if (route.view === 'overview' && accounts.size === 0) {
      setBuilt({ graphKey, graph: EMPTY_GRAPH });
      return;
    }
    let cancelled = false;
    const graphToLay = applyTerraformBadges(
      route.view === 'vpc'
        ? buildVpcDetail(index, route.vpcId)
        : route.view === 'focus'
          ? buildFocus(index, route.key)
          : buildOverview(overviewIndex ?? shown),
      index,
    );
    void layoutGraph(graphToLay).then((laidOut) => {
      if (cancelled) return;
      setBuilt({ graphKey, graph: laidOut });
    });
    return () => {
      cancelled = true;
    };
    // Deliberately not on `accounts`/`graphKey`/`shown`: on the overview they
    // change exactly when `overviewIndex` does, and elsewhere they must not
    // trigger a rebuild at all.
  }, [index, route, overviewIndex]);

  // Hidden state is scoped per view; reload it when the view changes.
  useEffect(() => {
    setHidden(loadHiddenState(viewKey));
  }, [viewKey]);

  // All mutations go through here so the per-view persistence stays in sync.
  const applyHidden = useCallback(
    (next: HiddenState) => {
      setHidden(next);
      saveHiddenState(viewKey, next);
    },
    [viewKey],
  );

  const onNodeHide = useCallback(
    (node: AtlasNode) => {
      applyHidden({ ...hidden, nodeIds: new Set(hidden.nodeIds).add(node.id) });
      // Don't leave the details panel pointing at a node that just vanished.
      setSelection((sel) =>
        sel?.type === 'resource' && node.data.refId !== undefined && sel.ref.id === node.data.refId
          ? undefined
          : sel,
      );
    },
    [hidden, applyHidden],
  );

  const onHideRef = useCallback(
    (ref: ResourceRef) => {
      // Nodes match hidden ids by graph id OR data.refId, so the raw AWS id works.
      applyHidden({ ...hidden, nodeIds: new Set(hidden.nodeIds).add(ref.id) });
      setSelection(undefined);
    },
    [hidden, applyHidden],
  );

  const toggleNodeKind = useCallback(
    (kind: string) => {
      const nodeKinds = new Set(hidden.nodeKinds);
      if (!nodeKinds.delete(kind)) nodeKinds.add(kind);
      applyHidden({ ...hidden, nodeKinds });
    },
    [hidden, applyHidden],
  );

  const toggleEdgeKind = useCallback(
    (kind: EdgeKind) => {
      const edgeKinds = new Set(hidden.edgeKinds);
      if (!edgeKinds.delete(kind)) edgeKinds.add(kind);
      applyHidden({ ...hidden, edgeKinds });
    },
    [hidden, applyHidden],
  );

  const setTfFilter = useCallback(
    (tfFilter?: TfFilter) => applyHidden({ ...hidden, tfFilter }),
    [hidden, applyHidden],
  );

  const showHiddenNodes = useCallback(
    () => applyHidden({ ...hidden, nodeIds: new Set() }),
    [hidden, applyHidden],
  );

  const showAll = useCallback(() => applyHidden(emptyHiddenState()), [applyHidden]);

  const selectRef = useCallback(
    (ref: ResourceRef) => {
      setSelection({ type: 'resource', ref });
      if (ref.kind === 'vpc') setRoute({ view: 'vpc', vpcId: ref.id });
      else if (ref.vpcId) setRoute({ view: 'vpc', vpcId: ref.vpcId });
    },
    [setRoute],
  );

  const onNodeClick = useCallback(
    (node: AtlasNode) => {
      // A ghost box for a scanned account the selection leaves out: clicking
      // it adds the account (decision 36). Checked against the full index —
      // `shown` would, by construction, never contain it.
      const add = node.data.addAccountId;
      if (add !== undefined && index.snapshot.accounts.some((a) => a.accountId === add)) {
        applyAccounts(new Set(accounts).add(add));
        return;
      }
      const ref = node.data.refId ? index.byKey.get(node.data.refId) : undefined;
      if (ref) setSelection({ type: 'resource', ref });
      // Account/region containers carry no resource ref, but a partial scan
      // attaches its errors — surface them so the user sees which calls failed.
      else if (node.data.errors && node.data.errors.length > 0) {
        setSelection({ type: 'container', id: node.id, label: node.data.label, errors: node.data.errors });
      }
    },
    [index, accounts, applyAccounts],
  );

  const toggleAccount = useCallback(
    (accountId: string) => {
      const next = new Set(accounts);
      if (!next.delete(accountId)) next.add(accountId);
      applyAccounts(next);
    },
    [accounts, applyAccounts],
  );

  const selectAllAccounts = useCallback(
    () => applyAccounts(new Set(index.snapshot.accounts.map((a) => a.accountId))),
    [index, applyAccounts],
  );

  const selectNoAccounts = useCallback(() => applyAccounts(new Set()), [applyAccounts]);

  const onNodeDoubleClick = useCallback(
    (node: AtlasNode) => {
      const vpcId = node.data.drillVpcId ?? (node.data.kind === 'vpc' ? node.data.refId : undefined);
      if (vpcId && index.byKey.has(vpcId)) setRoute({ view: 'vpc', vpcId });
    },
    [index, setRoute],
  );

  const onEdgeClick = useCallback((edge: AtlasEdge) => {
    if (edge.data) setSelection({ type: 'edge', id: edge.id, data: edge.data });
  }, []);

  const currentVpc = route.view === 'vpc' ? index.byKey.get(route.vpcId) : undefined;
  const focusRef = route.view === 'focus' ? index.byKey.get(route.key) : undefined;
  // The center's VPC gives the focus breadcrumb a way back to the VPC diagram.
  const focusVpcId = focusRef?.kind === 'vpc' ? focusRef.id : focusRef?.vpcId;
  const hasData = index.snapshot.accounts.length > 0;
  // Latest actual scan time (bundle time is misleading — annotations rebundle too).
  const lastScanned = index.snapshot.accounts
    .map((a) => a.scannedAt)
    .filter(Boolean)
    .sort()
    .at(-1);

  if (!hasData) {
    return (
      <div className="empty-state">
        <h1>AWS Network Atlas</h1>
        <p>No scan data found. Generate it with:</p>
        <pre>npm run scan -- --profile default</pre>
        <p>
          then reload this page. (After editing annotations only, <code>npm run bundle</code>{' '}
          refreshes the data without re-scanning.)
        </p>
      </div>
    );
  }

  return (
    <div className="app">
      <header className="topbar">
        <h1 onClick={() => setRoute({ view: 'overview' })}>AWS Network Atlas</h1>
        <nav className="breadcrumbs">
          <button
            className={route.view === 'overview' ? 'crumb active' : 'crumb'}
            onClick={() => setRoute({ view: 'overview' })}
          >
            Overview
          </button>
          {route.view === 'vpc' && (
            <>
              <span className="crumb-sep">/</span>
              <span className="crumb active">{currentVpc?.name ?? route.vpcId}</span>
            </>
          )}
          {route.view === 'focus' && (
            <>
              {focusVpcId && index.byKey.has(focusVpcId) && (
                <>
                  <span className="crumb-sep">/</span>
                  <button
                    className="crumb"
                    onClick={() => setRoute({ view: 'vpc', vpcId: focusVpcId })}
                  >
                    {index.byKey.get(focusVpcId)?.name ?? focusVpcId}
                  </button>
                </>
              )}
              <span className="crumb-sep">/</span>
              <span className="crumb active">Focus: {focusRef?.name ?? route.key}</span>
            </>
          )}
        </nav>
        <SearchBar index={index} onPick={selectRef} />
        <button className="toolbar-btn" onClick={() => setShowInventory((v) => !v)}>
          {showInventory ? 'Hide inventory' : 'Inventory'}
        </button>
        <button className="toolbar-btn" onClick={() => setShowLayers((v) => !v)}>
          {showLayers ? 'Hide layers' : 'Layers'}
          {hiddenCount(hidden) > 0 && (
            <span className="toolbar-badge">{hiddenCount(hidden)} hidden</span>
          )}
        </button>
        <button
          className="toolbar-btn"
          onClick={toggleMode}
          title={
            mode === 'pan'
              ? 'Pan mode: nodes are locked, drag anywhere to pan. Click to switch to Arrange.'
              : 'Arrange mode: drag nodes to move them. Click to switch to Pan.'
          }
        >
          {mode === 'pan' ? '🔒 Pan' : '✋ Arrange'}
        </button>
        <span className="scan-time">
          scanned {lastScanned ? new Date(lastScanned).toLocaleString() : '—'}
        </span>
      </header>
      <main className="content">
        {showInventory && (
          <InventoryPanel
            index={index}
            onSelect={selectRef}
            selectedAccounts={accounts}
            onToggleAccount={toggleAccount}
            onSelectAllAccounts={selectAllAccounts}
            onSelectNoAccounts={selectNoAccounts}
          />
        )}
        <div className="canvas">
          {emptyOverview ? (
            <div className="canvas-empty">
              <p className="canvas-empty-title">
                Add at least one account from Inventory to get started.
              </p>
              {!showInventory && (
                <button className="canvas-empty-action" onClick={() => setShowInventory(true)}>
                  Open inventory
                </button>
              )}
            </div>
          ) : loading ? (
            <div className="loading">Laying out diagram…</div>
          ) : (
            <FlowView
              // Remount on view change: re-seeds node state from the fresh ELK
              // layout (useState initializer) and re-applies fitView.
              // The overview's key includes the selection (decision 39).
              key={graphKey}
              graph={graph}
              viewKey={viewKey}
              selectedId={
                selection?.type === 'resource'
                  ? selection.ref.id
                  : selection?.type === 'container'
                    ? selection.id
                    : undefined
              }
              selectedEdgeId={selection?.type === 'edge' ? selection.id : undefined}
              hidden={hidden}
              mode={mode}
              onNodeClick={onNodeClick}
              onNodeDoubleClick={onNodeDoubleClick}
              onNodeHide={onNodeHide}
              onEdgeClick={onEdgeClick}
              onPaneClick={() => setSelection(undefined)}
            />
          )}
          {showLayers && (
            <LayersPanel
              graph={graph}
              index={index}
              hidden={hidden}
              onToggleNodeKind={toggleNodeKind}
              onToggleEdgeKind={toggleEdgeKind}
              onSetTfFilter={setTfFilter}
              onShowHiddenNodes={showHiddenNodes}
              onShowAll={showAll}
              onClose={() => setShowLayers(false)}
            />
          )}
        </div>
        {selection && (
          <DetailsPanel
            index={index}
            selection={selection}
            onClose={() => setSelection(undefined)}
            onOpenVpc={(vpcId) => setRoute({ view: 'vpc', vpcId })}
            onFocus={(ref) => setRoute({ view: 'focus', key: ref.id })}
            onSelectRef={(ref) => setSelection({ type: 'resource', ref })}
            onHide={onHideRef}
          />
        )}
      </main>
    </div>
  );
}
