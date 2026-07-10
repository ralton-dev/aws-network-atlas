import { useEffect, useMemo, useRef, useState } from 'react';
import MiniSearch from 'minisearch';
import type { AtlasIndex, ResourceRef } from '../data.js';

interface SearchDoc {
  docId: number;
  name?: string;
  resourceId: string;
  arn?: string;
  kind: string;
  tags: string;
  annotation: string;
  /** Flattened field values from ref.raw — IPs, CIDRs, domains, endpoints… */
  values: string;
  [key: string]: unknown;
}

// --- Tokenizer -------------------------------------------------------------
// MiniSearch's default tokenizer splits on ALL punctuation, so "10.0.10.20"
// becomes ["10","0","10","20"] and an IP/CIDR/hostname query degenerates into
// a soup of tiny common terms. This tokenizer (used for both indexing and
// queries, so they stay symmetric) additionally keeps each whitespace-ish
// delimited chunk intact — "10.0.10.0/24", "corp.acme.example",
// "alias/prod-rds", "env=prod", full ARNs — so such values match exactly
// (and by prefix), ranking the right document first.

/** Split points for whole "chunks"; deliberately excludes . / : - _ = * @ so IPs, CIDRs, hostnames, ARNs and aliases survive intact. */
const CHUNK_SPLIT = /[\s,;"'()[\]{}<>`|]+/u;
/** Sub-token split: any run of non-alphanumerics (mirrors MiniSearch's default). */
const PART_SPLIT = /[^\p{L}\p{N}]+/u;
/** Junk punctuation/symbols hugging a chunk ("**core", "prod.internal.", "(eu-west-1)."). */
const EDGE_PUNCT = /^[\p{P}\p{S}]+|[\p{P}\p{S}]+$/gu;
/** Don't store absurdly long chunks whole (their parts still get indexed). */
const MAX_CHUNK = 120;

function tokenize(text: string): string[] {
  const tokens: string[] = [];
  for (const rawChunk of text.split(CHUNK_SPLIT)) {
    const chunk = rawChunk.replace(EDGE_PUNCT, '');
    if (!chunk) continue;
    if (chunk.length <= MAX_CHUNK) tokens.push(chunk);
    const parts = chunk.split(PART_SPLIT).filter(Boolean);
    // Skip the degenerate case where the chunk IS its single part.
    if (parts.length > 1 || parts[0] !== chunk) tokens.push(...parts);
  }
  return tokens;
}

// --- Raw-value flattening ----------------------------------------------------
// Fold every meaningful string/number in ref.raw (the full resource object)
// into one searchable field: private/public IPs, CIDRs, DNS names, endpoints,
// aliases, SG rule CIDRs/ports, related ARNs, descriptions, resolver domains…

/** Top-level keys already indexed in their own (higher-boost) fields. */
const SKIP_TOP_KEYS = new Set(['id', 'arn', 'name', 'tags']);
/** IAM policy JSON blobs (assumeRolePolicyDocument, defaultVersionDocument…) — pure noise. */
const DOCUMENT_KEY = /document$/i;
const MAX_DEPTH = 5; // raw → array → object → array → leaf covers every schema shape
const MAX_STRING = 200; // skip huge opaque strings (inline JSON, base64…)
const MAX_VALUES = 160; // per-doc cap on distinct values…
const CHAR_BUDGET = 4000; // …and on total characters, to bound index growth

function flattenRawValues(raw: Record<string, unknown>): string {
  const seen = new Set<string>();
  let budget = CHAR_BUDGET;
  const walk = (value: unknown, depth: number): void => {
    if (budget <= 0 || seen.size >= MAX_VALUES || value == null) return;
    switch (typeof value) {
      case 'string': {
        const s = value.trim();
        if (s && s.length <= MAX_STRING && !seen.has(s)) {
          seen.add(s);
          budget -= s.length + 1;
        }
        return;
      }
      case 'number': {
        const s = String(value);
        if (!seen.has(s)) {
          seen.add(s);
          budget -= s.length + 1;
        }
        return;
      }
      case 'object': {
        if (depth >= MAX_DEPTH) return;
        if (Array.isArray(value)) {
          for (const v of value) walk(v, depth + 1);
        } else {
          for (const [k, v] of Object.entries(value)) {
            if (DOCUMENT_KEY.test(k)) continue;
            walk(v, depth + 1);
          }
        }
        return;
      }
      default: // booleans, functions… — noise
        return;
    }
  };
  for (const [k, v] of Object.entries(raw)) {
    if (SKIP_TOP_KEYS.has(k) || DOCUMENT_KEY.test(k)) continue;
    walk(v, 1);
  }
  return [...seen].join(' ');
}

export interface SearchBarProps {
  index: AtlasIndex;
  onPick(ref: ResourceRef): void;
}

export function SearchBar({ index, onPick }: SearchBarProps): React.ReactElement {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const blurTimer = useRef<number>(0);
  useEffect(() => () => window.clearTimeout(blurTimer.current), []);

  const mini = useMemo(() => {
    const ms = new MiniSearch<SearchDoc>({
      idField: 'docId',
      fields: ['name', 'resourceId', 'arn', 'kind', 'tags', 'annotation', 'values'],
      tokenize,
      // 'values' is deliberately down-boosted: a resource whose NAME matches
      // must outrank resources that merely reference the term in some field.
      searchOptions: { prefix: true, fuzzy: 0.15, boost: { name: 3, resourceId: 2, values: 0.5 } },
    });
    ms.addAll(
      index.all.map((ref, docId): SearchDoc => {
        const annotation = index.annotationFor(ref);
        const tags = (ref.raw['tags'] ?? {}) as Record<string, string>;
        return {
          docId,
          name: ref.name,
          resourceId: ref.id,
          arn: ref.arn,
          kind: ref.kind,
          tags: Object.entries(tags)
            .map(([k, v]) => `${k}=${v}`)
            .join(' '),
          annotation: [annotation?.title, annotation?.description, ...(annotation?.labels ?? [])]
            .filter(Boolean)
            .join(' '),
          values: flattenRawValues(ref.raw),
        };
      }),
    );
    return ms;
  }, [index]);

  const results = useMemo(() => {
    const q = query.trim();
    if (q.length < 2) return [];
    // Exact whole-query matches win. A resource whose name OR an indexed value
    // (a CloudFront alias, an ACM subject, a hosted-zone name) IS the query —
    // "acme.example" — is more relevant than one that merely matched a sub-token
    // ("acme" in "acme-prod-db"), whatever field carried it. MiniSearch scores
    // the sub-token NAME hits above the exact value hit (name boost) and would
    // otherwise bury it below the result cap; lift exact matches to the front,
    // stable within each tier.
    const full = q.toLowerCase();
    return mini
      .search(q)
      .map((hit, i) => ({ hit, i, exact: (hit.terms ?? []).some((t) => t.toLowerCase() === full) ? 1 : 0 }))
      .sort((a, b) => b.exact - a.exact || a.i - b.i)
      .slice(0, 20)
      .map((x) => x.hit);
  }, [mini, query]);

  return (
    <div className="search-bar">
      <input
        type="search"
        placeholder={`Search ${index.all.length.toLocaleString()} resources — names, IPs, CIDRs, domains, tags…`}
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
        }}
        onFocus={() => {
          // A pending blur timer from the previous focus would immediately
          // close the dropdown we're about to open.
          window.clearTimeout(blurTimer.current);
          setOpen(true);
        }}
        onBlur={() => {
          blurTimer.current = window.setTimeout(() => setOpen(false), 150);
        }}
      />
      {open && results.length > 0 && (
        <div className="search-results">
          {results.map((r) => {
            const ref = index.all[r.id as number];
            if (!ref) return null;
            return (
              <button
                key={r.id as number}
                className="search-result"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  window.clearTimeout(blurTimer.current);
                  setOpen(false);
                  setQuery('');
                  onPick(ref);
                }}
              >
                <span className={`kind-chip kind-${ref.kind}`}>{ref.kind}</span>
                <span className="search-result-name">{ref.name ?? ref.id}</span>
                <span className="search-result-meta">
                  {index.accountLabel(ref.accountId)}
                  {ref.region ? ` · ${ref.region}` : ''}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
