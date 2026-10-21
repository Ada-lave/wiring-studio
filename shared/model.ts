import { z } from 'zod';
const safeName = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[\p{L}\p{N}_.+() /-]+$/u, 'Недопустимое обозначение')
  .refine(
    (s) => !['__proto__', 'constructor', 'prototype'].includes(s),
    'Зарезервированное обозначение',
  );
export const pinSchema = z.object({ ref: safeName, pin: z.string().min(1).max(80) });
export const portSchema = z.object({
  pin: z.string().min(1).max(80),
  label: z.string().max(200),
  x: z.number().finite(),
  y: z.number().finite(),
  side: z.enum(['left', 'right', 'top', 'bottom']),
  status: z.enum(['verified', 'assumed']),
  short: z.string().optional(),
  labelSide: z.enum(['left', 'right', 'top', 'bottom']).optional(),
});
export const visualSchema = z.object({
  kind: z.enum([
    'esp32',
    'matrix',
    'strip',
    'dip',
    'so8',
    'resistor',
    'capacitor',
    'ceramic',
    'fuse',
    'switch',
    'connector',
    'custom',
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
  ]),
  name: z.string().max(200),
  x: z.number().finite().min(0),
  y: z.number().finite().min(0),
  w: z.number().min(20).max(1500),
  h: z.number().min(20).max(1500),
  rotation: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]).default(0),
  ports: z.array(portSchema).min(1).max(200),
  package: z.string().default(''),
  note: z.string().default(''),
  caption: z.string().optional(),
  orientation: z.string().optional(),
  assumption: z.string().optional(),
  assumptionLabel: z.string().optional(),
  sourceUrl: z.string().optional(),
});
export const projectSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),
  title: z.string().min(1).max(200),
  revision: z.number().int().nonnegative(),
  updatedAt: z.string(),
  components: z.record(
    z.object({
      ref: safeName,
      value: z.string().max(300),
      pins: z.array(z.string()).min(1),
      package: z.string().default(''),
      fields: z.record(z.string()).default({}),
    }),
  ),
  nets: z.array(
    z.object({
      name: safeName,
      nc: z.boolean(),
      nodes: z.array(pinSchema).min(1),
      layer: z.enum(['power', 'ground', 'data']).optional(),
    }),
  ),
  layout: z.object({
    version: z.literal(1),
    title: z.string(),
    subtitle: z.string(),
    width: z.number().min(600).max(10000),
    height: z.number().min(600).max(10000),
    components: z.record(visualSchema),
    zones: z
      .array(
        z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number(), label: z.string() }),
      )
      .default([]),
    trunks: z
      .record(
        z.object({ axis: z.enum(['h', 'v']), at: z.number(), from: z.number(), to: z.number() }),
      )
      .default({}),
    sources: z.array(z.object({ component: z.string(), url: z.string() })).default([]),
  }),
  source: z.object({ filename: z.string(), sha256: z.string(), tool: z.string() }).optional(),
  notes: z.array(z.string()).default([]),
  erc: z
    .object({
      source: z.string(),
      sha256: z.string(),
      report: z.unknown(),
      importRevision: z.number(),
    })
    .optional(),
});
export type Project = z.infer<typeof projectSchema>;
export type Visual = z.infer<typeof visualSchema>;
export type Pin = z.infer<typeof pinSchema>;
export const commandSchema = z
  .object({
    op: z.enum([
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
    ]),
    ref: safeName.optional(),
    template: z.string().max(100).optional(),
    value: z.string().max(300).optional(),
    visual: visualSchema.optional(),
    patch: visualSchema.partial().optional(),
    x: z.number().finite().optional(),
    y: z.number().finite().optional(),
    rotation: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]).optional(),
    a: pinSchema.optional(),
    b: pinSchema.optional(),
    name: safeName.optional(),
    newName: safeName.optional(),
    allowMerge: z.boolean().optional(),
    nc: z.boolean().optional(),
    layer: z.enum(['power', 'ground', 'data']).optional(),
    title: z.string().min(1).max(200).optional(),
    notes: z.array(z.string()).optional(),
    trunk: z
      .object({ axis: z.enum(['h', 'v']), at: z.number(), from: z.number(), to: z.number() })
      .nullable()
      .optional(),
  })
  .strict();
export type Command = z.infer<typeof commandSchema>;
export class DomainError extends Error {
  constructor(
    message: string,
    public code = 'INVALID_COMMAND',
  ) {
    super(message);
  }
}
const fail = (s: string): never => {
  throw new DomainError(s);
};
export const pinKey = (p: Pin) => JSON.stringify([p.ref, p.pin]);
export function validateProject(raw: unknown): Project {
  const p = projectSchema.parse(raw),
    refs = Object.keys(p.components);
  if (refs.length !== Object.keys(p.layout.components).length)
    fail('Число компонентов и корпусов различается');
  const seen = new Set<string>(),
    names = new Set<string>();
  for (const ref of refs) {
    const c = p.components[ref],
      v = p.layout.components[ref];
    if (!v || c.ref !== ref) fail('Нет корпуса ' + ref);
    const pins = new Set(c.pins);
    if (
      pins.size !== c.pins.length ||
      new Set(v.ports.map((x) => x.pin)).size !== v.ports.length ||
      pins.size !== v.ports.length ||
      v.ports.some((x) => !pins.has(x.pin))
    )
      fail('Контакты корпуса не соответствуют ' + ref);
    if (v.ports.some((x) => x.status === 'assumed') && !v.assumption)
      fail('Укажите допущение для ' + ref);
    if (v.ports.some((x) => x.x < 0 || x.y < 0 || x.x > v.w || x.y > v.h))
      fail('Контакт за пределами корпуса ' + ref);
    if (
      v.ports.some((x) => x.status === 'verified') &&
      !v.sourceUrl &&
      !p.layout.sources.some((s) => s.component === ref)
    )
      fail('Для подтверждённых контактов нужен источник: ' + ref);
    const rw = v.rotation % 180 ? v.h : v.w,
      rh = v.rotation % 180 ? v.w : v.h;
    if (v.x + rw > p.layout.width || v.y + rh > p.layout.height)
      fail('Корпус за пределами поля: ' + ref);
  }
  for (const n of p.nets) {
    if (names.has(n.name)) fail('Повтор сети ' + n.name);
    names.add(n.name);
    if (n.nc && n.nodes.length !== 1) fail('NC относится к одному выводу');
    for (const pin of n.nodes) {
      if (!p.components[pin.ref]?.pins.includes(pin.pin))
        fail('Неизвестный вывод ' + pin.ref + '/' + pin.pin);
      const k = pinKey(pin);
      if (seen.has(k)) fail('Вывод принадлежит нескольким сетям ' + pin.ref + '/' + pin.pin);
      seen.add(k);
    }
  }
  for (const name of Object.keys(p.layout.trunks))
    if (!p.nets.some((n) => n.name === name && !n.nc)) fail('Магистраль без сети ' + name);
  return p;
}
export function emptyProject(id: string, title: string): Project {
  return validateProject({
    schemaVersion: 1,
    id,
    title,
    revision: 0,
    updatedAt: new Date().toISOString(),
    components: {},
    nets: [],
    layout: {
      version: 1,
      title,
      subtitle: 'Вид со стороны компонентов · условные контакты отмечены ?',
      width: 2200,
      height: 1800,
      components: {},
      zones: [],
      trunks: {},
      sources: [],
    },
    notes: [],
  });
}
export function applyCommands(
  input: Project,
  commands: Command[],
  library: Record<string, Visual>,
): Project {
  const p = structuredClone(input);
  const netFor = (pin: Pin) => p.nets.find((n) => n.nodes.some((x) => pinKey(x) === pinKey(pin)));
  const checkPin = (pin: Pin | undefined): Pin => {
    if (!pin || !p.components[pin.ref]?.pins.includes(pin.pin)) fail('Неизвестный вывод');
    return pin!;
  };
  const getRef = (ref: string | undefined) => {
    if (!ref || !p.components[ref]) fail('Неизвестный компонент');
    return ref!;
  };
  const cleanup = () => {
    p.nets = p.nets.filter((n) => n.nodes.length);
    for (const n of Object.keys(p.layout.trunks))
      if (!p.nets.some((x) => x.name === n)) delete p.layout.trunks[n];
  };
  const unique = (base: string) => {
    let i = 1,
      name = base;
    while (p.nets.some((n) => n.name === name)) name = base + '_' + i++;
    return name;
  };
  for (const raw of commands) {
    const c = commandSchema.parse(raw);
    switch (c.op) {
      case 'add_component': {
        if (!c.ref || p.components[c.ref]) fail('Нужно уникальное обозначение');
        const template = c.visual || library[c.template || ''];
        if (!template) fail('Неизвестный шаблон');
        const v = structuredClone(template);
        if (c.x !== undefined) v.x = c.x;
        if (c.y !== undefined) v.y = c.y;
        v.rotation = c.rotation ?? v.rotation ?? 0;
        delete v.caption;
        p.components[c.ref!] = {
          ref: c.ref!,
          value: c.value ?? v.name,
          pins: v.ports.map((x) => x.pin),
          package: v.package,
          fields: {},
        };
        p.layout.components[c.ref!] = v;
        break;
      }
      case 'update_component': {
        const r = getRef(c.ref),
          old = p.layout.components[r];
        if (c.value !== undefined) p.components[r].value = c.value;
        if (c.patch) {
          const next = { ...old, ...c.patch };
          const removed = old.ports.filter((x) => !next.ports.some((y) => y.pin === x.pin));
          if (removed.some((x) => netFor({ ref: r, pin: x.pin })))
            fail('Сначала отключите удаляемые выводы');
          p.layout.components[r] = next;
          p.components[r].pins = next.ports.map((x) => x.pin);
          p.components[r].package = next.package;
        }
        break;
      }
      case 'remove_component': {
        const r = getRef(c.ref);
        delete p.components[r];
        delete p.layout.components[r];
        p.nets.forEach((n) => (n.nodes = n.nodes.filter((x) => x.ref !== r)));
        p.layout.sources = p.layout.sources.filter((x) => x.component !== r);
        cleanup();
        break;
      }
      case 'place_component': {
        const v = p.layout.components[getRef(c.ref)];
        if (c.x !== undefined) v.x = c.x;
        if (c.y !== undefined) v.y = c.y;
        if (c.rotation !== undefined) v.rotation = c.rotation;
        break;
      }
      case 'connect': {
        const a = checkPin(c.a),
          b = checkPin(c.b);
        if (pinKey(a) === pinKey(b)) fail('Выберите два разных вывода');
        const na = netFor(a),
          nb = netFor(b);
        if (na?.nc || nb?.nc) fail('Сначала снимите NC');
        if (na && na === nb) break;
        if (na && nb) {
          if (!c.allowMerge)
            throw new DomainError(
              'Объединить сети ' + na.name + ' и ' + nb.name + '?',
              'MERGE_REQUIRED',
            );
          na.nodes.push(...nb.nodes);
          delete p.layout.trunks[nb.name];
          p.nets = p.nets.filter((x) => x !== nb);
        } else if (na || nb) (na || nb)!.nodes.push(na ? b : a);
        else
          p.nets.push({ name: c.name ? unique(c.name) : unique('NET'), nc: false, nodes: [a, b] });
        break;
      }
      case 'disconnect': {
        const a = checkPin(c.a),
          n = netFor(a);
        if (n) n.nodes = n.nodes.filter((x) => pinKey(x) !== pinKey(a));
        cleanup();
        break;
      }
      case 'set_nc': {
        const a = checkPin(c.a),
          n = netFor(a);
        if (c.nc !== false) {
          if (n && !n.nc) fail('Сначала отключите вывод от сети');
          if (!n)
            p.nets.push({
              name: unique('NC_' + a.ref + '_' + a.pin.replace(/[^a-zA-Z0-9_.-]/g, '_')),
              nc: true,
              nodes: [a],
            });
        } else if (n?.nc) {
          p.nets = p.nets.filter((x) => x !== n);
        }
        break;
      }
      case 'rename_net': {
        const n = p.nets.find((n) => n.name === c.name);
        if (!n || !c.newName) fail('Неизвестная сеть / новое имя');
        if (p.nets.some((x) => x !== n && x.name === c.newName)) fail('Имя сети занято');
        if (p.layout.trunks[n!.name]) {
          p.layout.trunks[c.newName!] = p.layout.trunks[n!.name];
          delete p.layout.trunks[n!.name];
        }
        n!.name = c.newName!;
        break;
      }
      case 'set_net_layer': {
        const n = p.nets.find((n) => n.name === c.name && !n.nc);
        if (!n || !c.layer) fail('Укажите сеть и слой');
        n!.layer = c.layer;
        break;
      }
      case 'set_project':
        if (c.title) {
          p.title = c.title;
          p.layout.title = c.title;
        }
        if (c.notes) p.notes = c.notes;
        break;
      case 'set_trunk':
        if (!c.name || !p.nets.some((n) => n.name === c.name && !n.nc)) fail('Неизвестная сеть');
        if (c.trunk) p.layout.trunks[c.name!] = c.trunk;
        else delete p.layout.trunks[c.name!];
        break;
    }
  }
  return validateProject(p);
}
export function report(p: Project) {
  validateProject(p);
  const assumptions = Object.entries(p.layout.components)
    .filter(([, v]) => v.assumption)
    .map(([ref, v]) => ({ ref, assumption: v.assumption }));
  return {
    valid: true,
    components: Object.keys(p.components).length,
    pins: Object.values(p.components).reduce((s, c) => s + c.pins.length, 0),
    nets: p.nets.filter((n) => !n.nc).length,
    nc: p.nets.filter((n) => n.nc).length,
    assumptions,
    unconnected: Object.entries(p.components).flatMap(([ref, c]) =>
      c.pins
        .filter((pin) => !p.nets.some((n) => n.nodes.some((x) => x.ref === ref && x.pin === pin)))
        .map((pin) => ({ ref, pin })),
    ),
    erc: p.erc
      ? { source: p.erc.source, appliesToCurrentRevision: p.revision === p.erc.importRevision }
      : null,
  };
}
