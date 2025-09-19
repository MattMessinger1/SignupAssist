import { tableStrategy } from './strategies/tableStrategy';
import { cardStrategy } from './strategies/cardStrategy';
import type { ListingAdapter } from './types';

export const strategies: ListingAdapter[] = [tableStrategy, cardStrategy];

export async function pickAdapter(page: any): Promise<ListingAdapter> {
  for (const s of strategies) {
    const layout = await s.detectLayout(page);
    if (layout !== 'unknown') return s;
  }
  return cardStrategy; // sensible default
}