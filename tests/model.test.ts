import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  applyCommands,
  emptyProject,
  report,
  validateProject,
  type Project,
  type Visual,
} from '../shared/model.js';
import { Store } from '../server/store.js';
import { importXml } from '../server/import.js';
const root = new URL('../', import.meta.url);
const library = JSON.parse(
  await fs.readFile(new URL('shared/library.json', root), 'utf8'),
) as Record<string, Visual>;
const sample = JSON.parse(
  await fs.readFile(new URL('examples/esp32-led/project.json', root), 'utf8'),
) as Project;
function circuit() {
  return applyCommands(
    emptyProject('unit', 'Unit'),
    ['R1', 'R2', 'R3', 'R4'].map((ref, i) => ({
      op: 'add_component' as const,
      template: 'resistor',
      ref,
      x: 150 + i * 200,
      y: 250,
    })),
    library,
  );
}
test('ESP32 sample: every pin matches fresh XML export; NC and assumptions survive', async () => {
  const xml = await fs.readFile(new URL('examples/esp32-led/netlist.xml', root), 'utf8'),
    layout = JSON.parse(await fs.readFile(new URL('examples/esp32-led/layout.json', root), 'utf8'));
  const imported = importXml(xml, layout, 'imported', 'Import');
  const signature = (p: Project) =>
    p.nets.flatMap((n) => n.nodes.map((x) => JSON.stringify([n.name, n.nc, x.ref, x.pin]))).sort();
  assert.deepEqual(signature(imported), signature(sample));
  const r = report(sample);
  assert.equal(r.components, 38);
  assert.equal(r.pins, 116);
  assert.equal(r.nets, 24);
  assert.equal(r.nc, 3);
  assert.deepEqual(
    sample.nets
      .filter((n) => n.nc)
      .flatMap((n) => n.nodes)
      .map((p) => p.pin)
      .sort(),
    ['11', '6', '8'],
  );
  for (const r of ['M1', 'M2', 'M3', 'M4', 'M5'])
    assert.ok(sample.layout.components[r].ports.every((p) => p.status === 'assumed'));
});
test('movement and rotation preserve all electrical data', () => {
  const p = applyCommands(
    sample,
    [{ op: 'place_component', ref: 'U1', x: 300, y: 800, rotation: 90 }],
    library,
  );
  assert.deepEqual(p.nets, sample.nets);
  assert.deepEqual(p.components, sample.components);
  assert.equal(p.layout.components.U1.rotation, 90);
});
test('connect, explicit merge, disconnect and NC semantics', () => {
  let p = circuit();
  p = applyCommands(
    p,
    [
      { op: 'connect', a: { ref: 'R1', pin: '1' }, b: { ref: 'R2', pin: '1' }, name: 'A' },
      { op: 'connect', a: { ref: 'R3', pin: '1' }, b: { ref: 'R4', pin: '1' }, name: 'B' },
    ],
    library,
  );
  assert.throws(
    () =>
      applyCommands(
        p,
        [{ op: 'connect', a: { ref: 'R1', pin: '1' }, b: { ref: 'R3', pin: '1' } }],
        library,
      ),
    /Объединить/,
  );
  p = applyCommands(
    p,
    [{ op: 'connect', a: { ref: 'R1', pin: '1' }, b: { ref: 'R3', pin: '1' }, allowMerge: true }],
    library,
  );
  assert.equal(p.nets.length, 1);
  assert.equal(p.nets[0].nodes.length, 4);
  p = applyCommands(
    p,
    [
      { op: 'disconnect', a: { ref: 'R1', pin: '1' } },
      { op: 'set_nc', a: { ref: 'R1', pin: '1' }, nc: true },
    ],
    library,
  );
  assert.throws(
    () =>
      applyCommands(
        p,
        [{ op: 'connect', a: { ref: 'R1', pin: '1' }, b: { ref: 'R2', pin: '1' } }],
        library,
      ),
    /NC/,
  );
  p = applyCommands(
    p,
    [
      { op: 'set_nc', a: { ref: 'R1', pin: '1' }, nc: false },
      { op: 'remove_component', ref: 'R3' },
      { op: 'rename_net', name: 'A', newName: 'SIGNAL' },
    ],
    library,
  );
  assert.equal(p.nets[0].name, 'SIGNAL');
  assert.equal(p.nets[0].nodes.length, 2);
});
test('invalid batches do not mutate input; contacts and sources are validated', () => {
  const p = circuit();
  assert.throws(() =>
    applyCommands(
      p,
      [
        { op: 'place_component', ref: 'R1', x: 900 },
        { op: 'connect', a: { ref: 'R1', pin: 'nonexistent' }, b: { ref: 'R2', pin: '1' } },
      ],
      library,
    ),
  );
  assert.equal(p.layout.components.R1.x, 150);
  const bad = structuredClone(p);
  bad.layout.components.R1.ports[0].status = 'verified';
  assert.throws(() => validateProject(bad), /источник/);
  bad.layout.components.R1.sourceUrl = 'https://example.test/datasheet';
  validateProject(bad);
  bad.layout.components.R1.ports[1].pin = '1';
  assert.throws(() => validateProject(bad), /Контакты/);
});
test('atomic persistence, concurrent revision conflict, persisted undo/redo and traversal guard', async () => {
  const dir = await fs.mkdtemp(path.join(tmpdir(), 'wiring-model-'));
  try {
    const store = new Store(dir, library);
    await store.init();
    await store.create('saved', 'Saved', circuit());
    const outcomes = await Promise.allSettled([
      store.mutate('saved', 0, [{ op: 'place_component', ref: 'R1', x: 500 }]),
      store.mutate('saved', 0, [{ op: 'place_component', ref: 'R1', x: 600 }]),
    ]);
    assert.equal(outcomes.filter((x) => x.status === 'fulfilled').length, 1);
    const reopened = new Store(dir, library);
    let p = await reopened.get('saved');
    assert.equal(p.revision, 1);
    assert.equal(p.layout.components.R1.x, 500);
    p = await reopened.mutate('saved', 1, undefined, 'undo');
    assert.equal(p.layout.components.R1.x, 150);
    p = await reopened.mutate('saved', 2, undefined, 'redo');
    assert.equal(p.layout.components.R1.x, 500);
    await assert.rejects(() => store.get('../escape'));
    await assert.rejects(() =>
      store.mutate('saved', 3, [{ op: 'remove_component', ref: 'absent' }]),
    );
    assert.equal((await store.get('saved')).revision, 3);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
test('XML import rejects entities and unknown pin references', () => {
  assert.throws(() =>
    importXml(
      '<!DOCTYPE x [<!ENTITY a SYSTEM "file:///etc/passwd">]><x/>',
      undefined,
      'bad',
      'Bad',
    ),
  );
  assert.throws(() =>
    importXml(
      '<export><components/><nets><net name="A"><node ref="X1" pin="1"/></net></nets></export>',
      undefined,
      'bad',
      'Bad',
    ),
  );
});

test('ESP32 library exposes all 38 documented header pins', () => {
  assert.equal(library.esp32.ports.length, 38);
  assert.equal(library.esp32.ports.find((p) => p.pin === 'J3.9')?.label, 'GPIO18');
  assert.equal(library.esp32.ports.find((p) => p.pin === 'J2.19')?.label, '5V');
});

test('basic templates preserve functional pins, nets, NC and assumptions across placement and persistence', async () => {
  const pins: Record<string, string[]> = {
    diode: ['A', 'K'],
    led: ['A', 'K'],
    npn: ['B', 'C', 'E'],
    pnp: ['B', 'C', 'E'],
    nmos: ['G', 'D', 'S'],
    pmos: ['G', 'D', 'S'],
    button: ['1', '2'],
    potentiometer: ['1', 'W', '3'],
    inductor: ['1', '2'],
    relay: ['A1', 'A2', 'NC', 'COM', 'NO'],
    battery: ['+', '−'],
    motor: ['1', '2'],
    connector3: ['1', '2', '3'],
    connector4: ['1', '2', '3', '4'],
  };
  let p = emptyProject('basic-parts', 'Basic parts');
  for (const [template, expected] of Object.entries(pins)) {
    p = applyCommands(p, [{ op: 'add_component', template, ref: template }], library);
    assert.deepEqual(p.components[template].pins, expected);
    const v = p.layout.components[template];
    assert.ok(v.assumption);
    assert.equal(new Set(v.ports.map((port) => port.pin)).size, expected.length);
    assert.ok(
      v.ports.every(
        (port) =>
          port.status === 'assumed' && port.x >= 0 && port.x <= v.w && port.y >= 0 && port.y <= v.h,
      ),
    );
  }
  assert.equal(p.nets.length, 0); // Relay NC is a terminal, not a no-connect marker.
  p = applyCommands(
    p,
    [
      {
        op: 'connect',
        a: { ref: 'relay', pin: 'NC' },
        b: { ref: 'motor', pin: '1' },
        name: 'LOAD',
      },
      { op: 'set_nc', a: { ref: 'led', pin: 'K' }, nc: true },
    ],
    library,
  );
  const before = structuredClone(p);
  for (const rotation of [0, 90, 180, 270] as const) {
    p = applyCommands(
      p,
      Object.keys(pins).map((ref) => ({
        op: 'place_component' as const,
        ref,
        x: 450,
        y: 450,
        rotation,
      })),
      library,
    );
    assert.deepEqual(p.nets, before.nets);
    assert.deepEqual(p.components, before.components);
    for (const ref of Object.keys(pins))
      assert.deepEqual(p.layout.components[ref].ports, before.layout.components[ref].ports);
  }
  validateProject(p);
  const dir = await fs.mkdtemp(path.join(tmpdir(), 'wiring-basic-parts-'));
  try {
    const store = new Store(dir, library);
    await store.init();
    await store.create(p.id, p.title, p);
    const reopened = new Store(dir, library);
    const saved = await reopened.get(p.id);
    assert.deepEqual(saved.components, p.components);
    assert.deepEqual(saved.layout.components, p.layout.components);
    assert.deepEqual(saved.nets, p.nets);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
