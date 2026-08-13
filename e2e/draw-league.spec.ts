import { expect, test, type APIRequestContext, type BrowserContext, type Page, type TestInfo } from 'playwright/test';
import type { Draw } from '../shared/draw/contracts';

interface CreatedLeague {
  invitationLink: string;
  returnLink: string;
}

function collectConsoleErrors(context: BrowserContext): string[] {
  const errors: string[] = [];
  context.on('page', (page) => {
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });
    page.on('pageerror', (error) => errors.push(error.message));
  });
  return errors;
}

async function verifyNarrowComposition(page: Page, testInfo: TestInfo, width: number, height: number): Promise<void> {
  await page.setViewportSize({ width, height });
  await page.goto('/?enter=1&slam=wimbledon-men');
  await page.evaluate(() => document.fonts.ready);
  await expect(page.getByRole('button', { name: 'Start a private league' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Run the draw' })).toBeVisible();
  await expect(page.getByRole('radio', { name: 'Board' })).toBeVisible();
  await expect(page.getByRole('radio', { name: 'Radial' })).toBeVisible();
  await expect(page.getByRole('radio', { name: 'Radial' })).toHaveAttribute('aria-checked', 'true');
  await expectSoundControl(page);

  const geometry = await page.evaluate(() => {
    const visible = [...document.querySelectorAll<HTMLElement>(
      'button, a[href], input, select, textarea, [role="button"], [role="radio"]',
    )].filter((element, index, elements) => {
      const box = element.getBoundingClientRect();
      return box.width > 0
        && box.height > 0
        && element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
        && elements.indexOf(element) === index;
    }).map((element) => {
      const box = element.getBoundingClientRect();
      return {
        name: element.getAttribute('aria-label') || element.textContent?.trim() || element.tagName,
        x: box.x,
        y: box.y,
        width: box.width,
        height: box.height,
        right: box.right,
        bottom: box.bottom,
      };
    });
    return {
      controls: visible,
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
      scrollHeight: document.documentElement.scrollHeight,
      field: document.querySelector<HTMLElement>('.field')?.getBoundingClientRect().toJSON(),
      radial: document.querySelector<HTMLElement>('.bracket')?.getBoundingClientRect().toJSON(),
    };
  });
  expect(geometry.scrollWidth).toBe(geometry.clientWidth);
  expect(geometry.field).toMatchObject({ x: 0, width });
  expect(geometry.radial).toBeTruthy();
  for (const control of geometry.controls) {
    expect(control.width, `${control.name} width at ${width}x${height}`).toBeGreaterThanOrEqual(44);
    expect(control.height, `${control.name} height at ${width}x${height}`).toBeGreaterThanOrEqual(44);
    expect(control.x, `${control.name} left clipping at ${width}x${height}`).toBeGreaterThanOrEqual(0);
    expect(control.right, `${control.name} right clipping at ${width}x${height}`).toBeLessThanOrEqual(width);
    expect(control.y, `${control.name} top clipping at ${width}x${height}`).toBeGreaterThanOrEqual(0);
    expect(control.bottom, `${control.name} bottom clipping at ${width}x${height}`).toBeLessThanOrEqual(geometry.scrollHeight);
  }
  for (let left = 0; left < geometry.controls.length; left += 1) {
    for (let right = left + 1; right < geometry.controls.length; right += 1) {
      const a = geometry.controls[left]!;
      const b = geometry.controls[right]!;
      const overlapWidth = Math.min(a.right, b.right) - Math.max(a.x, b.x);
      const overlapHeight = Math.min(a.bottom, b.bottom) - Math.max(a.y, b.y);
      expect(
        overlapWidth > 0 && overlapHeight > 0,
        `${a.name} overlaps ${b.name} at ${width}x${height}`,
      ).toBe(false);
    }
  }

  await testInfo.attach(`draw-radial-${width}x${height}`, {
    body: await page.screenshot({ fullPage: true }),
    contentType: 'image/png',
  });
  await page.getByRole('radio', { name: 'Board' }).click();
  await expect(page.getByRole('radio', { name: 'Board' })).toHaveAttribute('aria-checked', 'true');
  const board = await page.locator('.broadcast canvas').boundingBox();
  expect(board).not.toBeNull();
  expect(board!.x).toBeGreaterThanOrEqual(0);
  expect(board!.x + board!.width).toBeLessThanOrEqual(width);
  await testInfo.attach(`draw-board-${width}x${height}`, {
    body: await page.screenshot({ fullPage: true }),
    contentType: 'image/png',
  });
}

async function verifyWideComposition(page: Page, testInfo: TestInfo, width: number, height: number): Promise<void> {
  await page.setViewportSize({ width, height });
  await page.goto('/?enter=1&slam=wimbledon-men');
  await page.evaluate(() => document.fonts.ready);
  const controls = [
    // The-draw arms sound on by default and persists the choice (see
    // src/audio/sound.tsx), unlike source's session-only/off-by-default
    // model, so the accessible name can read "Sound off" or "Sound on"
    // here depending on prior gestures in this run. This check only needs a
    // stable handle on the control for layout/overlap verification.
    page.getByRole('button', { name: /Sound (?:off|on)/ }),
    page.getByRole('button', { name: 'Start a private league' }),
    page.getByRole('button', { name: 'Run the draw' }),
    page.getByRole('radio', { name: 'Board' }),
    page.getByRole('radio', { name: 'Radial' }),
  ];
  const boxes = [];
  for (const control of controls) {
    await expect(control).toBeVisible();
    const box = await control.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(width);
    boxes.push(box!);
  }

  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
  for (let left = 0; left < boxes.length; left += 1) {
    for (let right = left + 1; right < boxes.length; right += 1) {
      const a = boxes[left]!;
      const b = boxes[right]!;
      const overlapWidth = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
      const overlapHeight = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
      expect(overlapWidth > 0 && overlapHeight > 0, `${width}x${height} control overlap`).toBe(false);
    }
  }
  await testInfo.attach(`draw-board-${width}x${height}`, {
    body: await page.screenshot({ fullPage: true }),
    contentType: 'image/png',
  });
  await page.getByRole('radio', { name: 'Radial' }).click();
  await expect(page.getByRole('radio', { name: 'Radial' })).toHaveAttribute('aria-checked', 'true');
  const radial = await page.locator('.bracket').boundingBox();
  expect(radial).not.toBeNull();
  expect(radial!.x).toBeGreaterThanOrEqual(0);
  expect(radial!.x + radial!.width).toBeLessThanOrEqual(width);
  await testInfo.attach(`draw-radial-${width}x${height}`, {
    body: await page.screenshot({ fullPage: true }),
    contentType: 'image/png',
  });
}

async function expectSoundControl(page: Page): Promise<void> {
  const control = page.getByRole('button', { name: /Sound (?:off|on)/ });
  await expect(control).toBeVisible();
  const box = await control.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.width).toBeGreaterThanOrEqual(44);
  expect(box!.height).toBeGreaterThanOrEqual(44);
  await expect(control).toHaveAttribute('aria-pressed', /^(?:true|false)$/);
}

async function verifyLeagueScrollGeometry(
  page: Page,
  testInfo: TestInfo,
  label: string,
  width: number,
  height: number,
): Promise<void> {
  await page.setViewportSize({ width, height });
  await expect(page.locator('.league-layer')).toBeVisible();
  const geometry = await page.evaluate(() => {
    const owner = document.querySelector<HTMLElement>('.league-layer')!;
    const header = document.querySelector<HTMLElement>('.mark')!;
    const ownerBox = owner.getBoundingClientRect();
    const headerBox = header.getBoundingClientRect();
    const nestedOwners = [...owner.querySelectorAll<HTMLElement>('*')]
      .filter((element) => {
        const style = getComputedStyle(element);
        return element.scrollHeight > element.clientHeight + 1
          && (style.overflowY === 'auto' || style.overflowY === 'scroll');
      })
      .map((element) => element.className);
    return {
      owner: ownerBox.toJSON(),
      header: headerBox.toJSON(),
      nestedOwners,
      clientHeight: owner.clientHeight,
      scrollHeight: owner.scrollHeight,
    };
  });
  expect(geometry.owner.y, `${label} owner starts below header at ${width}x${height}`)
    .toBeGreaterThanOrEqual(Math.floor(geometry.header.bottom));
  expect(geometry.owner.bottom).toBeLessThanOrEqual(height);
  expect(geometry.nestedOwners, `${label} has one vertical scroll owner at ${width}x${height}`).toEqual([]);

  const maxScroll = geometry.scrollHeight - geometry.clientHeight;
  for (const [position, scrollTop] of [
    ['top', 0],
    ['mid', Math.round(maxScroll / 2)],
    ['bottom', maxScroll],
  ] as const) {
    const owner = page.locator('.league-layer');
    await owner.evaluate(async (element, nextTop) => {
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      });
      element.style.scrollBehavior = 'auto';
      element.scrollTo({ top: element.scrollTop, behavior: 'auto' });
      element.scrollTo({ top: nextTop, behavior: 'auto' });
    }, scrollTop);
    await expect.poll(
      () => owner.evaluate((element) => element.scrollTop),
      { message: `${label} ${position} settles at ${width}x${height}` },
    ).toBeGreaterThanOrEqual(Math.max(0, scrollTop - 4));
    await expect.poll(
      () => owner.evaluate((element) => element.scrollTop),
      { message: `${label} ${position} remains settled at ${width}x${height}` },
    ).toBeLessThanOrEqual(scrollTop + 4);
    const frame = await page.evaluate(() => {
      const owner = document.querySelector<HTMLElement>('.league-layer')!;
      const header = document.querySelector<HTMLElement>('.mark')!.getBoundingClientRect();
      const ownerBox = owner.getBoundingClientRect();
      const visibleContent = [...owner.querySelectorAll<HTMLElement>(
        'h1, h2, button, input, .champion-ceremony, .round-paper-body section, .submitted-path li',
      )].map((element) => ({ name: element.textContent?.trim(), box: element.getBoundingClientRect().toJSON() }))
        .filter(({ box }) => box.bottom > ownerBox.top && box.top < ownerBox.bottom);
      return { scrollTop: owner.scrollTop, header: header.toJSON(), owner: ownerBox.toJSON(), visibleContent };
    });
    expect(
      Math.abs(frame.scrollTop - scrollTop),
      `${label} ${position} scroll position at ${width}x${height}`,
    ).toBeLessThanOrEqual(4);
    for (const item of frame.visibleContent) {
      const visibleTop = Math.max(item.box.top, frame.owner.top);
      const visibleBottom = Math.min(item.box.bottom, frame.owner.bottom);
      expect(
        visibleTop < frame.header.bottom && visibleBottom > frame.header.top,
        `${label} ${position}: ${item.name} intersects Draw header at ${width}x${height}`,
      ).toBe(false);
    }

    await testInfo.attach(`${label}-${position}-${width}x${height}`, {
      body: await page.screenshot(),
      contentType: 'image/png',
    });
  }
}

async function expectLeagueScrollTop(page: Page): Promise<void> {
  await expect.poll(() => page.locator('.league-layer').evaluate((element) => element.scrollTop)).toBeLessThanOrEqual(1);
}

function token(link: string, kind: 'invite' | 'return'): string {
  const value = new URL(link).hash.slice(`#${kind}=`.length);
  if (!value) throw new Error(`missing ${kind} capability`);
  return value;
}

function completePicks(draw: Draw): Record<string, string> {
  const picks: Record<string, string> = {};
  for (const round of draw.rounds) {
    for (const match of round.matches) {
      picks[match.id] = round.round === 1
        ? match.sides[0]!.player
        : picks[`r${round.round - 1}m${match.position * 2 + 1}`]!;
    }
  }
  return picks;
}

function privateHeaders(capability: string): Record<string, string> {
  return {
    authorization: `Bearer ${capability}`,
    origin: 'http://127.0.0.1:43175',
    'content-type': 'application/json',
  };
}

async function draftAndSubmit(request: APIRequestContext, returnToken: string): Promise<void> {
  const initial = await request.get('/api/draw/draft', {
    headers: { authorization: `Bearer ${returnToken}` },
  });
  expect(initial.status()).toBe(200);
  const draft = await initial.json() as { version: number; draw: Draw };
  const saved = await request.put('/api/draw/draft', {
    headers: privateHeaders(returnToken),
    data: { expectedVersion: draft.version, picks: completePicks(draft.draw) },
  });
  expect(saved.status()).toBe(200);
  const savedBody = await saved.json() as { version: number };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const submission = await request.post('/api/draw/submissions', {
      headers: privateHeaders(returnToken),
      data: { expectedDraftVersion: savedBody.version },
    });
    expect(submission.status()).toBe(201);
  }
}

async function control(request: APIRequestContext, action: string): Promise<void> {
  const response = await request.post(`/__draw-e2e/control/${action}`);
  expect(response.status()).toBe(200);
}

async function createLeagueForEvent(request: APIRequestContext, eventSlug: string): Promise<CreatedLeague> {
  const response = await request.post('/api/draw/leagues', {
    headers: {
      origin: 'http://127.0.0.1:43175',
      'idempotency-key': `direct-${eventSlug.replaceAll(/[^a-z0-9]/g, '-')}`,
    },
    data: { eventSlug, leagueName: 'Paris friends', displayName: 'Direct visitor' },
  });
  expect(response.status()).toBe(201);
  return response.json() as Promise<CreatedLeague>;
}

async function createThroughBrowser(context: BrowserContext, testInfo?: TestInfo): Promise<CreatedLeague> {
  const page = await context.newPage();
  await page.setViewportSize({ width: 320, height: 568 });
  await page.goto('/?enter=1&slam=wimbledon-men');
  await expectSoundControl(page);
  await page.getByRole('button', { name: 'Start a private league' }).click();
  await expectSoundControl(page);
  await testInfo?.attach('league-create-320x568', {
    body: await page.screenshot({ fullPage: true }),
    contentType: 'image/png',
  });
  await page.getByLabel('League name').fill('Baseline friends');
  await page.getByLabel('Your display name').fill('Creator');
  await page.getByRole('button', { name: 'Create private league' }).click();
  await expectLeagueScrollTop(page);
  await expectSoundControl(page);
  await testInfo?.attach('league-links-320x568', {
    body: await page.screenshot({ fullPage: true }),
    contentType: 'image/png',
  });
  const invitationLink = await page.getByLabel('Invitation link').inputValue();
  const returnLink = await page.getByLabel('Private return link').inputValue();
  await page.getByRole('button', { name: 'Start picking' }).click();
  await expectLeagueScrollTop(page);
  await expect(page.getByText('Baseline friends')).toBeVisible();
  await expectSoundControl(page);
  await testInfo?.attach('league-prediction-empty-320x568', {
    body: await page.screenshot({ fullPage: true }),
    contentType: 'image/png',
  });
  await page.close();
  return { invitationLink, returnLink };
}

test('standalone Express serves the Draw SPA at root without weakening private routes', async ({ request }) => {
  // Every non-API path is the SPA's client-side router boundary, not a distinct
  // app: root, a deep client route, and a wholly unknown path must all render
  // the same shell with the same locked-down CSP.
  for (const path of ['/', '/leagues/deep-client-route', '/not-a-published-route']) {
    const response = await request.get(path);
    expect(response.status()).toBe(200);
    expect(response.headers()['cache-control']).toBe('no-store');
    const csp = response.headers()['content-security-policy'] ?? '';
    expect(csp).toContain("script-src 'self' blob:");
    expect(csp).toContain("font-src 'self' data:");
    expect(csp).toContain("worker-src 'self' blob:");
    expect(csp).toContain("connect-src 'self'");
    const scriptPolicy = csp.match(/(?:^|;\s*)script-src ([^;]+)/)?.[1] ?? '';
    expect(scriptPolicy).not.toContain("'unsafe-inline'");
    expect(scriptPolicy).not.toContain("'unsafe-eval'");
    expect(csp).not.toContain('https:');
    expect(csp).not.toContain('*');
    expect(await response.text()).toContain('<title>The Draw</title>');
  }
  const html = await (await request.get('/')).text();
  const assetPath = html.match(/(?:src|href)="(\/assets\/[^"]+)"/)?.[1];
  expect(assetPath).toBeTruthy();
  const asset = await request.get(assetPath!);
  expect(asset.status()).toBe(200);
  expect(asset.headers()['cache-control']).toBe('public, max-age=31536000, immutable');
  expect(assetPath).toMatch(/-[A-Za-z0-9_-]+\.(?:js|css)$/);

  const drawApi = await request.get('/api/draw/league');
  expect(drawApi.status()).toBe(404);
  expect(drawApi.headers()['cache-control']).toBe('no-store');
  const unknownApi = await request.get('/api/not-a-real-endpoint');
  expect(unknownApi.status()).toBe(404);
  expect(unknownApi.headers()['content-type']).toContain('application/json');
});

test('production Draw keeps every target viewport and both compositions intact under its CSP', async ({ browser }, testInfo) => {
  const context = await browser.newContext();
  const errors = collectConsoleErrors(context);
  const page = await context.newPage();
  await verifyNarrowComposition(page, testInfo, 320, 568);
  await verifyNarrowComposition(page, testInfo, 320, 844);
  await verifyNarrowComposition(page, testInfo, 390, 844);
  await verifyWideComposition(page, testInfo, 1280, 800);
  await verifyWideComposition(page, testInfo, 1440, 900);
  expect(errors).toEqual([]);
  await context.close();
});

// The-draw's sound model (src/audio/sound.tsx) is a deliberate, documented
// departure from source's contract: sound is ON by intent from the first
// visit, arms itself on whatever gesture the visitor makes first (autoplay
// policy means it cannot start without one), and the visitor's choice is
// persisted to localStorage across reloads rather than being session-only.
// This test verifies that actual contract instead of source's narrower one.
test('sound is on by default, auto-arms on first gesture, persists across reloads, and stays keyboard operable independent of reduced motion', async ({ browser }) => {
  const context = await browser.newContext({ reducedMotion: 'reduce' });
  const page = await context.newPage();
  await page.addInitScript(() => {
    const NativeAudioContext = window.AudioContext;
    let contexts = 0;
    if (NativeAudioContext) {
      window.AudioContext = class extends NativeAudioContext {
        constructor(options?: AudioContextOptions) {
          super(options);
          contexts += 1;
        }
      };
    }
    Object.defineProperty(window, '__soundProof', {
      value: { contexts: () => contexts },
    });
  });
  const soundContexts = () =>
    page.evaluate(() => (window as unknown as { __soundProof: { contexts: () => number } }).__soundProof.contexts());

  await page.goto('/?enter=1&slam=wimbledon-men');
  await expectSoundControl(page);

  // Fresh visit: on by intent, but not yet armed — no AudioContext until a gesture.
  await expect(page.getByRole('button', { name: 'Sound on — starts when you touch the board' })).toHaveAttribute('aria-pressed', 'true');
  expect(await soundContexts()).toBe(0);

  // Any gesture arms the bed automatically, without a "click to enable audio" nag.
  await page.locator('main').dispatchEvent('pointerdown');
  await expect(page.getByRole('button', { name: 'Sound on — mute' })).toHaveAttribute('aria-pressed', 'true');
  expect(await soundContexts()).toBe(1);

  // The control stays keyboard operable once armed.
  await page.getByRole('button', { name: 'Sound on — mute' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: 'Sound off — turn on ambient sound' })).toHaveAttribute('aria-pressed', 'false');

  // Unlike source's session-only model, the muted choice survives a reload.
  await page.reload();
  await expect(page.getByRole('button', { name: 'Sound off — turn on ambient sound' })).toHaveAttribute('aria-pressed', 'false');
  expect(await soundContexts()).toBe(0);

  // Turning it back on via keyboard re-arms immediately (the click itself is the gesture).
  await page.getByRole('button', { name: 'Sound off — turn on ambient sound' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: 'Sound on — mute' })).toHaveAttribute('aria-pressed', 'true');
  expect(await soundContexts()).toBe(1);

  await context.close();
});

test('sound control remains available through title, private loading, and private error states', async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto('/');
  await expectSoundControl(page);
  await page.route('**/api/draw/league', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    await route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"invalid_access"}' });
  });
  await page.goto('/?capability=1#return=not-a-real-capability');
  await expect(page.getByRole('heading', { name: 'Opening your league' })).toBeVisible();
  await expectSoundControl(page);
  await expect(page.getByRole('heading', { name: 'This private link is no longer valid' })).toBeVisible();
  await expectSoundControl(page);
  await context.close();
});

test('direct non-default capability uses its verified tournament and keeps the radial backdrop inert', async ({ browser, request }) => {
  const created = await createLeagueForEvent(request, 'french-open-2026-women');
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();

  await page.goto(created.invitationLink);
  await expect(page.locator('.mark-slam')).toHaveText('Roland-Garros');
  await expect(page.locator('.mark-meta')).toContainText("Women's singles");
  await expect(page.getByRole('heading', { name: 'Paris friends' })).toBeVisible();
  await expect(page.locator('.field')).toHaveCount(0);

  await page.close();
  const returnPage = await context.newPage();
  await returnPage.goto(created.returnLink);
  await expect(returnPage.getByRole('heading', { name: 'Build the path to the title' })).toBeVisible();
  const field = returnPage.locator('.field');
  await expect(field).toHaveAttribute('inert', '');
  await expect(field).toHaveAttribute('aria-hidden', 'true');
  await expect(field.locator('.bracket')).toBeAttached();
  await expect(returnPage.getByRole('img', { name: /French Open.*Women's Singles/i })).toHaveCount(0);
  for (let index = 0; index < 10; index += 1) {
    await returnPage.keyboard.press('Tab');
    expect(await returnPage.evaluate(() => document.activeElement?.closest('.field') === null)).toBe(true);
  }

  await context.close();
});

test('compact private-league layers keep one scroll owner and expose a full retry target', async ({ browser }, testInfo) => {
  const context = await browser.newContext();
  const errors = collectConsoleErrors(context);
  const page = await context.newPage();
  await page.setViewportSize({ width: 320, height: 568 });
  await page.goto('/?enter=1&slam=wimbledon-men');
  await page.getByRole('button', { name: 'Start a private league' }).click();
  await page.getByLabel('League name').fill('Geometry friends');
  await page.getByLabel('Your display name').fill('Geometry');
  await page.getByRole('button', { name: 'Create private league' }).click();

  for (const [width, height] of [[320, 568], [320, 844], [390, 844]] as const) {
    await verifyLeagueScrollGeometry(page, testInfo, 'league-links', width, height);
  }

  await page.getByRole('button', { name: 'Start picking' }).click();
  let failedOnce = false;
  await page.route('**/api/draw/draft', async (route) => {
    if (route.request().method() === 'PUT' && !failedOnce) {
      failedOnce = true;
      await route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"temporarily_unavailable"}' });
      return;
    }
    await route.continue();
  });
  await page.locator('.matchup-choices button').first().click();
  const retry = page.getByRole('button', { name: 'Retry save' });
  await expect(retry).toBeVisible();
  const retryGeometry = await retry.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const status = element.closest<HTMLElement>('.save-state')!.getBoundingClientRect();
    const owner = element.closest<HTMLElement>('.league-layer')!.getBoundingClientRect();
    return {
      button: box.toJSON(),
      status: status.toJSON(),
      owner: owner.toJSON(),
      viewport: document.documentElement.clientWidth,
    };
  });
  expect(retryGeometry.button.width).toBeGreaterThanOrEqual(44);
  expect(retryGeometry.button.height).toBeGreaterThanOrEqual(44);
  expect(retryGeometry.status.left).toBeGreaterThanOrEqual(0);
  expect(retryGeometry.status.right).toBeLessThanOrEqual(retryGeometry.viewport);
  expect(retryGeometry.button.top).toBeGreaterThanOrEqual(retryGeometry.owner.top);
  expect(retryGeometry.button.bottom).toBeLessThanOrEqual(retryGeometry.owner.bottom);
  await retry.click();
  await expect(page.locator('.save-state')).toContainText('Saved');

  await page.getByRole('button', { name: 'Fill remaining by seed' }).click();
  await expect(page.locator('.save-state')).toContainText('Saved');
  await page.locator('.round-tabs button').last().click();
  await expect(page.getByText('Your champion', { exact: true })).toBeVisible();
  for (const [width, height] of [[320, 568], [320, 844], [390, 844]] as const) {
    await verifyLeagueScrollGeometry(page, testInfo, 'league-champion', width, height);
  }
  expect(errors.filter((message) => !message.includes('503 (Service Unavailable)'))).toEqual([]);
  expect(errors.some((message) => message.includes('503 (Service Unavailable)'))).toBe(true);
  await context.close();
});

test('full private-league lifecycle holds conflict, accepts correction, exports, removes, and rolls back', async ({ browser, request }, testInfo) => {
  const creatorContext = await browser.newContext({ acceptDownloads: true });
  const creatorConsoleErrors = collectConsoleErrors(creatorContext);
  const created = await createThroughBrowser(creatorContext, testInfo);
  const creatorToken = token(created.returnLink, 'return');
  await draftAndSubmit(creatorContext.request, creatorToken);

  const restored = await creatorContext.request.get('/api/draw/draft', {
    headers: { authorization: `Bearer ${creatorToken}` },
  });
  expect(restored.status()).toBe(200);
  expect((await restored.json() as { version: number }).version).toBe(1);

  const friendContext = await browser.newContext();
  const friendConsoleErrors = collectConsoleErrors(friendContext);
  const invitationProbe = await friendContext.request.get('/api/draw/invitation', {
    headers: { authorization: `Bearer ${token(created.invitationLink, 'invite')}` },
  });
  expect(invitationProbe.status()).toBe(200);
  const friendPage = await friendContext.newPage();
  await friendPage.goto(created.invitationLink);
  await expect(friendPage.getByLabel('Your display name')).toBeVisible();
  await friendPage.getByLabel('Your display name').fill('Friend');
  await friendPage.getByRole('button', { name: 'Join the bracket' }).click();
  const friendReturnLink = await friendPage.getByLabel('Private return link').inputValue();
  const friendToken = token(friendReturnLink, 'return');
  await draftAndSubmit(friendContext.request, friendToken);

  await control(request, 'lock');
  await control(request, 'conflict');
  const held = await creatorContext.request.get('/api/draw/league', {
    headers: { authorization: `Bearer ${creatorToken}` },
  });
  expect(held.status()).toBe(200);
  expect(await held.json()).toMatchObject({
    projection: {
      canonical: { sourceRevisionId: '9001', freshness: { state: 'conflicting' } },
    },
  });

  await control(request, 'round');
  await creatorContext.request.get('/api/draw/league', {
    headers: { authorization: `Bearer ${creatorToken}` },
  });
  const round = await creatorContext.request.get('/api/draw/league', {
    headers: { authorization: `Bearer ${creatorToken}` },
  });
  expect(await round.json()).toMatchObject({
    projection: { canonical: { sourceRevisionId: '9002' }, recap: { state: 'current' } },
  });

  await control(request, 'correction');
  await creatorContext.request.get('/api/draw/league', {
    headers: { authorization: `Bearer ${creatorToken}` },
  });
  const corrected = await creatorContext.request.get('/api/draw/league', {
    headers: { authorization: `Bearer ${creatorToken}` },
  });
  expect(await corrected.json()).toMatchObject({
    projection: {
      canonical: { sourceRevisionId: '9003', corrected: true },
      recap: { state: 'current', viewModel: { acceptedRevisionId: expect.any(String) } },
    },
  });

  const recapPage = await creatorContext.newPage();
  await recapPage.setViewportSize({ width: 1440, height: 900 });
  await recapPage.goto(created.returnLink);
  await expect(recapPage.getByText('Correction replayed')).toBeVisible();
  await expect(recapPage.getByRole('heading', { name: 'Baseline friends' })).toBeVisible();
  await expectSoundControl(recapPage);
  await testInfo.attach('league-standings-recap-1440x900', {
    body: await recapPage.screenshot({ fullPage: true }),
    contentType: 'image/png',
  });
  for (const [width, height] of [[320, 568], [320, 844], [390, 844]] as const) {
    await verifyLeagueScrollGeometry(recapPage, testInfo, 'league-standings-recap', width, height);
    await recapPage.getByRole('button', { name: /Creator/ }).click();
    await expect(recapPage.getByRole('heading', { name: 'Creator' })).toBeVisible();
    const pathBox = await recapPage.locator('.path-pane').boundingBox();
    const headerBox = await recapPage.locator('.mark').boundingBox();
    expect(pathBox).not.toBeNull();
    expect(headerBox).not.toBeNull();
    expect(pathBox!.y).toBeGreaterThanOrEqual(headerBox!.y + headerBox!.height);
  }
  await recapPage.setViewportSize({ width: 1440, height: 900 });
  const downloadStarted = recapPage.waitForEvent('download');
  await recapPage.getByRole('button', { name: 'Download round paper' }).click();
  const download = await downloadStarted;
  expect(download.suggestedFilename()).toMatch(/\.png$/);
  expect(await download.failure()).toBeNull();

  const removed = await friendContext.request.delete('/api/draw/participant', {
    headers: privateHeaders(friendToken),
  });
  expect(removed.status()).toBe(200);
  expect((await friendContext.request.get('/api/draw/league', {
    headers: { authorization: `Bearer ${friendToken}` },
  })).status()).toBe(404);
  await recapPage.reload();
  await expect(recapPage.getByRole('button', { name: 'Removed player' })).toBeVisible();
  await expectSoundControl(recapPage);
  await recapPage.setViewportSize({ width: 390, height: 844 });
  await testInfo.attach('league-removed-390x844', {
    body: await recapPage.screenshot({ fullPage: true }),
    contentType: 'image/png',
  });

  await control(request, 'rollback');
  const blockedCreation = await request.post('/api/draw/leagues', {
    headers: { origin: 'http://127.0.0.1:43175', 'content-type': 'application/json' },
    data: { eventSlug: 'wimbledon-2026-men', leagueName: 'Blocked', displayName: 'No seat' },
  });
  expect(blockedCreation.status()).not.toBe(201);
  const blockedMutation = await creatorContext.request.put('/api/draw/draft', {
    headers: privateHeaders(creatorToken),
    data: { expectedVersion: 1, picks: {} },
  });
  expect(blockedMutation.status()).not.toBe(200);
  expect((await creatorContext.request.get('/api/draw/league', {
    headers: { authorization: `Bearer ${creatorToken}` },
  })).status()).toBe(200);
  expect((await creatorContext.request.delete('/api/draw/participant', {
    headers: privateHeaders(creatorToken),
  })).status()).toBe(200);

  const invariants = await request.get('/__draw-e2e/invariants');
  expect(invariants.status()).toBe(200);
  expect(await invariants.json()).toMatchObject({ ok: true });
  expect(creatorConsoleErrors).toEqual([]);
  expect(friendConsoleErrors).toEqual([]);
  await Promise.all([creatorContext.close(), friendContext.close()]);
});
