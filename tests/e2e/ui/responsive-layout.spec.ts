import type { Page } from '@playwright/test';
import { expect, test } from '../fixtures';

async function expectAccessibleToolbar(page: Page) {
  const toolbar = page.getByTestId('topbar');
  await expect(toolbar).toBeVisible();
  await expect
    .poll(() =>
      toolbar.evaluate((element) => {
        const toolbarBounds = element.getBoundingClientRect();
        const issues: string[] = [];
        if (toolbarBounds.right > innerWidth + 1) issues.push('Toolbar overflows');
        const controls = Array.from(element.querySelectorAll<HTMLButtonElement>('button'));
        for (const control of controls) {
          const rect = control.getBoundingClientRect();
          if (!rect.width || !rect.height) continue;
          // The mobile drawing shelf scrolls horizontally; check controls within its viewport.
          const shelf = control.closest('.drawing-tools')?.getBoundingClientRect();
          if (shelf && (rect.left < shelf.left || rect.right > shelf.right)) continue;
          if (rect.width < 32 || rect.height < 32)
            issues.push(`${control.textContent} is too small`);
          if (rect.right > innerWidth + 1) issues.push(`${control.textContent} overflows`);
          // Disabled undo/redo buttons deliberately do not receive pointer events.
          if (control.disabled) continue;
          const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
          if (!hit || !control.contains(hit)) issues.push(`${control.textContent} is covered`);
        }
        return issues;
      })
    )
    .toEqual([]);
}

for (const viewport of [
  { width: 1920, height: 1080 },
  { width: 1366, height: 768 },
  { width: 1024, height: 768 },
  { width: 768, height: 1024 },
  { width: 390, height: 844 },
  { width: 320, height: 568 },
]) {
  test.describe(`${viewport.width} × ${viewport.height}`, () => {
    test.use({ viewport });
    test('keeps drawing, project and map controls usable', async ({ page, blankProject }) => {
      await expectAccessibleToolbar(page);
      await page.getByTestId('draw-circle-btn').click();
      await expect(page.getByRole('dialog')).toBeVisible();
      await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
      await page.getByTestId('advanced-tools-btn').click();
      await page.getByText('Azimuth Line', { exact: true }).click();
      await expect(page.getByRole('dialog')).toBeVisible();
      await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
      await page.getByTestId('save-menu-btn').click();
      await expect(page.getByTestId('new-project-btn')).toBeVisible();
      await page.keyboard.press('Escape');
      const open = page.getByRole('button', { name: 'Open notebook', exact: true });
      if (await open.isVisible()) await open.click();
      const sidebar = page.getByTestId('layers-sidebar');
      await expect(sidebar).toBeVisible();
      await expect
        .poll(async () => {
          const panel = await sidebar.boundingBox();
          const toolbar = await page.getByTestId('topbar').boundingBox();
          return (
            !!panel &&
            !!toolbar &&
            Math.abs(panel.y - toolbar.height) <= 1 &&
            panel.width < viewport.width
          );
        })
        .toBe(true);
      await page.getByRole('button', { name: 'Hide notebook', exact: true }).click();
      await expect(page.getByRole('button', { name: 'Zoom in', exact: true })).toBeInViewport();
      await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
      await page.getByRole('button', { name: 'Zoom out', exact: true }).click();
    });
  });
}

test('keyboard users can open advanced tools and toggle element groups', async ({
  page,
  blankProject,
}) => {
  await page.getByTestId('advanced-tools-btn').focus();
  await page.keyboard.press('Enter');
  await expect(page.getByText('Azimuth Line', { exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  const points = page.locator('.layers-section-title').filter({ hasText: 'Points' });
  await points.focus();
  await page.keyboard.press('Enter');
  await expect(points).toHaveAttribute('aria-expanded', 'false');
  await page.keyboard.press('Space');
  await expect(points).toHaveAttribute('aria-expanded', 'true');
});

test('group arrows collapse and expand without changing visibility', async ({
  page,
  blankProject,
}) => {
  const group = page.locator('.layers-section-header').filter({ hasText: 'Points' });
  const toggle = group.locator('.layers-section-title');
  const arrow = group.locator('.collapse-icon');
  const visibility = group.locator('.layers-section-actions button');
  const items = page.locator('.layer-item').filter({ hasText: 'Paris' });
  const initialVisibility = await visibility.getAttribute('title');
  await arrow.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(items).not.toBeVisible();
  await expect(visibility).toHaveAttribute('title', initialVisibility!);
  await arrow.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(items).toBeVisible();
  await visibility.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(visibility).not.toHaveAttribute('title', initialVisibility!);
});

test('tool instructions replace the toolbar and keep panels below it while resizing', async ({
  page,
  blankProject,
}) => {
  const normalHeight = (await page.getByTestId('topbar').boundingBox())!.height;
  await page.getByTestId('advanced-tools-btn').click();
  await page.getByText('Free Hand', { exact: true }).click();
  await page.getByRole('button', { name: 'Start Drawing', exact: true }).click();
  const toolbar = page.getByTestId('topbar');
  await expect(toolbar.locator('.navigation-bar')).toBeVisible();
  await expect
    .poll(async () => (await toolbar.boundingBox())!.height)
    .toBe(Math.ceil(normalHeight / 2));
  await expect
    .poll(async () => {
      const bar = await toolbar.locator('.navigation-bar').boundingBox();
      const content = await toolbar.locator('.navigation-bar-content').boundingBox();
      return Math.abs(bar!.y + bar!.height / 2 - (content!.y + content!.height / 2));
    })
    .toBeLessThanOrEqual(1);
  await expect(page.getByTestId('save-menu-btn')).not.toBeVisible();
  for (const width of [1280, 650, 390]) {
    await page.setViewportSize({ width, height: 850 });
    const open = page.getByRole('button', { name: 'Open notebook', exact: true });
    if (await open.isVisible()) await open.click();
    await expect
      .poll(async () => {
        const bar = await toolbar.boundingBox();
        const panel = await page.getByTestId('layers-sidebar').boundingBox();
        const content = await toolbar.locator('.navigation-bar').boundingBox();
        return (
          !!bar &&
          !!panel &&
          !!content &&
          Math.abs(panel.y - (bar.y + bar.height)) <= 1 &&
          content.y >= bar.y &&
          content.y + content.height <= bar.y + bar.height + 1
        );
      })
      .toBe(true);
  }
  await page.getByRole('button', { name: 'Cancel Drawing', exact: true }).click();
  await expect(toolbar.locator('.navigation-bar')).not.toBeVisible();
  await expect(page.getByTestId('save-menu-btn')).toBeVisible();
  await expect
    .poll(async () => {
      const bar = await toolbar.boundingBox();
      const panel = await page.getByTestId('layers-sidebar').boundingBox();
      return !!bar && !!panel && Math.abs(panel.y - (bar.y + bar.height)) <= 1;
    })
    .toBe(true);
});
