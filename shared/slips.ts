/** How the code slips are laid out on the printed pages. */
export type SlipLayout = 'compact' | 'single';

/** Slips per printed page: a 2 × 5 grid of cut-out slips, or one large slip per page. */
export const SLIPS_PER_PAGE: Record<SlipLayout, number> = { compact: 10, single: 1 };

/** Splits the codes into printed pages of `perPage` slips each. */
export function slipPages<T>(codes: readonly T[], perPage: number): T[][] {
  const pages: T[][] = [];
  for (let i = 0; i < codes.length; i += perPage) pages.push(codes.slice(i, i + perPage));
  return pages;
}
