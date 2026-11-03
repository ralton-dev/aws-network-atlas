import { useCallback, useEffect, useMemo, useState } from 'react';
import { indexChangeSet, type Proposal } from '@atlas/proposal';
import { buildIndex, type AtlasIndex, type ResourceRef } from '../data.js';
import { diffGraphs } from '../model/diff.js';
import { buildFocus } from '../model/focus.js';
import { buildOverview } from '../model/overview.js';
import { buildVpcDetail } from '../model/vpc-detail.js';
import {
  defaultSelection,
  formatAccountsParam,
  parseAccountsParam,
  withAccounts,
} from '../model/selection.js';
import {
  changeSetFor,
  effectiveAccounts,
  loadProposals,
  parseProposalParam,
  proposedIndex,
  withProposalParam,
} from '../model/proposal.js';
import { applyTerraformBadges } from '../model/terraform.js';
import { layoutGraph } from '../model/layout.js';
import type { AtlasEdge, AtlasGraph, AtlasNode, ChangeState, EdgeKind } from '../model/graph-types.js';
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
import { DetailsPanel, type ResourceChange, type Selection } from './DetailsPanel.js';
import { InventoryPanel } from './InventoryPanel.js';
import { LayersPanel } from './LayersPanel.js';
import { ProposalBar, type ProposalMode } from './ProposalBar.js';

type Route =
  | { view: 'overview' }
  | { view: 'vpc'; vpcId: string }
  | { view: 'focus'; key: string };

/**
 * Anything that is not `#/vpc/…` or `#/focus/…` is the overview, whatever
 * query it carries; the overview's `?accounts=` param is read separately
 * (`parseAccountsParam`), because the selection is App state of its own, and
 * so is the `?proposal=` every route may carry (`parseProposalParam`). A
 * focus key is written with `encodeURIComponent`, so its first `?` is always
 * the query and never part of the key.
 */
function parseHash(): Route {
  const vpc = /^#\/vpc\/([^/?]+)/.exec(window.location.hash);
  if (vpc?.[1]) return { view: 'vpc', vpcId: vpc[1] };
  const focus = /^#\/focus\/([^?]+)/.exec(window.location.hash);
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

/**
 * A route's hash with the active proposal added (decision 51), on every
 * route. With no proposal active it is `hash` itself, so the URL, the view
 * key and the storage keys are exactly what they were before proposals.
 */
function withProposal(hash: string, proposalId: string | undefined): string {
  return proposalId === undefined ? hash : withProposalParam(hash, proposalId);
}

/** The URL's proposal id if it names a loaded proposal; no side effects. */
function knownProposalId(proposals: readonly Proposal[], hash: string): string | undefined {
  const asked = parseProposalParam(hash);
  return asked !== undefined && proposals.some((p) => p.id === asked) ? asked : undefined;
}

/**
 * Decision 51: a URL naming a proposal the bundle does not carry loads the
 * estate as scanned, with a console warning, and the URL is rewritten
 * without it (in place: a dead param is not a navigation).
 */
function dropUnknownProposal(proposals: readonly Proposal[]): void {
  const asked = parseProposalParam(window.location.hash);
  if (asked === undefined || proposals.some((p) => p.id === asked)) return;
  console.warn(`atlas: no proposal "${asked}" is loaded; showing the estate as scanned`);
  window.location.replace(withProposalParam(window.location.hash, undefined));
}

/** What each proposal mode hides (decision 50); `both` hides nothing. */
const HIDE_ADDED: ReadonlySet<ChangeState> = new Set(['added']);
const HIDE_REMOVED: ReadonlySet<ChangeState> = new Set(['removed']);

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

/**
 * What the details panel is handed for a selection, whichever route made it
 * (node click, Inventory, search, the panel's own links). With no proposal
 * active: the selection and `index`, unchanged. With one, a resource is
 * looked up in the proposal's `ChangeSet` by id or arn (never by region —
 * the `ChangeSet` says `'global'` where a ref says `''`) and shown from the
 * side it is drawn from: the scanned ref and index for a removed resource,
 * the proposed ones for everything else, so an added resource's `proposed-`
 * id is flagged and its import block, console link and note hint withheld.
 * An edge reads its "View …" target from the proposed index, or from the
 * scanned one when the edge itself is being removed.
 */
function detailsFor(
  selection: Selection | undefined,
  index: AtlasIndex,
  proposed: AtlasIndex | undefined,
  lookup: ReturnType<typeof indexChangeSet> | undefined,
): { selection: Selection; index: AtlasIndex; change?: ResourceChange } | undefined {
  if (selection === undefined) return undefined;
  if (proposed === undefined || lookup === undefined) return { selection, index };
  if (selection.type === 'edge') {
    return { selection, index: selection.data.changeState === 'removed' ? index : proposed };
  }
  if (selection.type !== 'resource') return { selection, index: proposed };
  const { ref } = selection;
  const hit = lookup.get(ref.id) ?? (ref.arn !== undefined ? lookup.get(ref.arn) : undefined);
  if (hit?.state === 'removed') {
    return {
      selection: { type: 'resource', ref: index.byKey.get(ref.id) ?? ref },
      index,
      change: { removed: true },
    };
  }
  const change: ResourceChange | undefined =
    hit?.state === 'added' ? { added: true } : hit?.state === 'changed' ? hit.entry : undefined;
  return {
    selection: { type: 'resource', ref: proposed.byKey.get(ref.id) ?? ref },
    index: proposed,
    ...(change !== undefined ? { change } : {}),
  };
}

export function App(): React.ReactElement {
  const index = useMemo(buildIndex, []);
  // `loadProposals` returns a fresh array on every call: once, like the index.
  const proposals = useMemo(loadProposals, []);
  const [route, setRouteState] = useState<Route>(parseHash);
  const [accounts, setAccounts] = useState<ReadonlySet<string>>(() => initialAccounts(index));
  // The active proposal: from the URL only, never remembered (decision 51).
  const [proposalId, setProposalId] = useState<string | undefined>(() =>
    knownProposalId(proposals, window.location.hash),
  );
  // Which side of it the canvas draws. View state, not stored (decision 50).
  const [proposalMode, setProposalMode] = useState<ProposalMode>('both');
  const active = useMemo(
    () => (proposalId === undefined ? undefined : proposals.find((p) => p.id === proposalId)),
    [proposals, proposalId],
  );
  // Both from the *full* index and memoised per (index, proposal) by
  // `proposal.ts`, so `proposed` is a stable object for `focus.ts`'s cache.
  const proposed = useMemo(() => (active ? proposedIndex(index, active) : undefined), [index, active]);
  const changes = useMemo(() => (active ? changeSetFor(index, active) : undefined), [index, active]);
  const changeLookup = useMemo(() => (changes ? indexChangeSet(changes) : undefined), [changes]);
  // Decision 52: the accounts a proposal creates are always drawn. Derived,
  // never stored or written into `?accounts=` — `accounts` stays the
  // selection; with no proposal this is `accounts` itself.
  const effective = useMemo(() => effectiveAccounts(accounts, active), [accounts, active]);
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
  // Every view key carries the active proposal (decision 50): positions and
  // hidden state saved for one proposal never apply to another, or to none.
  const viewKey = withProposal(routeHash(route, accounts, index.snapshot.accounts.length), proposalId);
  // What the graph on hand was built from: the view plus, on the overview, the
  // selection spelt out in full. Equal to `viewKey` except in the one case
  // `routeHash` canonicalises (a single-account estate, where "all" and
  // "none" both have the URL `#/`). Also the `FlowView` key, so a different
  // selection always remounts onto its own layout.
  const graphKey =
    route.view === 'overview' ? withProposal(`#/${formatAccountsParam(accounts)}`, proposalId) : viewKey;
  const [hidden, setHidden] = useState<HiddenState>(() => loadHiddenState(viewKey));
  const [mode, setMode] = useState<InteractionMode>(loadInteractionMode);
  // Decision 38: an empty selection on the overview builds nothing at all.
  // While a proposal is active the accounts it creates count (decision 52);
  // with none, `effective` is `accounts`.
  const emptyOverview = route.view === 'overview' && effective.size === 0;
  const graph = built.graphKey === graphKey ? built.graph : EMPTY_GRAPH;
  const loading = !emptyOverview && built.graphKey !== graphKey;

  // Decision 40: one derived index per selection. `withAccounts` returns a new
  // object on every filtering call, so without this the overview would rebuild
  // (and re-run ELK) on every render. Show-all returns `index` itself.
  const shown = useMemo(() => withAccounts(index, accounts), [index, accounts]);
  // The proposed side's overview index, memoised the same way.
  const shownProposed = useMemo(
    () => (proposed ? withAccounts(proposed, effective) : undefined),
    [proposed, effective],
  );

  const toggleMode = useCallback(() => {
    const next: InteractionMode = mode === 'pan' ? 'arrange' : 'pan';
    setMode(next);
    saveInteractionMode(next);
  }, [mode]);

  const setRoute = useCallback(
    (next: Route) => {
      // Hash-based navigation — the History API doesn't work on file://.
      // Returning to the overview re-applies the current selection (decision 37).
      const hash = withProposal(routeHash(next, accounts, index.snapshot.accounts.length), proposalId);
      if (hash !== window.location.hash) window.location.hash = hash;
      // Dedupe by VALUE so the hashchange echo (or re-selecting the current
      // view) doesn't produce a new route object and re-run the ELK layout.
      setRouteState((prev) => (routeKey(prev) === routeKey(next) ? prev : next));
    },
    [index, accounts, proposalId],
  );

  // Every selection change goes through here: remember it, and keep the
  // overview URL in step. Dedupe by value, like the route, so re-applying the
  // same selection never yields a new set (and so never a new derived index).
  const applyAccounts = useCallback(
    (next: ReadonlySet<string>) => {
      setAccounts((prev) => (sameSet(prev, next) ? prev : next));
      saveAccountSelection(next);
      if (route.view === 'overview') {
        const hash = withProposal(routeHash(route, next, index.snapshot.accounts.length), proposalId);
        // replace, not push: switching an account on is not a navigation.
        if (hash !== window.location.hash) window.location.replace(hash);
      }
    },
    [index, route, proposalId],
  );

  // Every proposal change goes through here: the current route's hash with
  // the param set or dropped, in place like the selection. Deduped by value.
  const applyProposal = useCallback(
    (id: string | undefined) => {
      const next = id !== undefined && proposals.some((p) => p.id === id) ? id : undefined;
      setProposalId((prev) => (prev === next ? prev : next));
      const hash = withProposal(routeHash(route, accounts, index.snapshot.accounts.length), next);
      if (hash !== window.location.hash) window.location.replace(hash);
    },
    [proposals, index, route, accounts],
  );

  useEffect(() => {
    const onHashChange = (): void => {
      const next = parseHash();
      setRouteState((prev) => (routeKey(prev) === routeKey(next) ? prev : next));
      // The URL is where the proposal lives (decision 51): a pasted or
      // back-navigated hash sets it or clears it, on every route. Our own
      // rewrites echo the same id; a string compares by value.
      const proposalFromUrl = knownProposalId(proposals, window.location.hash);
      setProposalId((prev) => (prev === proposalFromUrl ? prev : proposalFromUrl));
      dropUnknownProposal(proposals);
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
  }, [index, proposals]);

  // A cold load naming an unknown proposal (decision 51). Before the sync
  // below, which would otherwise rewrite the overview URL first and lose the
  // id the warning names.
  useEffect(() => {
    dropUnknownProposal(proposals);
  }, [proposals]);

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
  const overviewProposed = route.view === 'overview' ? shownProposed : undefined;

  useEffect(() => {
    // Decision 38: nothing selected, nothing to build — no buildOverview, no
    // ELK. The canvas renders the empty state straight away.
    if (emptyOverview) {
      setBuilt({ graphKey, graph: EMPTY_GRAPH });
      return;
    }
    let cancelled = false;
    // One view from one index. Each side is badged from the index it was
    // built from, before the diff: a removed node exists only in the current
    // index and an added one only in the proposed, so badging the union from
    // either would strip the other side's marks. `diffGraphs` never reads
    // `tfManaged` and copies `data`, so the order changes nothing else.
    const buildFrom = (from: AtlasIndex, overviewFrom: AtlasIndex): AtlasGraph =>
      applyTerraformBadges(
        route.view === 'vpc'
          ? buildVpcDetail(from, route.vpcId)
          : route.view === 'focus'
            ? buildFocus(from, route.key)
            : buildOverview(overviewFrom),
        from,
      );
    // Decision 49: with a proposal, the same builder over each index and the
    // union of the two, laid out once (decision 50). One exception: focus on
    // a resource the proposal adds. `buildFocus` over the scanned index would
    // draw a placeholder centre under the same id (nothing there relates to a
    // `proposed-` id, so it is only that), and the diff would call the added
    // resource *changed*; the scanned side draws nothing instead. A removed
    // centre keeps its placeholder on the proposed side: routes that still
    // name it connect it there, and dropping it would mark every neighbour
    // removed. Without a proposal, exactly the single build.
    const graphToLay =
      proposed && changes
        ? diffGraphs(
            route.view === 'focus' && !index.byKey.has(route.key) && proposed.byKey.has(route.key)
              ? EMPTY_GRAPH
              : buildFrom(index, overviewIndex ?? shown),
            buildFrom(proposed, overviewProposed ?? shownProposed ?? proposed),
            changes,
          )
        : buildFrom(index, overviewIndex ?? shown);
    void layoutGraph(graphToLay).then((laidOut) => {
      if (cancelled) return;
      setBuilt({ graphKey, graph: laidOut });
    });
    return () => {
      cancelled = true;
    };
    // Deliberately not on `accounts`/`graphKey`/`shown`/`effective`: on the
    // overview they change exactly when `overviewIndex` or `overviewProposed`
    // does, and elsewhere they must not trigger a rebuild at all. `proposed`
    // and `changes` change together, once per proposal.
  }, [index, route, overviewIndex, proposed, changes, overviewProposed]);

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

  // A resource key on whichever side has it: the proposed index first (an
  // added resource exists only there, a changed one is drawn as proposed),
  // then the scanned one (a removed resource exists only there). Without a
  // proposal, `index.byKey` exactly as before.
  const resolveRef = useCallback(
    (key: string): ResourceRef | undefined => proposed?.byKey.get(key) ?? index.byKey.get(key),
    [index, proposed],
  );

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
      const ref = node.data.refId ? resolveRef(node.data.refId) : undefined;
      if (ref) setSelection({ type: 'resource', ref });
      // Account/region containers carry no resource ref, but a partial scan
      // attaches its errors — surface them so the user sees which calls failed.
      else if (node.data.errors && node.data.errors.length > 0) {
        setSelection({ type: 'container', id: node.id, label: node.data.label, errors: node.data.errors });
      }
    },
    [index, accounts, applyAccounts, resolveRef],
  );

  const toggleAccount = useCallback(
    (accountId: string) => {
      // An account the proposal creates is always drawn while it is active
      // (decision 52) and never joins the stored selection.
      if (!index.snapshot.accounts.some((a) => a.accountId === accountId)) return;
      const next = new Set(accounts);
      if (!next.delete(accountId)) next.add(accountId);
      applyAccounts(next);
    },
    [index, accounts, applyAccounts],
  );

  const selectAllAccounts = useCallback(
    () => applyAccounts(new Set(index.snapshot.accounts.map((a) => a.accountId))),
    [index, applyAccounts],
  );

  const selectNoAccounts = useCallback(() => applyAccounts(new Set()), [applyAccounts]);

  const onNodeDoubleClick = useCallback(
    (node: AtlasNode) => {
      const vpcId = node.data.drillVpcId ?? (node.data.kind === 'vpc' ? node.data.refId : undefined);
      if (vpcId && resolveRef(vpcId)) setRoute({ view: 'vpc', vpcId });
    },
    [resolveRef, setRoute],
  );

  const onEdgeClick = useCallback((edge: AtlasEdge) => {
    if (edge.data) setSelection({ type: 'edge', id: edge.id, data: edge.data });
  }, []);

  const currentVpc = route.view === 'vpc' ? resolveRef(route.vpcId) : undefined;
  const focusRef = route.view === 'focus' ? resolveRef(route.key) : undefined;
  // The center's VPC gives the focus breadcrumb a way back to the VPC diagram.
  const focusVpcId = focusRef?.kind === 'vpc' ? focusRef.id : focusRef?.vpcId;
  const hasData = index.snapshot.accounts.length > 0;
  const hideStates = !active
    ? undefined
    : proposalMode === 'current'
      ? HIDE_ADDED
      : proposalMode === 'proposed'
        ? HIDE_REMOVED
        : undefined;
  // Decision 46: designed against another scan. Drawn anyway, badged.
  const stale = active !== undefined && active.base.generatedAt !== index.snapshot.generatedAt;
  const details = detailsFor(selection, index, proposed, changeLookup);
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
              {focusVpcId && resolveRef(focusVpcId) && (
                <>
                  <span className="crumb-sep">/</span>
                  <button
                    className="crumb"
                    onClick={() => setRoute({ view: 'vpc', vpcId: focusVpcId })}
                  >
                    {resolveRef(focusVpcId)?.name ?? focusVpcId}
                  </button>
                </>
              )}
              <span className="crumb-sep">/</span>
              <span className="crumb active">Focus: {focusRef?.name ?? route.key}</span>
            </>
          )}
        </nav>
        <SearchBar index={proposed ?? index} onPick={selectRef} />
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
      {proposals.length > 0 && (
        <ProposalBar
          proposals={proposals}
          activeId={proposalId}
          mode={proposalMode}
          stale={stale}
          onSelect={applyProposal}
          onMode={setProposalMode}
        />
      )}
      <main className="content">
        {showInventory && (
          <InventoryPanel
            // Decision 52: the effective estate, so a new account has an eye.
            index={proposed ?? index}
            onSelect={selectRef}
            selectedAccounts={effective}
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
              hideStates={hideStates}
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
        {details && (
          <DetailsPanel
            index={details.index}
            selection={details.selection}
            change={details.change}
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
