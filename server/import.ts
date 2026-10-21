import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { createHash } from 'node:crypto';
import { emptyProject, validateProject, type Project } from '../shared/model.js';
const arr = (v: any): any[] => (v == null ? [] : Array.isArray(v) ? v : [v]);
export function importXml(xml: string, rawLayout: unknown, id: string, title: string): Project {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('DTD и XML entities не поддерживаются');
  if (XMLValidator.validate(xml) !== true) throw new Error('Некорректный XML');
  const data = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@',
    parseTagValue: false,
    processEntities: false,
  }).parse(xml).export;
  if (!data?.components || !data?.nets) throw new Error('Ожидается экспорт KiCad XML');
  const p = emptyProject(id, title);
  p.source = {
    filename: 'imported-netlist.xml',
    sha256: createHash('sha256').update(xml).digest('hex'),
    tool: String(data.design?.tool || 'KiCad XML'),
  };
  if (rawLayout) p.layout = { ...(rawLayout as Project['layout']), title };
  for (const comp of arr(data.components.comp)) {
    const ref = String(comp['@ref']);
    if (ref.startsWith('#')) continue;
    if (p.components[ref]) throw new Error('Повтор компонента ' + ref);
    const pins = new Set<string>();
    for (const u of arr(comp.units?.unit))
      for (const pin of arr(u.pins?.pin)) pins.add(String(pin['@num']));
    p.components[ref] = {
      ref,
      value: String(comp.value || ''),
      pins: [...pins],
      package: String(comp.footprint || ''),
      fields: {},
    };
  }
  for (const net of arr(data.nets.net)) {
    const nodes = arr(net.node)
      .filter((x) => !String(x['@ref']).startsWith('#'))
      .map((x) => ({ ref: String(x['@ref']), pin: String(x['@pin']) }));
    if (!nodes.length) continue;
    const name = String(net['@name']).replace(/^\//, '');
    p.nets.push({ name, nc: name.startsWith('unconnected-'), nodes });
    for (const node of nodes) {
      const c = p.components[node.ref];
      if (!c) throw new Error('Нет компонента ' + node.ref);
      if (!c.pins.includes(node.pin)) c.pins.push(node.pin);
    }
  }
  if (!rawLayout) {
    let i = 0;
    for (const [ref, c] of Object.entries(p.components)) {
      const h = Math.max(100, c.pins.length * 24 + 30);
      p.layout.components[ref] = {
        kind: 'custom',
        name: c.value,
        x: 150 + (i % 4) * 460,
        y: 150 + Math.floor(i / 4) * 600,
        w: 220,
        h,
        rotation: 0,
        ports: c.pins.map((pin, k) => ({
          pin,
          label: pin,
          x: 0,
          y: 30 + k * 24,
          side: 'left',
          status: 'assumed',
        })),
        package: c.package,
        note: 'Импорт KiCad XML; задайте реальный корпус',
        assumption: 'Физическое расположение контактов неизвестно',
      };
      i++;
    }
    p.layout.width = Math.max(2200, 2000);
    p.layout.height = Math.max(1800, Math.ceil(i / 4) * 600 + 300);
  }
  for (const [ref, v] of Object.entries(p.layout.components)) {
    const source = v.sourceUrl || p.layout.sources?.find((s) => s.component === ref)?.url;
    if (source) v.sourceUrl = source;
    else if (v.ports.some((port) => port.status === 'verified')) {
      v.ports.forEach((port) => (port.status = 'assumed'));
      v.assumption =
        v.assumption ||
        'Контакты импортированы без документации корпуса; физическое расположение следует сверить.';
    }
  }
  return validateProject(p);
}
