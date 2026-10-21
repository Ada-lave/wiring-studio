import { promises as fs } from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import {
  applyCommands,
  emptyProject,
  validateProject,
  DomainError,
  type Command,
  type Project,
  type Visual,
} from '../shared/model.js';
export type Envelope = { project: Project; past: Project[]; future: Project[] };
export class Store extends EventEmitter {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(
    public root: string,
    public library: Record<string, Visual>,
  ) {
    super();
  }
  private file(id: string) {
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(id)) throw new DomainError('Недопустимый ID проекта');
    return path.join(this.root, id + '.json');
  }
  async init() {
    await fs.mkdir(this.root, { recursive: true });
  }
  async list() {
    const names = await fs.readdir(this.root);
    const result = [];
    for (const n of names.filter((x) => x.endsWith('.json'))) {
      const e = JSON.parse(await fs.readFile(path.join(this.root, n), 'utf8')) as Envelope;
      result.push({
        id: e.project.id,
        title: e.project.title,
        revision: e.project.revision,
        updatedAt: e.project.updatedAt,
      });
    }
    return result.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  async envelope(id: string): Promise<Envelope> {
    const e = JSON.parse(await fs.readFile(this.file(id), 'utf8'));
    e.project = validateProject(e.project);
    return e;
  }
  async get(id: string) {
    return (await this.envelope(id)).project;
  }
  private async write(e: Envelope) {
    const filename = this.file(e.project.id),
      tmp = filename + '.' + process.pid + '.tmp';
    try {
      await fs.writeFile(tmp, JSON.stringify(e, null, 2), 'utf8');
      await fs.rename(tmp, filename);
    } catch (err) {
      await fs.rm(tmp, { force: true });
      throw err;
    }
    this.emit('change', { id: e.project.id, revision: e.project.revision });
    return e.project;
  }
  private lock<T>(fn: () => Promise<T>): Promise<T> {
    const work = this.queue.then(fn);
    this.queue = work.catch(() => {});
    return work;
  }
  async create(id: string, title: string, seed?: Project) {
    return this.lock(async () => {
      try {
        await fs.access(this.file(id));
        throw new DomainError('Проект уже существует', 'EXISTS');
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }
      const p = seed
        ? validateProject({
            ...seed,
            id,
            title,
            layout: { ...seed.layout, title },
            revision: 0,
            updatedAt: new Date().toISOString(),
          })
        : emptyProject(id, title);
      if (p.erc) p.erc.importRevision = 0;
      return this.write({ project: p, past: [], future: [] });
    });
  }
  async mutate(
    id: string,
    revision: number,
    commands: Command[] | undefined,
    history?: 'undo' | 'redo',
  ) {
    return this.lock(async () => {
      const e = await this.envelope(id);
      if (e.project.revision !== revision)
        throw new DomainError(
          'Проект изменился. Обновите состояние и повторите действие. Текущая ревизия: ' +
            e.project.revision,
          'REVISION_CONFLICT',
        );
      let p: Project;
      if (history) {
        const from = history === 'undo' ? e.past : e.future,
          to = history === 'undo' ? e.future : e.past;
        if (!from.length) throw new DomainError('Нет действия для ' + history);
        p = from.pop()!;
        to.push(e.project);
      } else {
        if (!commands?.length || commands.length > 500)
          throw new DomainError('Пакет должен содержать 1–500 команд');
        p = applyCommands(e.project, commands, this.library);
        e.past.push(e.project);
        e.future = [];
      }
      p.revision = e.project.revision + 1;
      p.updatedAt = new Date().toISOString();
      e.project = p;
      e.past = e.past.slice(-60);
      e.future = e.future.slice(-60);
      return this.write(e);
    });
  }
}
