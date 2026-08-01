import { queryString, streamUrl } from './api';
import { Filters, SortState } from './types';

const empty: Filters = { q: '', status: null, category: null };

describe('queryString', () => {
  it('omits empty filters', () => {
    expect(queryString(empty, null)).toBe('');
  });

  it('serialises filters and sort', () => {
    const filters: Filters = { q: ' arctic ', status: 2, category: 5 };
    const sort: SortState = { key: 'price', desc: true };
    const params = new URLSearchParams(queryString(filters, sort));
    expect(params.get('q')).toBe('arctic');
    expect(params.get('status')).toBe('2');
    expect(params.get('category')).toBe('5');
    expect(params.get('sort')).toBe('price');
    expect(params.get('dir')).toBe('desc');
  });

  it('keeps a zero status, which is a real enum value and not "unset"', () => {
    expect(new URLSearchParams(queryString({ ...empty, status: 0 }, null)).get('status')).toBe('0');
  });
});

describe('streamUrl', () => {
  it('routes each mode to its endpoint', () => {
    expect(streamUrl('arrow', empty, null, 100, true)).toContain('/api/rows/arrow');
    expect(streamUrl('ndjson', empty, null, 100, true)).toContain('/api/rows/ndjson');
    expect(streamUrl('datauri', empty, null, 100, true)).toContain('/api/rows/datauri');
  });

  it('asks for the object shape only in the object mode', () => {
    expect(streamUrl('ndjson-object', empty, null, 10, true)).toContain('shape=object');
    expect(streamUrl('ndjson', empty, null, 10, true)).not.toContain('shape=');
  });

  it('flags uncompressed runs so the server skips brotli', () => {
    expect(streamUrl('arrow', empty, null, 10, false)).toContain('nobr=1');
    expect(streamUrl('arrow', empty, null, 10, true)).not.toContain('nobr=');
  });
});
