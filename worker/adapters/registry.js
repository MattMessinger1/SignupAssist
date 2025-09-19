import { tableStrategy } from './strategies/tableStrategy.js';
import { cardStrategy } from './strategies/cardStrategy.js';
import { LAYOUTS } from './types.js';

export const strategies = [tableStrategy, cardStrategy];

export async function pickAdapter(page) {
  for (const s of strategies) {
    const layout = await s.detectLayout(page);
    if (layout !== LAYOUTS.UNKNOWN) return s;
  }
  return cardStrategy; // sensible default
}