import { test } from 'node:test';
import { request as httpRequest } from 'node:http';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createApp, appRoot } from '../server/index.js';
import type { Project } from '../shared/model.js';
import { fileURLToPath } from 'node:url';

test('real HTTP + stdio MCP, browser API, SSE, exports and disk share one model', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wiring-integration-'));
  const { app, store } = await createApp({ dataRoot: dir });
  const http = app.listen(0, '127.0.0.1');
  await new Promise<void>((r) => http.once('listening', r));
  const port = (http.address() as { port: number }).port,
    base = 'http://127.0.0.1:' + port;
  const client = new Client({ name: 'wiring-studio-test', version: '1.0' });
  let bridge: Client | undefined;
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args });
    if (result.isError) throw new Error(JSON.stringify(result.content));
    return JSON.parse((result.content as { text: string }[])[0].text);
  };
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(base + '/mcp')));
    const tools = await client.listTools();
    assert.ok(tools.tools.some((x) => x.name === 'apply_commands'));
    assert.ok(tools.tools.some((x) => x.name === 'export_project'));
    await call('create_project', { id: 'mcp-test', title: 'MCP test' });
    let p = (await call('apply_commands', {
      id: 'mcp-test',
      expectedRevision: 0,
      commands: [
        { op: 'add_component', template: 'resistor', ref: 'R1', x: 200, y: 250 },
        { op: 'add_component', template: 'resistor', ref: 'R2', x: 600, y: 250 },
        { op: 'connect', a: { ref: 'R1', pin: '2' }, b: { ref: 'R2', pin: '1' }, name: 'DATA' },
      ],
    })) as Project;
    assert.equal(p.revision, 1);
    assert.equal(p.nets.length, 1);
    const viaApi = await (await fetch(base + '/api/projects/mcp-test')).json();
    assert.deepEqual(viaApi, p);
    const abort = new AbortController(),
      events = await fetch(base + '/api/events', { signal: abort.signal }),
      reader = events.body!.getReader();
    await reader.read();
    const response = await fetch(base + '/api/projects/mcp-test/commands', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        expectedRevision: 1,
        commands: [{ op: 'place_component', ref: 'R1', x: 350 }],
      }),
    });
    assert.equal(response.status, 200);
    const event = new TextDecoder().decode((await reader.read()).value);
    assert.match(event, /"revision":2/);
    abort.abort();
    p = await call('open_project', { id: 'mcp-test' });
    assert.equal(p.layout.components.R1.x, 350);
    assert.equal(p.revision, 2);
    const bad = await client.callTool({
      name: 'apply_commands',
      arguments: {
        id: 'mcp-test',
        expectedRevision: 2,
        commands: [
          { op: 'place_component', ref: 'R1', x: 900 },
          { op: 'remove_component', ref: 'X404' },
        ],
      },
    });
    assert.ok(bad.isError);
    assert.equal((await store.get('mcp-test')).revision, 2);
    const conflict = await client.callTool({
      name: 'place_component',
      arguments: { id: 'mcp-test', expectedRevision: 1, ref: 'R1', x: 100 },
    });
    assert.ok(conflict.isError);
    assert.match(JSON.stringify(conflict.content), /REVISION_CONFLICT/);
    p = await call('undo', { id: 'mcp-test', expectedRevision: 2 });
    assert.equal(p.layout.components.R1.x, 200);
    p = await call('redo', { id: 'mcp-test', expectedRevision: 3 });
    assert.equal(p.layout.components.R1.x, 350);
    const check = await call('validate_project', { id: 'esp32-led' });
    assert.equal(check.pins, 116);
    assert.equal(check.nets, 24);
    const json = await call('export_project', { id: 'mcp-test', format: 'json' });
    assert.ok(json.path.startsWith(dir + path.sep));
    assert.equal(JSON.parse(await fs.readFile(json.path, 'utf8')).revision, 4);
    for (const format of ['html', 'svg', 'pdf']) {
      const response = await fetch(base + '/api/projects/mcp-test/export/' + format);
      assert.equal(response.status, 200, await response.clone().text());
      const bytes = Buffer.from(await response.arrayBuffer());
      if (format === 'pdf') {
        assert.equal(bytes.subarray(0, 4).toString(), '%PDF');
        const media = bytes.toString('latin1').match(/\/MediaBox\s*\[0 0 ([\d.]+) ([\d.]+)\]/);
        assert.ok(media, 'PDF must expose a page size');
        assert.ok(
          Math.abs(Number(media[1]) - 1684) < 2 && Math.abs(Number(media[2]) - 1191) < 2,
          'A2 landscape size',
        );
      }
      if (format === 'svg') assert.match(bytes.toString(), /data-pin="R1:2"/);
      if (format === 'html') assert.match(bytes.toString(), /WiringRenderer/);
    }
    bridge = new Client({ name: 'bridge-test', version: '1' });
    await bridge.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [
          fileURLToPath(new URL('../node_modules/tsx/dist/cli.mjs', import.meta.url)),
          path.join(appRoot, 'server/stdio.ts'),
        ],
        env: { ...(process.env as Record<string, string>), WIRING_STUDIO_URL: base + '/mcp' },
      }),
    );
    const result = await bridge.callTool({ name: 'open_project', arguments: { id: 'mcp-test' } });
    assert.equal(JSON.parse((result.content as { text: string }[])[0].text).revision, 4);
    const templates = [
      'diode',
      'led',
      'npn',
      'pnp',
      'nmos',
      'pmos',
      'button',
      'potentiometer',
      'inductor',
      'relay',
      'battery',
      'motor',
      'connector3',
      'connector4',
    ];
    const httpLibrary = await (await fetch(base + '/api/library')).json();
    const mcpLibrary = await call('get_library');
    assert.deepEqual(mcpLibrary, httpLibrary);
    for (const template of templates) assert.ok(httpLibrary[template]);
    await call('create_project', { id: 'basic-parts', title: 'Basic parts' });
    const parts = await call('apply_commands', {
      id: 'basic-parts',
      expectedRevision: 0,
      commands: templates.map((template, i) => ({
        op: 'add_component',
        template,
        ref: 'X' + i,
        x: 200 + (i % 5) * 300,
        y: 300 + Math.floor(i / 5) * 300,
      })),
    });
    assert.equal(Object.keys(parts.components).length, templates.length);
    const jsonExport = await (await fetch(base + '/api/projects/basic-parts/export/json')).json();
    assert.deepEqual(jsonExport.components, parts.components);
    for (const format of ['svg', 'pdf', 'html']) {
      const exported = await fetch(base + '/api/projects/basic-parts/export/' + format);
      assert.equal(exported.status, 200);
      const bytes = Buffer.from(await exported.arrayBuffer());
      if (format === 'pdf') assert.equal(bytes.subarray(0, 4).toString(), '%PDF');
      else for (let i = 0; i < templates.length; i++) assert.ok(bytes.toString().includes('X' + i));
    }
    const origin = await fetch(base + '/api/projects', {
      method: 'POST',
      headers: { Origin: 'https://attacker.invalid', 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.equal(origin.status, 403);
    const host = await new Promise<number | undefined>((resolve, reject) => {
      const request = httpRequest(
        base + '/api/projects',
        { headers: { Host: 'attacker.invalid' } },
        (response) => {
          response.resume();
          resolve(response.statusCode);
        },
      );
      request.on('error', reject);
      request.end();
    });
    assert.equal(host, 403);
  } finally {
    await bridge?.close();
    await client.close();
    http.closeAllConnections();
    await new Promise<void>((r) => http.close(() => r()));
    await fs.rm(dir, { recursive: true, force: true });
  }
});
