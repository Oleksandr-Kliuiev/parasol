import { expect, test, type Page } from '@playwright/test';
import { createOrganization, marker, signIn } from './support';

// DEV-18: checks for WCAG 2.2 AA criteria that axe does not decide. They complement a manual pass (evidence/DEV-18.md);
// passing them is not a claim of conformance.

const pages = (organizationId: string): Array<[string, string]> => [
  ['My day', '/'],
  ['Organizations', '/organizations'],
  ['New organization', '/organizations/new'],
  ['Organization', `/organizations/${organizationId}`],
  ['Edit organization', `/organizations/${organizationId}/edit`],
  ['Contracts', '/contracts'],
  ['Pipeline', '/pipeline'],
  ['Quotes', '/quotes'],
  ['Billing runs', '/billing'],
  ['Notifications', '/notifications'],
];

/** Elements that stick out to the right of the viewport, to name the cause of a horizontal scroll. */
const stickingOut = (page: Page) =>
  page.evaluate(() => {
    // The elements that reach furthest right (not fixed), each with the chain up to the body that shows who clips or scrolls.
    const describe = (el: Element) => `${el.tagName.toLowerCase()}.${String(el.className).split(' ')[0]}(${Math.round(el.getBoundingClientRect().right)}|${getComputedStyle(el).overflowX})`;
    return [...document.querySelectorAll('body *')]
      .filter((el) => getComputedStyle(el).position !== 'fixed')
      .sort((x, y) => y.getBoundingClientRect().right - x.getBoundingClientRect().right)
      .slice(0, 3)
      .map((el) => {
        const chain: string[] = [];
        for (let p: Element | null = el; p && p !== document.body; p = p.parentElement) chain.push(describe(p));
        return chain.slice(0, 7).join(' < ');
      });
  });

async function ready(page: Page) {
  await expect(page.locator('main')).toBeVisible();
  await page.waitForLoadState('networkidle');
}

/** 2.5.8 Target size (minimum): a pointer target is at least 24×24 CSS px, unless it is a link inside running text. */
async function undersizedTargets(page: Page) {
  return page.evaluate(() => {
    const selector = 'button, a[href], input:not([type=hidden]), select, textarea, [role=button], [role=tab], [role=menuitem], [role=checkbox], [role=switch], [role=radio], [role=option], [role=combobox]';
    const visible = (el: Element) => {
      const style = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0 && !el.closest('[aria-hidden=true], [inert]');
    };
    const inline = (el: Element) => {
      if (el.tagName !== 'A') return false;
      const parent = el.parentElement;
      if (!parent) return false;
      const own = [...parent.childNodes].filter((n) => n.nodeType === Node.TEXT_NODE && (n.textContent ?? '').trim().length > 0);
      return own.length > 0;
    };
    // A checkbox or radio is drawn inside a larger labelled hit area; the label is the target.
    const labelled = (el: Element) => el instanceof HTMLInputElement && (el.labels?.length ?? 0) > 0 && (el.labels![0]!.getBoundingClientRect().height >= 24);
    const targets = [...document.querySelectorAll(selector)].filter(visible);
    // The spacing exception: a small target passes when a 24 px square centred on it touches no other target.
    const isolated = (el: Element, rect: DOMRect) => {
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      return targets
        .filter((other) => other !== el && !el.contains(other) && !other.contains(el))
        .every((other) => {
          const r = other.getBoundingClientRect();
          return r.right <= cx - 12 || r.left >= cx + 12 || r.bottom <= cy - 12 || r.top >= cy + 12;
        });
    };
    return targets
      .filter((el) => !inline(el) && !labelled(el))
      .map((el) => ({ el, rect: el.getBoundingClientRect() }))
      .filter(({ rect }) => rect.width < 24 || rect.height < 24)
      .filter(({ el, rect }) => !isolated(el, rect))
      .map(({ el, rect }) => `${el.tagName.toLowerCase()}[${el.getAttribute('aria-label') ?? el.textContent?.trim().slice(0, 30) ?? ''}] ${Math.round(rect.width)}×${Math.round(rect.height)}`);
  });
}

test('pointer targets are at least 24×24 px on desktop and on a phone', async ({ page }) => {
  test.setTimeout(180_000);
  await signIn(page, 'Crm.Sales');
  const organization = await createOrganization(page, { name: `${marker('Tgt')} AS` });
  for (const viewport of [{ width: 1280, height: 800 }, { width: 360, height: 740 }]) {
    await page.setViewportSize(viewport);
    for (const [name, path] of pages(organization.id)) {
      await page.goto(path);
      await ready(page);
      expect(await undersizedTargets(page), `${name} at ${viewport.width}px`).toEqual([]);
    }
  }
});

/** 2.4.11 Focus not obscured (minimum): the focused element is not entirely hidden by sticky content such as the header. */
async function obscuredFocus(page: Page, steps: number) {
  const problems: string[] = [];
  for (let i = 0; i < steps; i++) {
    await page.keyboard.press('Tab');
    const result = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el || el === document.body) return null;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return null;
      // Sample the corners and the centre: an element is "entirely hidden" only if none of them reaches it.
      const points = [[0.5, 0.5], [0.1, 0.1], [0.9, 0.1], [0.1, 0.9], [0.9, 0.9]].map(([x, y]) => [rect.left + rect.width * x!, rect.top + rect.height * y!] as const);
      const reachable = points.some(([x, y]) => {
        if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) return false;
        const top = document.elementFromPoint(x, y);
        return top !== null && (el.contains(top) || top.contains(el));
      });
      return reachable ? null : `${el.tagName.toLowerCase()}[${el.getAttribute('aria-label') ?? el.textContent?.trim().slice(0, 30)}]`;
    });
    if (result) problems.push(result);
  }
  return problems;
}

test('keyboard focus is never hidden behind the header or a banner', async ({ page }) => {
  test.setTimeout(180_000);
  await signIn(page, 'Crm.Sales');
  const organization = await createOrganization(page, { name: `${marker('Foc')} AS` });
  for (const viewport of [{ width: 1280, height: 800 }, { width: 360, height: 740 }]) {
    await page.setViewportSize(viewport);
    for (const [name, path] of pages(organization.id).slice(0, 6)) {
      await page.goto(path);
      await ready(page);
      expect(await obscuredFocus(page, 40), `${name} at ${viewport.width}px`).toEqual([]);
    }
  }
});

test('content reflows at 320 px and survives text-spacing overrides', async ({ page }) => {
  test.setTimeout(180_000);
  await signIn(page, 'Crm.Sales');
  const organization = await createOrganization(page, { name: `${marker('Ref')} med et veldig langt navn som må brytes over flere linjer AS` });
  // 320 CSS px is what 400 % zoom on a 1280 px window gives (1.4.10).
  await page.setViewportSize({ width: 320, height: 640 });
  for (const [name, path] of pages(organization.id)) {
    await page.goto(path);
    await ready(page);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow, `${name} scrolls horizontally by ${overflow}px at 320px: ${(await stickingOut(page)).join(' | ')}`).toBeLessThanOrEqual(1);
  }

  // 1.4.12 Text spacing: line height 1.5, paragraph spacing 2×, letter spacing 0.12 em, word spacing 0.16 em lose no content or function.
  await page.setViewportSize({ width: 1280, height: 800 });
  for (const [name, path] of pages(organization.id).slice(0, 6)) {
    await page.goto(path);
    await ready(page);
    await page.addStyleTag({ content: '* { line-height: 1.5 !important; letter-spacing: 0.12em !important; word-spacing: 0.16em !important; } p { margin-bottom: 2em !important; }' });
    const clipped = await page.evaluate(() =>
      [...document.querySelectorAll('button, [role=tab], [role=menuitem], label, th')]
        .filter((el) => {
          const style = getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          return rect.width > 0 && style.overflow !== 'visible' && style.textOverflow !== 'ellipsis' && (el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1);
        })
        .map((el) => `${el.tagName.toLowerCase()}[${el.textContent?.trim().slice(0, 30)}]`),
    );
    expect(clipped, `${name} clips text under text-spacing overrides`).toEqual([]);
  }
});

test('the page is usable at 200 % browser zoom and on a long name', async ({ page }) => {
  await signIn(page, 'Crm.Sales');
  const organization = await createOrganization(page, { name: `${marker('Zoom')} ${'Langtnavn'.repeat(12)} AS` });
  // 200 % zoom of a 1280 px window is 640 CSS px.
  await page.setViewportSize({ width: 640, height: 400 });
  await page.goto(`/organizations/${organization.id}`);
  await ready(page);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow, `scrolls by ${overflow}px: ${(await stickingOut(page)).join(' | ')}`).toBeLessThanOrEqual(1);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await page.getByRole('button', { name: /Open navigation/ }).click();
  await expect(page.getByRole('navigation').getByRole('link', { name: 'Organizations' })).toBeVisible();
});

// DEV-18 item 5: the same pages in Bokmål and Nynorsk, on a phone, with a long customer name — no missing text, nothing
// cut off. (The language comes from the browser; no profile is changed.)
for (const [label, locale] of [['Norwegian', 'nb-NO'], ['Nynorsk', 'nn-NO']] as const) {
  test.describe(`${label} on a phone`, () => {
    test.use({ locale, viewport: { width: 360, height: 740 } });

    test('pages have no missing texts and no horizontal scroll', async ({ page }) => {
      test.setTimeout(180_000);
      await signIn(page, 'Crm.Admin');
      const organization = await createOrganization(page, { name: `${marker('Lang')} Svært Langt Selskapsnavn Utenfor Det Vanlige Teknologi og Rådgivning AS` });
      await page.goto('/organizations');
      await expect(page.getByRole('heading', { level: 1, name: label === 'Norwegian' ? 'Organisasjoner' : 'Organisasjonar' })).toBeVisible();
      for (const [name, path] of pages(organization.id)) {
        await page.goto(path);
        await ready(page);
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        expect(overflow, `${name} scrolls by ${overflow}px: ${(await stickingOut(page)).join(' | ')}`).toBeLessThanOrEqual(1);
        // A key that was not found is shown as its own path (e.g. organizations.fields.name).
        const missing = await page.evaluate(() => (document.body.innerText.match(/\b[a-z]{3,}(?:\.[a-zA-Z]{2,}){2,}\b/g) ?? []).filter((m) => !/\.(no|com|org|dev|local)$/.test(m)));
        expect(missing, `${name} shows untranslated keys`).toEqual([]);
        expect(await undersizedTargets(page), `${name} has small targets`).toEqual([]);
      }
    });
  });
}
