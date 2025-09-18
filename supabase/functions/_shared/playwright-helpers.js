// Shared Playwright helper functions for edge functions

/**
 * Scrolls until a selector becomes visible or throws after max attempts
 * @param page Playwright page instance
 * @param selector CSS selector to find and scroll to
 * @param maxScrolls Maximum number of scroll attempts (default: 20)
 * @returns The visible element
 * @throws Error if element not found or not visible after maxScrolls
 */
export async function scrollUntilVisible(page: any, selector: string, maxScrolls = 20) {
  for (let i = 0; i < maxScrolls; i++) {
    const element = page.locator(selector).first();
    if (await element.count()) {
      try {
        await element.scrollIntoViewIfNeeded();
        await element.waitFor({ state: "visible", timeout: 2000 });
        return element;
      } catch {
        // continue scrolling
      }
    }
    // scroll down a bit and retry
    await page.mouse.wheel(0, 400);
    await page.waitForTimeout(200);
  }
  throw new Error(`Element not visible for selector: ${selector}`);
}