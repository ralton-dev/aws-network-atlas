import type { EdgeKind } from './graph-types.js';

/**
 * What the user has hidden while decluttering, scoped per view (overview or a
 * single VPC detail — the view hash is the storage key).
 */
/** Show only Terraform-managed resources, only unmanaged, or everything. */
export type TfFilter = 'managed' | 'unmanaged';

export interface HiddenState {
  /** Individually hidden nodes: graph node ids or resource refIds. */
  nodeIds: Set<string>;
  /** Hidden node kinds (AtlasNodeData.kind, e.g. 'instance', 'group-az'). */
  nodeKinds: Set<string>;
  /** Hidden edge kinds (peering / tgw / vpn / dx / route / assoc). */
  edgeKinds: Set<EdgeKind>;
  /** When set, resource nodes on the other side of the split are hidden. */
  tfFilter?: TfFilter;
}

export function emptyHiddenState(): HiddenState {
  return { nodeIds: new Set(), nodeKinds: new Set(), edgeKinds: new Set() };
}

export function hiddenCount(state: HiddenState): number {
  return (
    state.nodeIds.size + state.nodeKinds.size + state.edgeKinds.size + (state.tfFilter ? 1 : 0)
  );
}

// --- best-effort localStorage persistence -----------------------------------
// Every access is wrapped in try/catch: on file:// localStorage is per-file
// and often restricted (and unavailable in some private modes), in which case
// state silently stays session-only. It works reliably under `npm run dev`
// or `npm run serve`.

const hiddenKey = (viewKey: string): string => `atlas:hidden:${viewKey}`;
const positionsKey = (viewKey: string): string => `atlas:positions:${viewKey}`;

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string');
}

export function loadHiddenState(viewKey: string): HiddenState {
  try {
    const raw = window.localStorage.getItem(hiddenKey(viewKey));
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<Record<keyof HiddenState, unknown>>;
      return {
        nodeIds: new Set(isStringArray(parsed.nodeIds) ? parsed.nodeIds : []),
        nodeKinds: new Set(isStringArray(parsed.nodeKinds) ? parsed.nodeKinds : []),
        edgeKinds: new Set((isStringArray(parsed.edgeKinds) ? parsed.edgeKinds : []) as EdgeKind[]),
        tfFilter:
          parsed.tfFilter === 'managed' || parsed.tfFilter === 'unmanaged'
            ? parsed.tfFilter
            : undefined,
      };
    }
  } catch {
    /* storage unavailable — fall through to empty */
  }
  return emptyHiddenState();
}

export function saveHiddenState(viewKey: string, state: HiddenState): void {
  try {
    if (hiddenCount(state) === 0) {
      window.localStorage.removeItem(hiddenKey(viewKey));
    } else {
      window.localStorage.setItem(
        hiddenKey(viewKey),
        JSON.stringify({
          nodeIds: [...state.nodeIds],
          nodeKinds: [...state.nodeKinds],
          edgeKinds: [...state.edgeKinds],
          tfFilter: state.tfFilter,
        }),
      );
    }
  } catch {
    /* storage unavailable — session-only */
  }
}

// --- interaction mode --------------------------------------------------------

/**
 * How click-drag on the canvas behaves:
 *   'pan'     — nodes are locked; dragging anywhere (nodes included) pans.
 *   'arrange' — dragging a node moves it; dragging empty canvas still pans.
 * Global (not per view) — it's a tool preference, not view state.
 */
export type InteractionMode = 'pan' | 'arrange';

const MODE_KEY = 'atlas:mode';

export function loadInteractionMode(): InteractionMode {
  try {
    const raw = window.localStorage.getItem(MODE_KEY);
    if (raw === 'pan' || raw === 'arrange') return raw;
  } catch {
    /* storage unavailable — fall through to default */
  }
  return 'pan';
}

export function saveInteractionMode(mode: InteractionMode): void {
  try {
    window.localStorage.setItem(MODE_KEY, mode);
  } catch {
    /* storage unavailable — session-only */
  }
}

export type SavedPositions = Record<string, { x: number; y: number }>;

export function loadPositions(viewKey: string): SavedPositions | undefined {
  try {
    const raw = window.localStorage.getItem(positionsKey(viewKey));
    if (!raw) return undefined;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    const out: SavedPositions = {};
    for (const [id, pos] of Object.entries(parsed as Record<string, unknown>)) {
      const p = pos as { x?: unknown; y?: unknown } | null;
      if (
        p !== null &&
        typeof p.x === 'number' && Number.isFinite(p.x) &&
        typeof p.y === 'number' && Number.isFinite(p.y)
      ) {
        out[id] = { x: p.x, y: p.y };
      }
    }
    return Object.keys(out).length > 0 ? out : undefined;
  } catch {
    return undefined;
  }
}

export function savePositions(viewKey: string, positions: SavedPositions): void {
  try {
    window.localStorage.setItem(positionsKey(viewKey), JSON.stringify(positions));
  } catch {
    /* storage unavailable — session-only */
  }
}

export function clearPositions(viewKey: string): void {
  try {
    window.localStorage.removeItem(positionsKey(viewKey));
  } catch {
    /* storage unavailable */
  }
}
