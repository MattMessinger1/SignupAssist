import { LAYOUTS } from '../types.js';

export const cardStrategy = {
  async detectLayout(page) {
    const cards = page.locator('.views-row, .card, article');
    return (await cards.count()) ? LAYOUTS.CARDS : LAYOUTS.UNKNOWN;
  },
  
  async openListing(page, baseUrl) {
    if (!/\/registration$/.test(page.url())) {
      await page.goto(`${baseUrl}/registration`, { waitUntil: 'networkidle' });
    }
  },
  
  async findProgramContainer(page, nameRe) {
    const cards = page.locator('.views-row, .card, article');
    const n = await cards.count();
    for (let i = 0; i < Math.min(n, 300); i++) {
      const c = cards.nth(i);
      const t = ((await c.innerText().catch(()=>'')) || '').toLowerCase();
      if (/skip to main content|account\s+dashboard|memberships|programs|events|view search filters/i.test(t)) continue;
      if (nameRe.test(t)) return { container: c, layout: LAYOUTS.CARDS };
    }
    return { container: null, layout: LAYOUTS.CARDS };
  },
  
  async clickRegisterInContainer(page, container) {
    let btn = container.locator('a.btn.btn-secondary.btn-sm:has-text("Register"), a[href*="/registration/"][href$="/start"]').first();
    if (!(await btn.count())) {
      const details = container.locator('a:has-text("Read Description")').first();
      if (await details.count()) {
        await details.click().catch(()=>{});
        await page.waitForLoadState('networkidle');
        btn = page.locator('a.btn.btn-secondary.btn-sm:has-text("Register"), a[href*="/registration/"][href$="/start"]').first();
      }
    }
    await btn.scrollIntoViewIfNeeded().catch(()=>{});
    await btn.click();
  },
};