import { LAYOUTS } from '../types.js';

export const tableStrategy = {
  async detectLayout(page) {
    const table = page.locator('main table:has(th:has-text("Title")):has(th:has-text("Register"))').first();
    return (await table.count()) ? LAYOUTS.TABLE : LAYOUTS.UNKNOWN;
  },
  
  async openListing(page, baseUrl) {
    if (!/\/registration$/.test(page.url())) {
      await page.goto(`${baseUrl}/registration`, { waitUntil: 'networkidle' });
    }
  },
  
  async findProgramContainer(page, nameRe) {
    const table = page.locator('main table:has(th:has-text("Title")):has(th:has-text("Register"))').first();
    if (!(await table.count())) return { container: null, layout: LAYOUTS.UNKNOWN };
    const rows = table.locator('tbody > tr');
    const n = await rows.count();
    for (let i = 0; i < n; i++) {
      const row = rows.nth(i);
      const txt = ((await row.innerText().catch(()=>'')) || '').toLowerCase();
      if (nameRe.test(txt)) return { container: row, layout: LAYOUTS.TABLE };
    }
    return { container: null, layout: LAYOUTS.TABLE };
  },
  
  async clickRegisterInContainer(_page, container) {
    const btn = container.locator('a.btn.btn-secondary.btn-sm:has-text("Register"), a[href*="/registration/"][href$="/start"]').first();
    await btn.scrollIntoViewIfNeeded().catch(()=>{});
    await btn.click();
  },
};