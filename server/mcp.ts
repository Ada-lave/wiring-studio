import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { commandSchema, report, type Command } from '../shared/model.js';
import { importXml } from './import.js';
import { exportProject } from './export.js';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Store } from './store.js';
const id = z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),
  rev = z.number().int().nonnegative();
export function createMcp(store: Store, appRoot: string) {
  const server = new McpServer({ name: 'wiring-studio', version: '0.1.0' });
  const register = (
    name: string,
    description: string,
    shape: Record<string, z.ZodTypeAny>,
    fn: (args: any) => Promise<unknown>,
  ) =>
    server.registerTool(name, { description, inputSchema: shape }, async (args: any) => {
      try {
        const value = await fn(args);
        return { content: [{ type: 'text' as const, text: JSON.stringify(value) }] };
      } catch (err) {
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                error: (err as Error).message,
                code: (err as any).code || 'INVALID_REQUEST',
              }),
            },
          ],
        };
      }
    });
  register('list_projects', 'Список сохранённых монтажных проектов', {}, () => store.list());
  register(
    'create_project',
    'Создать пустой проект или копию готового ESP32-примера',
    { id, title: z.string().min(1), example: z.literal('esp32-led').optional() },
    async (a) =>
      store.create(
        a.id,
        a.title,
        a.example
          ? JSON.parse(
              await fs.readFile(path.join(appRoot, 'examples/esp32-led/project.json'), 'utf8'),
            )
          : undefined,
      ),
  );
  register(
    'open_project',
    'Получить актуальную модель проекта; showInBrowser=true также открывает его в подключённых вкладках. revision нужен для команд.',
    { id, showInBrowser: z.boolean().optional() },
    async (a) => {
      const p = await store.get(a.id);
      if (a.showInBrowser)
        store.emit('change', { type: 'open_project', id: p.id, revision: p.revision });
      return p;
    },
  );
  register(
    'get_library',
    'Шаблоны компонентов с условными физическими контактами',
    {},
    async () => store.library,
  );
  register(
    'apply_commands',
    'Атомарный пакет команд. expectedRevision обязателен; allowMerge=true явно объединяет существующие сети. Подтверждайте физические выводы только с источником документации.',
    { id, expectedRevision: rev, commands: z.array(commandSchema).min(1).max(500) },
    (a) => store.mutate(a.id, a.expectedRevision, a.commands),
  );
  for (const op of [
    'add_component',
    'update_component',
    'remove_component',
    'place_component',
    'connect',
    'disconnect',
    'rename_net',
    'set_nc',
    'set_project',
    'set_trunk',
    'set_net_layer',
  ] as const) {
    const { op: _, ...shape } = commandSchema.shape;
    register(
      op,
      'Команда ' + op + ' над тем же проектом, который открыт в браузере',
      { id, expectedRevision: rev, ...shape },
      async (a) => {
        const { id, expectedRevision, ...fields } = a;
        return store.mutate(id, expectedRevision, [{ op, ...fields } as Command]);
      },
    );
  }
  for (const history of ['undo', 'redo'] as const)
    register(
      history,
      'Отменить / повторить последнее действие',
      { id, expectedRevision: rev },
      (a) => store.mutate(a.id, a.expectedRevision, undefined, history),
    );
  register(
    'validate_project',
    'Проверить целостность контактов, сетей, NC и допущений. Это не KiCad ERC.',
    { id },
    async (a) => report(await store.get(a.id)),
  );
  register(
    'import_kicad_xml',
    'Создать самостоятельный проект по экспортированному XML. layoutJson опционален. Нативные KiCad-файлы не читаются.',
    {
      id,
      title: z.string().min(1),
      xml: z.string().max(8000000),
      layoutJson: z.string().max(4000000).optional(),
    },
    (a) =>
      store.create(
        a.id,
        a.title,
        importXml(a.xml, a.layoutJson ? JSON.parse(a.layoutJson) : undefined, a.id, a.title),
      ),
  );
  register(
    'export_project',
    'Сохранить JSON / SVG / PDF / автономный HTML внутри каталога проектов',
    { id, format: z.enum(['json', 'svg', 'pdf', 'html']) },
    async (a) => {
      const p = await store.get(a.id),
        dir = path.join(store.root, 'exports');
      await fs.mkdir(dir, { recursive: true });
      const filename = path.join(dir, a.id + '-r' + p.revision + '.' + a.format);
      await fs.writeFile(filename, await exportProject(p, a.format, appRoot));
      return { path: filename, revision: p.revision };
    },
  );
  return server;
}
