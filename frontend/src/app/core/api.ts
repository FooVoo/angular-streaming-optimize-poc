import { Filters, Meta, Mode, SortState } from './types';

/** Same-origin in dev via the CLI proxy, so HTTP caching behaves realistically. */
export const API = '/api';

export function queryString(
  filters: Filters,
  sort: SortState | null,
  extra: Record<string, string | number | boolean> = {},
): string {
  const params = new URLSearchParams();
  if (filters.q.trim()) params.set('q', filters.q.trim());
  if (filters.status !== null) params.set('status', String(filters.status));
  if (filters.category !== null) params.set('category', String(filters.category));
  if (sort) {
    params.set('sort', sort.key);
    params.set('dir', sort.desc ? 'desc' : 'asc');
  }
  for (const [key, value] of Object.entries(extra)) params.set(key, String(value));
  return params.toString();
}

export function streamUrl(
  mode: Mode,
  filters: Filters,
  sort: SortState | null,
  limit: number,
  compressed: boolean,
): string {
  const extra: Record<string, string | number> = { limit };
  if (!compressed) extra['nobr'] = 1;
  if (mode === 'ndjson-object') extra['shape'] = 'object';
  const path =
    mode === 'arrow' ? 'rows/arrow' : mode === 'datauri' ? 'rows/datauri' : 'rows/ndjson';
  return `${API}/${path}?${queryString(filters, sort, extra)}`;
}

export async function fetchMeta(): Promise<Meta> {
  const response = await fetch(`${API}/meta`);
  if (!response.ok) throw new Error(`meta: HTTP ${response.status}`);
  return response.json() as Promise<Meta>;
}

/** 50k strings, fetched once and reused by every mode. */
export async function fetchTitleDict(): Promise<string[]> {
  const response = await fetch(`${API}/dict/title`);
  if (!response.ok) throw new Error(`dict: HTTP ${response.status}`);
  return response.json() as Promise<string[]>;
}

export async function patchRow(
  id: number,
  patch: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = await fetch(`${API}/rows/${id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  });
  if (!response.ok) throw new Error(await response.text());
  return response.json() as Promise<Record<string, unknown>>;
}
