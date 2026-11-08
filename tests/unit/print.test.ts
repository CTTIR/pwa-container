import { describe, expect, it } from 'vitest';
import { SLIPS_PER_PAGE, slipPages } from '../../shared/slips.ts';

describe('code slips', () => {
  const codes = Array.from({ length: 23 }, (_, i) => `C${i}`);

  it('fills every printed page with whole slips only', () => {
    const compact = slipPages(codes, SLIPS_PER_PAGE.compact);
    expect(compact.map((p) => p.length)).toEqual([10, 10, 3]);
    expect(compact.flat()).toEqual(codes);
    const single = slipPages(codes, SLIPS_PER_PAGE.single);
    expect(single).toHaveLength(23);
    expect(single.every((p) => p.length === 1)).toBe(true);
    expect(slipPages([], SLIPS_PER_PAGE.compact)).toEqual([]);
  });
});
