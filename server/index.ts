import express from 'express';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { Store } from './store.js';
import { createMcp } from './mcp.js';
import { importXml } from './import.js';
import { exportProject } from './export.js';
import { report, commandSchema, validateProject, type Visual } from '../shared/model.js';
import { z } from 'zod';
export const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export async function createApp(options: { dataRoot?: string; dev?: boolean } = {}) {
  const library = JSON.parse(
    await fs.readFile(path.join(appRoot, 'shared/library.json'), 'utf8'),
  ) as Record<string, Visual>;
  const store = new Store(options.dataRoot || path.join(appRoot, 'data/projects'), library);
  await store.init();
  const sample = JSON.parse(
    await fs.readFile(path.join(appRoot, 'examples/esp32-led/project.json'), 'utf8'),
  );
  if (!(await store.list()).some((x) => x.id === 'esp32-led'))
    await store.create('esp32-led', sample.title, sample);
  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    const host = req.headers.host || '';
    if (!/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host)) {
      res.status(403).json({ error: 'Local host required' });
      return;
    }
    const origin = req.headers.origin;
    if (origin && origin !== `http://${host}`) {
      res.status(403).json({ error: 'Cross-origin requests are disabled' });
      return;
    }
    res.setHeader('X-Content-Type-Options', 'nosniff');
    next();
  });
  app.use(express.json({ limit: '16mb' }));
  app.get('/api/projects', async (_req, res) => {
    res.json(await store.list());
  });
  app.post('/api/projects', async (req, res) => {
    const a = z
      .object({
        id: z.string(),
        title: z.string(),
        example: z.literal('esp32-led').optional(),
        project: z.unknown().optional(),
      })
      .parse(req.body);
    res.json(
      await store.create(
        a.id,
        a.title,
        a.example ? sample : a.project ? validateProject(a.project) : undefined,
      ),
    );
  });
  app.get('/api/library', (_req, res) => {
    res.json(library);
  });
  app.get('/api/projects/:id', async (req, res) => {
    res.json(await store.get(req.params.id));
  });
  app.get('/api/projects/:id/validation', async (req, res) => {
    res.json(report(await store.get(req.params.id)));
  });
  app.post('/api/projects/:id/commands', async (req, res) => {
    const a = z
      .object({
        expectedRevision: z.number().int().nonnegative(),
        commands: z.array(commandSchema).min(1).max(500),
      })
      .parse(req.body);
    res.json(await store.mutate(req.params.id, a.expectedRevision, a.commands));
  });
  app.post('/api/projects/:id/history', async (req, res) => {
    const a = z
      .object({
        expectedRevision: z.number().int().nonnegative(),
        action: z.enum(['undo', 'redo']),
      })
      .parse(req.body);
    res.json(await store.mutate(req.params.id, a.expectedRevision, undefined, a.action));
  });
  app.post('/api/import', async (req, res) => {
    const a = z
      .object({
        id: z.string(),
        title: z.string(),
        xml: z.string().max(8000000),
        layout: z.unknown().optional(),
      })
      .parse(req.body);
    res.json(await store.create(a.id, a.title, importXml(a.xml, a.layout, a.id, a.title)));
  });
  app.get('/api/projects/:id/export/:format', async (req, res) => {
    const format = z.enum(['json', 'svg', 'pdf', 'html']).parse(req.params.format);
    const p = await store.get(req.params.id);
    res.type(
      { json: 'application/json', svg: 'image/svg+xml', pdf: 'application/pdf', html: 'text/html' }[
        format
      ],
    );
    res.setHeader('Content-Disposition', `attachment; filename="${p.id}-r${p.revision}.${format}"`);
    res.send(await exportProject(p, format, appRoot));
  });
  app.get('/api/events', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    res.write('event: ready\ndata: {}\n\n');
    const listener = (data: unknown) => res.write('data: ' + JSON.stringify(data) + '\n\n');
    store.on('change', listener);
    const heartbeat = setInterval(() => res.write(': keep-alive\n\n'), 20000);
    req.on('close', () => {
      clearInterval(heartbeat);
      store.off('change', listener);
    });
  });
  app.post('/mcp', async (req, res) => {
    const server = createMcp(store, appRoot),
      transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });
  app.all('/mcp', (_req, res) => {
    res.status(405).json({ error: 'Use POST /mcp with Streamable HTTP' });
  });
  if (options.dev) {
    const { createServer } = await import('vite');
    const vite = await createServer({
      root: appRoot,
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
    app.locals.closeVite = () => vite.close();
  } else {
    app.use(express.static(path.join(appRoot, 'dist')));
    app.get('/{*path}', (_req, res) => res.sendFile(path.join(appRoot, 'dist/index.html')));
  }
  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res
      .status(err.code === 'REVISION_CONFLICT' ? 409 : err.code === 'ENOENT' ? 404 : 400)
      .json({ error: err.message, code: err.code || 'INVALID_REQUEST' });
  });
  return { app, store };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { app } = await createApp({ dev: process.argv.includes('--dev') });
  const port = Number(process.env.PORT || 4317);
  app.listen(port, '127.0.0.1', () =>
    console.log(`Wiring Studio: http://127.0.0.1:${port}\nMCP: http://127.0.0.1:${port}/mcp`),
  );
}
