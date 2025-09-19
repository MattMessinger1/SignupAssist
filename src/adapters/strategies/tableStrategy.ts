import type { ListingAdapter, Layout } from '../types';

export const tableStrategy: ListingAdapter = {
  async detectLayout(page) {
    const table = page.locator('main table:has(th:has-text("Title")):has(th:has-text("Register"))').first();
    return (await table.count()) ? 'table' : 'unknown';
  },
  async openListing(page, baseUrl) {
    if (!/\/registration$/.test(page.url())) {
      await page.goto(`${baseUrl}/registration`, { waitUntil: 'networkidle' });
    }
  },
  async findProgramContainer(page, nameRe) {
    const table = page.locator('main table:has(th:has-text("Title")):has(th:has-text("Register"))').first();
    if (!(await table.count())) return { container: null, layout: 'unknown' as Layout };
    const rows = table.locator('tbody > tr');
    const n = await rows.count();
    for (let i = 0; i < n; i++) {
      const row = rows.nth(i);
      const txt = ((await row.innerText().catch(()=>'')) || '').toLowerCase();
      if (nameRe.test(txt)) return { container: row, layout: 'table' };
    }
    return { container: null, layout: 'table' };
  },
  async clickRegisterInContainer(_page, container) {
    const btn = container.locator('a.btn.btn-secondary.btn-sm:has-text("Register"), a[href*="/registration/"][href$="/start"]').first();
    await btn.scrollIntoViewIfNeeded().catch(()=>{});
    await btn.click();
  },
};