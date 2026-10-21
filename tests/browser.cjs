const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
(async () => {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StreamableHTTPClientTransport } =
    await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
  const base = process.env.WIRING_STUDIO_BASE || 'http://127.0.0.1:4317';
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium',
  });
  const context = await browser.newContext({ viewport: { width: 1600, height: 1100 } }),
    page = await context.newPage(),
    errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const client = new Client({ name: 'wiring-studio-browser-tests', version: '1' });
  const checks = [];
  const call = async (name, args) => {
    const result = await client.callTool({ name, arguments: args });
    assert.ok(!result.isError, JSON.stringify(result));
    return JSON.parse(result.content[0].text);
  };
  const wait = async (fn) => {
    const start = Date.now();
    while (!(await fn())) {
      if (Date.now() - start > 15000) throw new Error('Condition timeout');
      await new Promise((r) => setTimeout(r, 100));
    }
  };
  const get = async (id) => (await fetch(base + '/api/projects/' + id)).json();
  try {
    await fs.mkdir('test-results', { recursive: true });
    await client.connect(new StreamableHTTPClientTransport(new URL(base + '/mcp')));
    await page.goto(base);
    await page.waitForSelector('.canvas .component');
    await page.locator('.project-switch select').selectOption('esp32-led');
    await wait(async () => (await page.locator('.canvas .component').count()) === 38);
    assert.equal(await page.locator('.canvas [data-pin]').count(), 116);
    assert.equal(await page.locator('.canvas .pin.nc').count(), 3);
    assert.equal(await page.locator('.canvas .wire-layer').count(), 24);
    assert.equal(await page.locator('.routing-warning').count(), 0);
    checks.push('ESP32: 38 components,116 pins,24 nets,3 NC,no routing warnings');
    await page.screenshot({ path: 'test-results/desktop.png', fullPage: true });
    await page.getByRole('button', { name: 'DATA', exact: true }).click();
    assert.equal(await page.locator('.wire-layer:not(.hidden)').count(), 13);
    await page.getByRole('button', { name: 'Все', exact: true }).click();
    checks.push('wire layers');
    await page.getByRole('textbox', { name: 'Найти компонент' }).fill('U1');
    await page.getByRole('textbox', { name: 'Найти компонент' }).press('Enter');
    assert.equal(await page.locator('.canvas .component.selected').getAttribute('data-ref'), 'U1');
    await page.getByRole('button', { name: '⤢ Увеличить', exact: true }).click();
    assert.ok(await page.locator('dialog').isVisible());
    assert.equal(await page.locator('dialog [data-pin]').count(), 14);
    await page.screenshot({ path: 'test-results/closeup.png' });
    await page.getByRole('button', { name: 'Закрыть', exact: true }).click();
    checks.push('search, focus and DIP closeup');
    const vb = await page.locator('.canvas>svg').getAttribute('viewBox');
    await page.getByRole('button', { name: 'Увеличить', exact: true }).click();
    assert.notEqual(await page.locator('.canvas>svg').getAttribute('viewBox'), vb);
    const zoomed = await page.locator('.canvas>svg').getAttribute('viewBox');
    await page.reload();
    await page.waitForSelector('.canvas .component');
    assert.equal(await page.locator('.canvas>svg').getAttribute('viewBox'), zoomed);
    checks.push('zoom and camera restore after reload');
    await page.getByRole('button', { name: '＋ Проект', exact: true }).click();
    await page.getByLabel('Название', { exact: true }).fill('Browser test ' + Date.now());
    await page.getByRole('button', { name: 'Создать', exact: true }).click();
    await wait(async () => (await page.locator('.canvas .component').count()) === 0);
    const id = await page.locator('.project-switch select').inputValue();
    await page.locator('.palette-item').filter({ hasText: 'Резистор' }).click();
    await wait(async () => (await get(id)).revision === 1);
    let p = await get(id);
    assert.ok(p.components.R1);
    checks.push('new project and component creation from UI');
    await call('apply_commands', {
      id,
      expectedRevision: 1,
      commands: [
        { op: 'place_component', ref: 'R1', x: 300, y: 300 },
        { op: 'add_component', template: 'resistor', ref: 'R2', x: 700, y: 300 },
      ],
    });
    await wait(async () => (await page.locator('.canvas .component').count()) === 2);
    checks.push('MCP edits immediately visible in browser via SSE');
    await page.getByRole('button', { name: '⌁ Провод', exact: true }).click();
    await page.locator('.canvas [data-pin="R1:2"]').click();
    await page.locator('.canvas [data-pin="R2:1"]').click();
    await wait(async () => (await get(id)).nets.length === 1);
    p = await call('open_project', { id });
    assert.equal(p.nets[0].nodes.length, 2);
    checks.push('UI wiring immediately visible through real MCP client');
    const before = JSON.stringify(p.nets);
    let box;
    await wait(async () => {
      box = await page.locator('.canvas [data-ref="R1"] > g > rect').first().boundingBox();
      return !!box;
    });
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 90, box.y + box.height / 2 + 50, { steps: 8 });
    await page.mouse.up();
    await wait(async () => (await get(id)).revision === 4);
    p = await get(id);
    assert.notEqual(p.layout.components.R1.x, 300);
    assert.equal(JSON.stringify(p.nets), before);
    checks.push('pointer dragging persists coordinates and preserves connections');
    await page.getByRole('button', { name: 'Отменить', exact: true }).click();
    await wait(async () => (await get(id)).revision === 5);
    assert.equal((await get(id)).layout.components.R1.x, 300);
    await page.getByRole('button', { name: 'Повторить', exact: true }).click();
    await wait(async () => (await get(id)).revision === 6);
    checks.push('UI undo/redo');
    await page.getByRole('textbox', { name: 'Найти компонент' }).fill('R1');
    await page.getByRole('textbox', { name: 'Найти компонент' }).press('Enter');
    await page.getByRole('button', { name: '↻ 90°', exact: true }).click();
    await wait(async () => (await get(id)).layout.components.R1.rotation === 90);
    assert.equal(JSON.stringify((await get(id)).nets), before);
    checks.push('rotation keeps pin identity and electrical nets');
    const mobile = await context.newPage();
    await mobile.setViewportSize({ width: 390, height: 844 });
    mobile.on('pageerror', (e) => errors.push(e.message));
    await mobile.goto(base);
    await mobile.waitForSelector('.canvas .component');
    assert.ok(await mobile.locator('.canvas').isVisible());
    assert.ok(await mobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await mobile.getByRole('button', { name: '＋ Компоненты', exact: true }).click();
    assert.ok(await mobile.locator('.library').isVisible());
    await mobile.getByRole('button', { name: '＋ Компоненты', exact: true }).click();
    await mobile.screenshot({ path: 'test-results/mobile.png', fullPage: true });
    await mobile.close();
    checks.push('390px layout, canvas and library drawer');
    // Verify autonomous HTML truly runs with every network request blocked.
    const html = await (await fetch(base + '/api/projects/' + id + '/export/html')).text();
    const offline = await browser.newPage({ viewport: { width: 1200, height: 1000 } });
    await offline.route('**/*', (r) => r.abort());
    offline.on('pageerror', (e) => errors.push(e.message));
    await offline.setContent(html);
    await offline.waitForFunction(() => window.studioExport);
    assert.equal(await offline.locator('.component').count(), 2);
    const svg = await offline.evaluate(() => window.studioExport.svg());
    assert.match(svg, /R1:2/);
    await offline.close();
    checks.push('standalone export runs offline with rotated components');
    await page.reload();
    await page.waitForSelector('.canvas .component');
    assert.equal(await page.locator('.canvas .component').count(), 2);
    assert.equal(await page.locator('.canvas .wire-layer').count(), 1);
    checks.push('saved project survives browser reload');
    // Add every new template through the UI, including shared-prefix collisions.
    await page.getByRole('button', { name: '＋ Проект', exact: true }).click();
    await page
      .getByLabel('Название', { exact: true })
      .fill('Browser test basic parts ' + Date.now());
    await page.getByRole('button', { name: 'Создать', exact: true }).click();
    await wait(async () => (await page.locator('.canvas .component').count()) === 0);
    const basicId = await page.locator('.project-switch select').inputValue();
    const basics = [
      ['Диод', 'D1'],
      ['Светодиод', 'D2'],
      ['NPN-транзистор', 'Q1'],
      ['PNP-транзистор', 'Q2'],
      ['N-MOSFET', 'Q3'],
      ['P-MOSFET', 'Q4'],
      ['Кнопка без фиксации', 'SW1'],
      ['Потенциометр', 'RV1'],
      ['Катушка индуктивности', 'L1'],
      ['Реле SPDT', 'K1'],
      ['Батарея', 'BT1'],
      ['Двигатель DC', 'M1'],
      ['3-контактный разъём', 'J1'],
      ['4-контактный разъём', 'J2'],
    ];
    for (const [i, [label, ref]] of basics.entries()) {
      await page
        .locator('.palette-item')
        .filter({ hasText: new RegExp('^' + label) })
        .click();
      await wait(async () => !!(await get(basicId)).components[ref]);
      const current = await get(basicId);
      await call('apply_commands', {
        id: basicId,
        expectedRevision: current.revision,
        commands: [
          {
            op: 'place_component',
            ref,
            x: 180 + (i % 5) * 330,
            y: 280 + Math.floor(i / 5) * 350,
            rotation: [0, 90, 180, 270][i % 4],
          },
        ],
      });
    }
    await wait(async () => (await page.locator('.canvas .component').count()) === 14);
    const basicProject = await get(basicId);
    assert.equal(
      await page.locator('.canvas .pin').count(),
      Object.values(basicProject.components).reduce((n, c) => n + c.pins.length, 0),
    );
    for (const [, ref] of basics) {
      assert.ok(
        await page
          .locator('.canvas [data-ref="' + ref + '"] > g')
          .first()
          .locator('rect, circle, path')
          .count(),
      );
    }
    await page.screenshot({ path: 'test-results/basic-parts.png', fullPage: true });
    await page.getByRole('textbox', { name: 'Найти компонент' }).fill('K1');
    await page.getByRole('textbox', { name: 'Найти компонент' }).press('Enter');
    await page.getByRole('button', { name: '⤢ Увеличить', exact: true }).click();
    assert.equal(await page.locator('dialog [data-pin]').count(), 5);
    await page.screenshot({ path: 'test-results/basic-relay-closeup.png' });
    await page.getByRole('button', { name: 'Закрыть', exact: true }).click();
    const basicHtml = await (
      await fetch(base + '/api/projects/' + basicId + '/export/html')
    ).text();
    const basicOffline = await browser.newPage();
    await basicOffline.route('**/*', (r) => r.abort());
    basicOffline.on('pageerror', (e) => errors.push(e.message));
    await basicOffline.setContent(basicHtml);
    await basicOffline.waitForFunction(() => window.studioExport);
    assert.equal(await basicOffline.locator('.component').count(), 14);
    await basicOffline.close();
    await page.reload();
    await page.waitForSelector('.canvas .component');
    assert.equal(await page.locator('.canvas .component').count(), 14);
    checks.push(
      '14 basic templates: UI creation, unique prefixes, rotated art, pins, relay closeup, offline export and reload',
    );
    assert.deepEqual(errors, []);
    await fs.writeFile(
      'test-results/browser-validation.json',
      JSON.stringify({ passed: true, checks, consoleErrors: errors }, null, 2),
    );
    console.log(JSON.stringify({ passed: true, checks }, null, 2));
  } finally {
    await client.close();
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
