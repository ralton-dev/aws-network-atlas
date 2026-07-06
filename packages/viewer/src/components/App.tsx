import { useCallback, useEffect, useMemo, useState } from 'react';
import { buildIndex, type ResourceRef } from '../data.js';
import { buildOverview } from '../model/overview.js';
import { buildVpcDetail } from '../model/vpc-detail.js';
import { layoutGraph } from '../model/layout.js';
import type { AtlasEdge, AtlasGraph, AtlasNode } from '../model/graph-types.js';
import { FlowView } from './FlowView.js';
import { SearchBar } from './SearchBar.js';
import { DetailsPanel, type Selection } from './DetailsPanel.js';
import { InventoryPanel } from './InventoryPanel.js';

type Route = { view: 'overview' } | { view: 'vpc'; vpcId: string };

function parseHash(): Route {
  const match = /^#\/vpc\/([^/?]+)/.exec(window.location.hash);
  return match?.[1] ? { view: 'vpc', vpcId: match[1] } : { view: 'overview' };
}

function routeHash(route: Route): string {
  return route.view === 'vpc' ? `#/vpc/${route.vpcId}` : '#/';
}

export function App(): React.ReactElement {
  const index = useMemo(buildIndex, []);
  const [route, setRouteState] = useState<Route>(parseHash);
  const [graph, setGraph] = useState<AtlasGraph>({ nodes: [], edges: [] });
  const [loading, setLoading] = useState(true);
  const [selection, setSelection] = useState<Selection | undefined>();
  const [showInventory, setShowInventory] = useState(false);

  const setRoute = useCallback((next: Route) => {
    // Hash-based navigation — the History API doesn't work on file://.
    if (routeHash(next) !== window.location.hash) window.location.hash = routeHash(next);
    // Dedupe by VALUE so the hashchange echo (or re-selecting the current
    // view) doesn't produce a new route object and re-run the ELK layout.
    setRouteState((prev) => (routeHash(prev) === routeHash(next) ? prev : next));
  }, []);

  useEffect(() => {
    const onHashChange = (): void =>
      setRouteState((prev) => {
        const next = parseHash();
        return routeHash(prev) === routeHash(next) ? prev : next;
      });
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const built =
      route.view === 'vpc' ? buildVpcDetail(index, route.vpcId) : buildOverview(index);
    void layoutGraph(built).then((laidOut) => {
      if (cancelled) return;
      setGraph(laidOut);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [index, route]);

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
      const ref = node.data.refId ? index.byKey.get(node.data.refId) : undefined;
      if (ref) setSelection({ type: 'resource', ref });
    },
    [index],
  );

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
        </nav>
        <SearchBar index={index} onPick={selectRef} />
        <button className="toolbar-btn" onClick={() => setShowInventory((v) => !v)}>
          {showInventory ? 'Hide inventory' : 'Inventory'}
        </button>
        <span className="scan-time">
          scanned {lastScanned ? new Date(lastScanned).toLocaleString() : '—'}
        </span>
      </header>
      <main className="content">
        {showInventory && <InventoryPanel index={index} onSelect={selectRef} />}
        <div className="canvas">
          {loading ? (
            <div className="loading">Laying out diagram…</div>
          ) : (
            <FlowView
              graph={graph}
              viewKey={routeHash(route)}
              selectedId={
                selection?.type === 'resource'
                  ? selection.ref.id
                  : undefined
              }
              selectedEdgeId={selection?.type === 'edge' ? selection.id : undefined}
              onNodeClick={onNodeClick}
              onNodeDoubleClick={onNodeDoubleClick}
              onEdgeClick={onEdgeClick}
              onPaneClick={() => setSelection(undefined)}
            />
          )}
        </div>
        {selection && (
          <DetailsPanel
            index={index}
            selection={selection}
            onClose={() => setSelection(undefined)}
            onOpenVpc={(vpcId) => setRoute({ view: 'vpc', vpcId })}
            onSelectRef={(ref) => setSelection({ type: 'resource', ref })}
          />
        )}
      </main>
    </div>
  );
}
