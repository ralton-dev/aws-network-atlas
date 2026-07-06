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
  [key: string]: unknown;
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
      fields: ['name', 'resourceId', 'arn', 'kind', 'tags', 'annotation'],
      searchOptions: { prefix: true, fuzzy: 0.15, boost: { name: 3, resourceId: 2 } },
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
        };
      }),
    );
    return ms;
  }, [index]);

  const results = useMemo(() => {
    if (query.trim().length < 2) return [];
    return mini.search(query).slice(0, 20);
  }, [mini, query]);

  return (
    <div className="search-bar">
      <input
        type="search"
        placeholder={`Search ${index.all.length.toLocaleString()} resources, tags, annotations…`}
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
