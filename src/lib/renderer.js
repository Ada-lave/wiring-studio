// SVG artwork and orthogonal router adapted from the verified assembly viewer.
// Connection data is provided by the shared project model, never inferred from geometry.
export function createRenderer(viewport, project, callbacks = {}) {
  const model = structuredClone(project),
    initial = model.layout;
  for (const c of Object.values(initial.components)) {
    const r = c.rotation || 0;
    if (!r) continue;
    const base = structuredClone(c),
      w = c.w,
      h = c.h;
    const rotate = (x, y) =>
      r === 90 ? { x: h - y, y: x } : r === 180 ? { x: w - x, y: h - y } : { x: y, y: w - x };
    const sides = ['top', 'right', 'bottom', 'left'];
    c.ports = c.ports.map((p) => ({
      ...p,
      ...rotate(p.x, p.y),
      side: sides[(sides.indexOf(p.side) + r / 90) % 4],
      labelSide: undefined,
    }));
    c._art = base;
    c._transform =
      r === 90
        ? `translate(${h} 0) rotate(90)`
        : r === 180
          ? `translate(${w} ${h}) rotate(180)`
          : `translate(0 ${w}) rotate(270)`;
    if (r % 180) {
      c.w = h;
      c.h = w;
    }
  }
  let positions = Object.fromEntries(
    Object.entries(initial.components).map(([r, c]) => [r, { x: c.x, y: c.y }]),
  );
  let layer = 'all',
    selected = null,
    camera = { x: 0, y: 0, w: initial.width, h: initial.height },
    drag = null,
    moved = false,
    routeWarnings = [];
  const NS = 'http://www.w3.org/2000/svg',
    W = initial.width,
    H = initial.height;
  const COLORS = { power: '#d7463d', ground: '#64748b', data: '#2879de' };
  const nets = new Map(model.nets.map((n) => [n.name, n]));
  const pinNets = new Map();
  for (const n of model.nets) for (const p of n.nodes) pinNets.set(p.ref + ':' + p.pin, n.name);
  const kind = (n) =>
    nets.get(n)?.layer ||
    (n === 'GND' ? 'ground' : /^(VIN_|V5_|[+]?[35]V|VCC|VDD)/.test(n) ? 'power' : 'data');
  const esc = (s) =>
    String(s ?? '').replace(
      /[&<>"']/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
    );
  function node(tag, attrs = {}, text) {
    const e = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    if (text !== undefined) e.textContent = text;
    return e;
  }
  function rect(g, x, y, w, h, fill, extra = {}) {
    g.append(node('rect', { x, y, width: w, height: h, fill, rx: 3, ...extra }));
  }
  function text(g, x, y, t, cls = 'diagram-label', extra = {}) {
    g.append(node('text', { x, y, class: cls, ...extra }, t));
  }
  function circle(g, x, y, r, fill, extra = {}) {
    g.append(node('circle', { cx: x, cy: y, r, fill, ...extra }));
  }
  function line(g, x1, y1, x2, y2, color, width = 2) {
    g.append(node('line', { x1, y1, x2, y2, stroke: color, 'stroke-width': width }));
  }
  function poly(g, d, color, width = 2) {
    g.append(
      node('path', {
        d,
        fill: 'none',
        stroke: color,
        'stroke-width': width,
        'stroke-linejoin': 'round',
      }),
    );
  }
  function port(ref, p) {
    const c = initial.components[ref],
      pos = positions[ref];
    return { x: pos.x + p.x, y: pos.y + p.y, ref, pin: p.pin, side: p.side };
  }
  function exit(p) {
    const c = initial.components[p.ref],
      v = positions[p.ref],
      e = 20;
    return {
      x:
        p.side === 'left'
          ? Math.floor((v.x - e) / 10) * 10
          : p.side === 'right'
            ? Math.ceil((v.x + c.w + e) / 10) * 10
            : Math.round(p.x / 10) * 10,
      y:
        p.side === 'top'
          ? Math.floor((v.y - e) / 10) * 10
          : p.side === 'bottom'
            ? Math.ceil((v.y + c.h + e) / 10) * 10
            : Math.round(p.y / 10) * 10,
    };
  }
  function lead(p) {
    const end = exit(p);
    return [
      p,
      p.side === 'left' || p.side === 'right' ? { x: end.x, y: p.y } : { x: p.x, y: end.y },
      end,
    ];
  }
  const svg = node('svg', {
    xmlns: NS,
    viewBox: `0 0 ${W} ${H}`,
    role: 'img',
    'aria-label': 'Компоненты и провода монтажной карты. Выберите контакт для подсветки сети.',
  });
  viewport.append(svg);
  const defs = node('defs');
  defs.append(
    node(
      'style',
      {},
      '.diagram-label{font-family:system-ui,sans-serif;fill:#233644;font-size:13px}.diagram-value{font-size:12px;fill:#506775}.board-text{fill:#e9f3ef;font:12px system-ui,sans-serif}.board-title{font:600 13px system-ui,sans-serif;fill:#f2f8f4}.component-ref{font:600 15px system-ui,sans-serif;fill:#253c4a;stroke:#fff;stroke-width:4;paint-order:stroke}.component-assumption{font:11px system-ui,sans-serif;fill:#a15b10;stroke:#fff;stroke-width:3;paint-order:stroke}.pin-label{font:11px ui-monospace,monospace;fill:#1f3747}.wire{fill:none;stroke-width:2.5;stroke-linejoin:round;stroke-linecap:round}.junction{stroke:#fff;stroke-width:1}',
    ),
  );
  svg.append(defs);
  const back = node('g', { 'data-background': '' }),
    wiresGroup = node('g', { 'data-wires': '' }),
    compsGroup = node('g', { 'data-components': '' });
  svg.append(back, wiresGroup, compsGroup);
  rect(back, 0, 0, W, H, '#fff');
  text(back, 45, 42, initial.title, 'component-ref', { 'font-size': 24 });
  text(back, 45, 69, initial.subtitle, 'diagram-label');
  for (const z of initial.zones || []) {
    rect(back, z.x, z.y, z.w, z.h, '#f8fafb', { stroke: '#e7edf1', rx: 14 });
    text(back, z.x + 18, z.y - 14, z.label, 'component-ref');
  }
  text(back, 45, H - 62, (project.notes || [])[0] || '', 'diagram-label');
  text(back, 45, H - 39, (project.notes || [])[2] || '', 'diagram-label');
  text(
    back,
    45,
    H - 16,
    'Внешний вид — монтажная иллюстрация. Площадки со знаком «?» условные. Вид со стороны компонентов.',
    'component-assumption',
  );
  function drawArt(g, c, ref) {
    if (c.kind === 'custom') {
      rect(g, 0, 0, c.w, c.h, '#285764');
      text(g, c.w / 2, c.h / 2, c.name, 'board-title', { 'text-anchor': 'middle' });
      return;
    }
    const w = c.w,
      h = c.h;
    if (c.kind === 'esp32') {
      rect(g, 0, 0, w, h, '#153d3d', { rx: 9 });
      rect(g, 31, 18, w - 62, 120, '#bac4c7');
      rect(g, 39, 25, w - 78, 26, '#263b3b');
      for (let i = 0; i < 5; i++) poly(g, `M ${48 + i * 12} 31 v 12 h 6 v -12`, '#c5b784', 2);
      text(g, w / 2, 81, 'ESP32', 'diagram-label', { 'text-anchor': 'middle', 'font-weight': 600 });
      text(g, w / 2, 101, 'WROOM-32E', 'diagram-value', { 'text-anchor': 'middle' });
      rect(g, w / 2 - 22, h - 29, 44, 28, '#c5cbce');
      rect(g, w / 2 - 14, h - 23, 28, 16, '#47545b');
      rect(g, 30, h - 58, 17, 11, '#d6dfe3');
      rect(g, w - 47, h - 58, 17, 11, '#d6dfe3');
      for (let i = 0; i < 19; i++) {
        circle(g, 8, 24 + i * (c.ports.length === 38 ? 22 : 10), 3, '#c6a15d');
        circle(g, w - 8, 24 + i * (c.ports.length === 38 ? 22 : 10), 3, '#c6a15d');
      }
      text(g, w / 2, 163, 'DevKitC V4', 'board-text', { 'text-anchor': 'middle' });
    } else if (c.kind === 'matrix') {
      rect(g, 0, 0, w, h, '#183b3b', { rx: 7 });
      for (let r = 0; r < 8; r++)
        for (let col = 0; col < 8; col++) {
          const x = 11 + col * 20,
            y = 12 + r * 18;
          rect(g, x, y, 13, 13, '#e5e5da', { rx: 2 });
          circle(g, x + 6.5, y + 6.5, 2, '#b4a995');
        }
      text(g, w / 2, 168, '8 × 8 / 64 LED', 'board-text', { 'text-anchor': 'middle' });
    } else if (c.kind === 'strip') {
      rect(g, 0, 0, w, h, '#e6e9df');
      for (let i = 0; i < 15; i++) {
        const x = 30 + i * 31;
        rect(g, x, 17, 17, 17, '#fffef0', { stroke: '#adb7a5' });
        circle(g, x + 8.5, 25.5, 3, '#c1b78b');
        if (i < 14) text(g, x + 22, 49, '→', 'diagram-value');
      }
      text(g, w / 2, h - 10, model.components[ref].value + ' · фрагмент', 'diagram-label', {
        'text-anchor': 'middle',
      });
    } else if (c.kind === 'dip') {
      rect(g, 16, 0, w - 32, h, '#262e34', { rx: 6 });
      poly(g, `M ${w / 2 - 13} 0 Q ${w / 2} 22 ${w / 2 + 13} 0`, '#c2cad0', 2);
      circle(g, 30, 17, 3, '#d3d9de');
      text(g, w / 2, h / 2 - 12, model.components[ref].value, 'board-title', {
        'text-anchor': 'middle',
      });
      text(g, w / 2, h / 2 + 10, 'PDIP-14', 'board-text', { 'text-anchor': 'middle' });
      text(g, w / 2, h / 2 + 32, 'вид сверху', 'board-text', { 'text-anchor': 'middle' });
      for (const p of c.ports) rect(g, p.x - 5, p.y - 4, 10, 8, '#bfc5c7', { rx: 0 });
    } else if (c.kind === 'so8') {
      rect(g, 0, 0, w, h, '#155d4c');
      rect(g, 25, 9, w - 50, h - 18, '#273238');
      circle(g, 35, 22, 3, '#e2e7e7');
      text(g, w / 2, h / 2, model.components[ref].value, 'board-title', {
        'text-anchor': 'middle',
      });
      text(g, w / 2, h / 2 + 22, 'SO8', 'board-text', { 'text-anchor': 'middle' });
      for (const p of c.ports) line(g, p.x, p.y, p.x < w / 2 ? 25 : w - 25, p.y, '#c6d0d1', 5);
    } else if (c.kind === 'resistor') {
      line(g, 0, h / 2, w, h / 2, '#8c969c', 3);
      rect(g, 21, h / 2 - 9, w - 42, 18, '#e1c69b', { rx: 7 });
      const bands = {
        330: ['#df7621', '#df7621', '#8c4926', '#b8993f'],
        '10k': ['#8c4926', '#292c2b', '#df7621', '#b8993f'],
        '100k': ['#8c4926', '#292c2b', '#edcd38', '#b8993f'],
      }[model.components[ref].value.replace(/\s/g, '').replace(/кОм/g, 'k').replace(/Ом|Ω/g, '')];
      if (bands)
        for (const [i, x] of [29, 38, w - 32, w - 24].entries())
          rect(g, x, h / 2 - 9, 4, 18, bands[i], { rx: 0 });
    } else if (c.kind === 'capacitor') {
      line(g, 20, h - 15, 20, h, '#9ba7ad');
      line(g, w - 20, h - 15, w - 20, h, '#9ba7ad');
      rect(g, 9, 8, w - 18, h - 24, '#275d80', { rx: 8 });
      g.append(node('ellipse', { cx: w / 2, cy: 12, rx: (w - 18) / 2, ry: 9, fill: '#b7c8d2' }));
      poly(g, `M ${w / 2 - 7} 9 l 14 6 M ${w / 2 + 7} 9 l -14 6`, '#778d99', 1);
      rect(g, w - 24, 24, 9, h - 45, '#d5e1e8');
      text(g, 16, h - 25, '+', 'board-title');
    } else if (c.kind === 'ceramic') {
      line(g, 16, 25, 16, h, '#9ba7ad');
      line(g, w - 16, 25, w - 16, h, '#9ba7ad');
      circle(g, w / 2, 21, 17, '#bd8c41');
      text(g, w / 2, 25, model.components[ref].value, 'diagram-value', {
        'text-anchor': 'middle',
        fill: '#45321c',
      });
    } else if (c.kind === 'fuse') {
      rect(g, 0, h / 2 - 10, w, 20, '#9fa9ad');
      rect(g, 19, h / 2 - 12, w - 38, 24, '#eee8da', { stroke: '#bcb8aa' });
      text(g, w / 2, h / 2 + 4, model.components[ref].value, 'diagram-value', {
        'text-anchor': 'middle',
      });
    } else if (c.kind === 'switch') {
      rect(g, 12, 6, w - 24, h - 12, '#2d3940', { rx: 8 });
      rect(g, 30, 14, w - 60, h - 30, '#cf4c3e');
      text(g, w / 2, 35, 'I / O', 'board-title', { 'text-anchor': 'middle' });
    } else if (['diode', 'led'].includes(c.kind)) {
      line(g, 0, 50, w, 50, '#9ba7ad', 3);
      if (c.kind === 'diode') {
        rect(g, 25, 36, 50, 28, '#303b43');
        rect(g, 65, 36, 6, 28, '#dce3e6');
      } else {
        g.append(
          node('path', {
            d: 'M 30 50 V 30 A 20 20 0 0 1 70 30 V 50 Z',
            fill: '#d94a46',
            stroke: '#953535',
          }),
        );
        rect(g, 26, 46, 48, 7, '#f08078');
        text(g, 76, 25, '↗', 'diagram-label');
        text(g, 62, 15, '↗', 'diagram-label');
      }
    } else if (['npn', 'pnp', 'nmos', 'pmos'].includes(c.kind)) {
      const mos = ['nmos', 'pmos'].includes(c.kind);
      line(g, 0, 55, 35, 55, '#9ba7ad', 3);
      line(g, 85, 25, w, 25, '#9ba7ad', 3);
      line(g, 85, 85, w, 85, '#9ba7ad', 3);
      rect(g, 30, 8, 60, 94, '#303b43', { rx: 16 });
      text(g, 60, 40, mos ? 'MOS' : c.kind.toUpperCase(), 'board-title', {
        'text-anchor': 'middle',
      });
      text(g, 60, 65, mos ? (c.kind === 'nmos' ? 'N' : 'P') : 'BJT', 'board-text', {
        'text-anchor': 'middle',
      });
    } else if (c.kind === 'button') {
      line(g, 0, 60, w, 60, '#9ba7ad', 3);
      rect(g, 15, 30, 70, 40, '#65747d');
      circle(g, 50, 33, 22, '#343f48');
      text(g, 50, 39, 'NO', 'board-title', { 'text-anchor': 'middle' });
    } else if (c.kind === 'potentiometer') {
      for (const p of c.ports) line(g, 60, 45, p.x, p.y, '#9ba7ad', 3);
      circle(g, 60, 42, 34, '#357b9a');
      circle(g, 60, 42, 20, '#cad1d2');
      line(g, 49, 53, 71, 31, '#56666d', 4);
    } else if (c.kind === 'inductor') {
      line(g, 0, 40, w, 40, '#9ba7ad', 3);
      rect(g, 20, 18, 70, 28, '#454b50');
      for (let i = 0; i < 7; i++)
        poly(g, `M ${25 + i * 9} 46 Q ${15 + i * 9} 12 ${29 + i * 9} 18`, '#c78b46', 5);
    } else if (c.kind === 'relay') {
      rect(g, 8, 8, w - 16, h - 16, '#346b88');
      rect(g, 25, 35, 35, 70, 'none', { stroke: '#d3e2e8' });
      text(g, 43, 76, 'K', 'board-title', { 'text-anchor': 'middle' });
      line(g, 110, 70, 155, 30, '#e2e9eb', 3);
      line(g, 155, 30, 180, 30, '#e2e9eb', 3);
      line(g, 110, 70, 180, 70, '#e2e9eb', 3);
      line(g, 155, 110, 180, 110, '#e2e9eb', 3);
      text(g, 105, 125, 'SPDT', 'board-text', { 'text-anchor': 'middle' });
    } else if (c.kind === 'battery') {
      line(g, 0, 55, w, 55, '#9ba7ad', 3);
      rect(g, 18, 20, 76, 60, '#637745');
      rect(g, 12, 38, 6, 30, '#c8cfd0');
      text(g, 30, 60, '+', 'board-title');
      text(g, 77, 60, '−', 'board-title');
    } else if (c.kind === 'motor') {
      line(g, 0, 70, w, 70, '#9ba7ad', 3);
      rect(g, 55, 0, 10, 25, '#a6b3b9');
      circle(g, 60, 57, 35, '#8c9ba3');
      circle(g, 60, 57, 25, '#4f626e');
      text(g, 60, 63, 'M', 'board-title', { 'text-anchor': 'middle' });
    } else if (c.kind === 'connector') {
      rect(g, 0, 0, w, h, '#267365', { rx: 4 });
      for (const p of c.ports) {
        circle(g, w / 2, p.y, 8, '#bec8c6');
        line(g, w / 2 - 5, p.y, w / 2 + 5, p.y, '#566666');
        text(g, w - 15, p.y + 4, p.pin, 'board-text', { 'text-anchor': 'middle' });
      }
    }
  }

  function drawComponent(ref, closeup = false) {
    const c = initial.components[ref],
      pos = positions[ref],
      g = node('g', {
        class: 'component',
        transform: closeup ? '' : `translate(${pos.x} ${pos.y})`,
        'data-ref': ref,
        role: 'button',
        tabindex: closeup ? -1 : 0,
        'aria-label': ref + ' ' + (c.name || model.components[ref].value),
      });
    g.append(node('title', {}, ref + ' · ' + c.name));
    rect(g, -6, -6, c.w + 12, c.h + 12, 'none', {
      class: 'selection-ring',
      stroke: '#e0a51d',
      'stroke-width': 4,
      rx: 9,
    });
    const art = node('g', { transform: c._transform || '' });
    drawArt(art, c._art || c, ref);
    g.append(art);
    text(g, 0, -20, c.caption || ref + ' · ' + c.name, 'component-ref');
    if (c.assumption)
      text(g, 0, -5, '? ' + (c.assumptionLabel || 'сверить корпус'), 'component-assumption');
    for (const p of c.ports) {
      const key = ref + ':' + p.pin,
        n = pinNets.get(key),
        nc = nets.get(n)?.nc;
      const pg = node('g', {
        class: 'pin ' + (p.status === 'assumed' ? 'assumed ' : '') + (nc ? 'nc' : ''),
        'data-pin': key,
        role: 'button',
        tabindex: closeup ? -1 : 0,
        'aria-label': ref + ' вывод ' + p.pin + ' ' + p.label + (n ? ' сеть ' + n : ''),
      });
      pg.append(
        node(
          'title',
          {},
          `${ref}/${p.pin}: ${p.label} · ${nc ? 'NC' : n || 'нет сети'}${p.status === 'assumed' ? ' · физическая позиция условная' : ''}`,
        ),
      );
      circle(pg, p.x, p.y, 5, '#fff8dc', { class: 'pad' });
      circle(pg, p.x, p.y, 8, 'transparent');
      const side = closeup ? p.side : p.labelSide || p.side;
      const x = p.x + (side === 'left' ? -10 : side === 'right' ? 10 : 0),
        y = p.y + (side === 'top' ? -9 : side === 'bottom' ? 18 : 4);
      const label = closeup
        ? `${p.pin} ${p.label}`
        : ['dip', 'so8'].includes(c.kind)
          ? p.pin
          : p.short || p.label;
      if (nc) {
        line(pg, p.x - 4, p.y - 4, p.x + 4, p.y + 4, '#687982', 2);
        line(pg, p.x + 4, p.y - 4, p.x - 4, p.y + 4, '#687982', 2);
      }
      text(pg, x, y, nc ? label + ' NC' : label, 'pin-label', {
        'text-anchor': side === 'left' ? 'end' : side === 'right' ? 'start' : 'middle',
        stroke: '#fff',
        'stroke-width': 2.5,
        'paint-order': 'stroke',
      });
      pg.addEventListener('pointerdown', (e) => e.stopPropagation());
      pg.addEventListener('click', (e) => {
        e.stopPropagation();
        select({ ref, pin: p.pin });
      });
      pg.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          e.stopPropagation();
          select({ ref, pin: p.pin });
        }
      });
      g.append(pg);
    }
    if (!closeup) {
      g.addEventListener('pointerdown', (e) => startDrag(e, ref));
      g.addEventListener('click', () => {
        if (!moved) select({ ref });
      });
      g.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          select({ ref });
        }
      });
    }
    return g;
  }

  // Orthogonal grid router. Body obstacles are hard constraints; crossings are
  // allowed, with white bridge gaps. A junction is drawn only inside one net.
  const GRID = 10,
    NX = Math.ceil(W / GRID) + 1,
    NY = Math.ceil(H / GRID) + 1;
  let blocked = new Set(),
    occupied = new Map(),
    occupiedEdges = new Map();
  const key = (x, y) => y * NX + x;
  const edgeKey = (a, b) => (a < b ? a + ':' + b : b + ':' + a);
  function reserveSegment(a, b, net) {
    const vertical = a.x === b.x,
      fixed = vertical ? a.x : a.y;
    if (fixed % GRID !== 0) return;
    const low = Math.floor(Math.min(vertical ? a.y : a.x, vertical ? b.y : b.x) / GRID),
      high = Math.ceil(Math.max(vertical ? a.y : a.x, vertical ? b.y : b.x) / GRID);
    for (let k = low; k < high; k++) {
      const i = vertical ? key(fixed / GRID, k) : key(k, fixed / GRID),
        j = vertical ? key(fixed / GRID, k + 1) : key(k + 1, fixed / GRID);
      const old = occupiedEdges.get(edgeKey(i, j));
      if (old && old !== net)
        routeWarnings.push('Конфликт терминальных проводов: ' + old + ' / ' + net);
      occupiedEdges.set(edgeKey(i, j), net);
    }
  }
  function obstacles() {
    blocked = new Set();
    for (const [r, c] of Object.entries(initial.components)) {
      const p = positions[r];
      for (let y = Math.ceil((p.y - 7) / GRID); y <= Math.floor((p.y + c.h + 7) / GRID); y++)
        for (let x = Math.ceil((p.x - 7) / GRID); x <= Math.floor((p.x + c.w + 7) / GRID); x++)
          blocked.add(key(x, y));
    }
  }
  class Heap {
    constructor() {
      this.a = [];
    }
    push(v) {
      let i = this.a.push(v) - 1;
      while (i) {
        let p = (i - 1) >> 1;
        if (this.a[p].f <= v.f) break;
        this.a[i] = this.a[p];
        i = p;
      }
      this.a[i] = v;
    }
    pop() {
      const a = this.a,
        r = a[0],
        v = a.pop();
      if (a.length) {
        let i = 0;
        while (i * 2 + 1 < a.length) {
          let j = i * 2 + 1;
          if (j + 1 < a.length && a[j + 1].f < a[j].f) j++;
          if (a[j].f >= v.f) break;
          a[i] = a[j];
          i = j;
        }
        a[i] = v;
      }
      return r;
    }
    get length() {
      return this.a.length;
    }
  }
  function route(a, b, net) {
    const sx = Math.round(a.x / GRID),
      sy = Math.round(a.y / GRID),
      tx = Math.round(b.x / GRID),
      ty = Math.round(b.y / GRID),
      start = key(sx, sy),
      end = key(tx, ty);
    if (blocked.has(start) || blocked.has(end)) return null;
    const heap = new Heap(),
      scores = new Map([[start, 0]]),
      prev = new Map();
    heap.push({ x: sx, y: sy, id: start, g: 0, f: Math.abs(tx - sx) + Math.abs(ty - sy), d: -1 });
    let steps = 0,
      found = false;
    while (heap.length && steps++ < NX * NY * 3) {
      const u = heap.pop();
      if (u.g !== scores.get(u.id)) continue;
      if (u.id === end) {
        found = true;
        break;
      }
      for (const [dx, dy, d] of [
        [1, 0, 0],
        [-1, 0, 0],
        [0, 1, 1],
        [0, -1, 1],
      ]) {
        const x = u.x + dx,
          y = u.y + dy,
          id = key(x, y),
          edge = occupiedEdges.get(edgeKey(id, u.id));
        if (
          x < 2 ||
          y < 9 ||
          x >= NX - 2 ||
          y >= NY - 9 ||
          blocked.has(id) ||
          (edge && edge !== net)
        )
          continue;
        const other = occupied.get(id);
        const g =
          u.g + 1 + (u.d !== -1 && u.d !== d ? 0.25 : 0) + (other && other !== net ? 1.5 : 0);
        if (g < (scores.get(id) ?? Infinity)) {
          scores.set(id, g);
          prev.set(id, u.id);
          heap.push({ x, y, id, g, f: g + Math.abs(tx - x) + Math.abs(ty - y), d });
        }
      }
    }
    if (!found) return null;
    const ids = [];
    let k = end;
    while (k !== undefined) {
      ids.push(k);
      k = prev.get(k);
    }
    ids.reverse();
    ids.forEach((id, i) => {
      occupied.set(id, net);
      if (i) occupiedEdges.set(edgeKey(ids[i - 1], id), net);
    });
    let pts = ids.map((i) => ({ x: (i % NX) * GRID, y: Math.floor(i / NX) * GRID }));
    pts = [a, ...pts, b];
    return pts.filter(
      (p, i, arr) =>
        i === 0 || i === arr.length - 1 || p.x !== arr[i - 1].x || p.y !== arr[i - 1].y,
    );
  }
  const pathData = (pts) => pts.map((p, i) => (i ? 'L' : 'M') + p.x + ',' + p.y).join(' ');
  function buildRoutes() {
    obstacles();
    occupied = new Map();
    occupiedEdges = new Map();
    routeWarnings = [];
    const result = [];
    for (const n of model.nets.filter((n) => !n.nc))
      for (const p of n.nodes) {
        const c = initial.components[p.ref],
          q = c.ports.find((x) => x.pin === p.pin),
          points = lead(port(p.ref, q));
        for (let i = 1; i < points.length; i++) reserveSegment(points[i - 1], points[i], n.name);
      }
    for (const [name, t] of Object.entries(initial.trunks || {})) {
      let prior;
      for (let v = t.from; v <= t.to; v += GRID) {
        const id = key(
          Math.round((t.axis === 'h' ? v : t.at) / GRID),
          Math.round((t.axis === 'h' ? t.at : v) / GRID),
        );
        occupied.set(id, name);
        if (prior !== undefined) occupiedEdges.set(edgeKey(prior, id), name);
        prior = id;
      }
    }
    for (const n of model.nets
      .filter((n) => !n.nc)
      .sort((a, b) => (a.name === 'GND' ? -1 : b.name === 'GND' ? 1 : 0))) {
      const points = n.nodes.map((p) => {
        const c = initial.components[p.ref],
          q = c.ports.find((x) => x.pin === p.pin);
        const pin = port(p.ref, q);
        return { pin, end: exit(pin) };
      });
      const paths = points.map((p) => {
          const pts = lead(p.pin);
          const bad = Object.entries(initial.components).some(
            ([ref, c]) =>
              ref !== p.pin.ref &&
              pts.slice(1).some((b, i) => {
                const a = pts[i],
                  v = positions[ref];
                return a.x === b.x
                  ? a.x > v.x &&
                      a.x < v.x + c.w &&
                      Math.max(a.y, b.y) > v.y &&
                      Math.min(a.y, b.y) < v.y + c.h
                  : a.y > v.y &&
                      a.y < v.y + c.h &&
                      Math.max(a.x, b.x) > v.x &&
                      Math.min(a.x, b.x) < v.x + c.w;
              }),
          );
          if (bad) {
            routeWarnings.push('Пересечение корпуса у ' + p.pin.ref + '/' + p.pin.pin);
            return [];
          }
          return pts;
        }),
        junctions = [];
      const rawTrunk = initial.trunks?.[n.name];
      const trunk =
        rawTrunk &&
        Object.entries(initial.components).every(([ref, c]) => {
          const p = positions[ref];
          return rawTrunk.axis === 'h'
            ? rawTrunk.at < p.y - 7 ||
                rawTrunk.at > p.y + c.h + 7 ||
                rawTrunk.to < p.x - 7 ||
                rawTrunk.from > p.x + c.w + 7
            : rawTrunk.at < p.x - 7 ||
                rawTrunk.at > p.x + c.w + 7 ||
                rawTrunk.to < p.y - 7 ||
                rawTrunk.from > p.y + c.h + 7;
        })
          ? rawTrunk
          : null;
      if (trunk) {
        const start =
            trunk.axis === 'h' ? { x: trunk.from, y: trunk.at } : { x: trunk.at, y: trunk.from },
          end = trunk.axis === 'h' ? { x: trunk.to, y: trunk.at } : { x: trunk.at, y: trunk.to };
        paths.push([start, end]);
        let prevId;
        for (let v = trunk.from; v <= trunk.to; v += GRID) {
          const id = key(
            Math.round((trunk.axis === 'h' ? v : trunk.at) / GRID),
            Math.round((trunk.axis === 'h' ? trunk.at : v) / GRID),
          );
          occupied.set(id, n.name);
          if (prevId !== undefined) occupiedEdges.set(edgeKey(prevId, id), n.name);
          prevId = id;
        }
        for (const p of points) {
          const b =
            trunk.axis === 'h'
              ? { x: Math.max(trunk.from, Math.min(trunk.to, p.end.x)), y: trunk.at }
              : { x: trunk.at, y: Math.max(trunk.from, Math.min(trunk.to, p.end.y)) };
          const r = route(p.end, b, n.name);
          if (r) {
            paths.push(r);
            junctions.push(b);
          } else routeWarnings.push(n.name + ' ' + p.pin.ref + '/' + p.pin.pin);
        }
      } else {
        const tree = [points[0]],
          rest = points.slice(1);
        while (rest.length) {
          let best = { distance: Infinity };
          for (let i = 0; i < rest.length; i++)
            for (const t of tree) {
              const d = Math.abs(t.end.x - rest[i].end.x) + Math.abs(t.end.y - rest[i].end.y);
              if (d < best.distance) best = { i, t, distance: d };
            }
          const p = rest.splice(best.i, 1)[0],
            r = route(p.end, best.t.end, n.name);
          if (r) {
            paths.push(r);
            junctions.push(best.t.end);
          } else routeWarnings.push(n.name + ' ' + p.pin.ref + '/' + p.pin.pin);
          tree.push(p);
        }
      }
      result.push({ name: n.name, paths, junctions });
    }
    return result;
  }
  let routes = [];
  function renderWires() {
    wiresGroup.replaceChildren();
    for (const n of routes) {
      const k = kind(n.name),
        g = node('g', { class: 'wire-layer', 'data-net': n.name, 'data-kind': k });
      const d = n.paths.map(pathData).join(' ');
      g.append(
        node('path', {
          d,
          fill: 'none',
          stroke: '#fff',
          'stroke-width': 6.5,
          'stroke-linejoin': 'round',
          'stroke-linecap': 'round',
        }),
      );
      g.append(node('path', { d, class: 'wire', stroke: COLORS[k] }));
      const hit = node('path', { d, class: 'wire-hit', 'data-net-hit': n.name });
      hit.append(node('title', {}, n.name));
      hit.addEventListener('click', () => {
        const n1 = nets.get(n.name);
        select({ ...n1.nodes[0] });
      });
      g.append(hit);
      for (const p of n.junctions) circle(g, p.x, p.y, 3, COLORS[k], { class: 'junction' });
      wiresGroup.append(g);
    }
    applySelection();
  }
  function renderComponents() {
    compsGroup.replaceChildren(...Object.keys(initial.components).map((r) => drawComponent(r)));
    applySelection();
  }
  function applySelection() {
    const chosen = selected?.pin ? pinNets.get(selected.ref + ':' + selected.pin) : null;
    for (const g of wiresGroup.children) {
      g.classList.toggle('hidden', layer !== 'all' && g.dataset.kind !== layer);
      g.classList.toggle('dim', !!chosen && g.dataset.net !== chosen);
      g.classList.toggle('focus', g.dataset.net === chosen);
    }
    for (const g of compsGroup.children) {
      g.classList.toggle('selected', g.dataset.ref === selected?.ref);
      const related = chosen && nets.get(chosen)?.nodes.some((p) => p.ref === g.dataset.ref);
      g.classList.toggle('dim', !!chosen && !related);
      for (const pg of g.querySelectorAll('[data-pin]')) {
        pg.classList.toggle('connected', !!chosen && pinNets.get(pg.dataset.pin) === chosen);
        pg.classList.toggle('selected', pg.dataset.pin === selected?.ref + ':' + selected?.pin);
      }
    }
  }

  function select(value) {
    selected = value;
    applySelection();
    callbacks.select?.(value);
  }
  function screenPoint(e) {
    return new DOMPoint(e.clientX, e.clientY).matrixTransform(svg.getScreenCTM().inverse());
  }
  function setCamera() {
    svg.setAttribute('viewBox', `${camera.x} ${camera.y} ${camera.w} ${camera.h}`);
    callbacks.camera?.(camera);
  }
  function zoom(f, point) {
    const old = { ...camera };
    camera.w = Math.max(200, Math.min(W * 3, camera.w / f));
    camera.h = (camera.w * old.h) / old.w;
    const p = point || { x: old.x + old.w / 2, y: old.y + old.h / 2 };
    camera.x = p.x - ((p.x - old.x) * camera.w) / old.w;
    camera.y = p.y - ((p.y - old.y) * camera.h) / old.h;
    setCamera();
  }
  function fit() {
    camera = { x: 0, y: 0, w: W, h: H };
    setCamera();
  }
  function startDrag(e, ref) {
    if (e.button !== 0) return;
    e.stopPropagation();
    const p = screenPoint(e);
    drag = { ref, start: p, old: { ...positions[ref] }, clientX: e.clientX, clientY: e.clientY };
    moved = false;
    svg.setPointerCapture(e.pointerId);
  }
  svg.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    drag = {
      start: screenPoint(e),
      oldCamera: { ...camera },
      clientX: e.clientX,
      clientY: e.clientY,
    };
    moved = false;
    svg.setPointerCapture(e.pointerId);
  });
  svg.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const p = screenPoint(e);
    if (Math.hypot(e.clientX - drag.clientX, e.clientY - drag.clientY) > 3) moved = true;
    if (drag.ref) {
      const c = initial.components[drag.ref];
      positions[drag.ref] = {
        x:
          Math.round(Math.max(30, Math.min(W - c.w - 30, drag.old.x + p.x - drag.start.x)) / 10) *
          10,
        y:
          Math.round(Math.max(110, Math.min(H - c.h - 100, drag.old.y + p.y - drag.start.y)) / 10) *
          10,
      };
      const pos = positions[drag.ref];
      compsGroup
        .querySelector(`[data-ref="${CSS.escape(drag.ref)}"]`)
        .setAttribute('transform', `translate(${pos.x} ${pos.y})`);
    } else {
      const r = svg.getBoundingClientRect(),
        scale = Math.min(r.width / drag.oldCamera.w, r.height / drag.oldCamera.h);
      camera.x = drag.oldCamera.x - (e.clientX - drag.clientX) / scale;
      camera.y = drag.oldCamera.y - (e.clientY - drag.clientY) / scale;
      setCamera();
    }
  });
  svg.addEventListener('pointerup', () => {
    if (!drag) return;
    const ref = drag.ref;
    drag = null;
    if (ref && moved) {
      routes = buildRoutes();
      renderWires();
      callbacks.move?.(ref, positions[ref]);
    } else if (!ref && !moved) select(null);
    setTimeout(() => (moved = false), 0);
  });
  svg.addEventListener('pointercancel', () => {
    if (drag?.ref) positions[drag.ref] = drag.old;
    drag = null;
    renderComponents();
  });
  svg.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      zoom(e.deltaY < 0 ? 1.14 : 1 / 1.14, screenPoint(e));
    },
    { passive: false },
  );
  function exportSvg() {
    const out = svg.cloneNode(true);
    out.setAttribute('viewBox', `0 0 ${W} ${H}`);
    out.setAttribute('width', W);
    out.setAttribute('height', H);
    out.style.background = 'white';
    if (routeWarnings.length) {
      const t = node(
        'text',
        { x: 45, y: 95, fill: '#a55322', 'font-size': 15, 'font-family': 'system-ui' },
        'ВНИМАНИЕ: проблем трассировки ' + routeWarnings.length + '. Проверьте карту в редакторе.',
      );
      out.append(t);
    }
    for (const n of out.querySelectorAll('.selection-ring,.wire-hit')) n.remove();
    for (const n of out.querySelectorAll('.wire-layer,.component'))
      n.setAttribute('class', n.classList.contains('wire-layer') ? 'wire-layer' : 'component');
    for (const p of out.querySelectorAll('.pin .pad'))
      p.setAttribute(
        'style',
        'fill:' +
          (p.closest('.pin').classList.contains('nc') ? '#e4e7ec' : '#fff8dc') +
          ';stroke:#b08836;stroke-width:2',
      );
    return new XMLSerializer().serializeToString(out);
  }
  function closeup(ref) {
    const c = initial.components[ref],
      v = node('svg', { xmlns: NS, viewBox: `-130 -70 ${c.w + 260} ${c.h + 140}` });
    v.style.width = '100%';
    v.style.height = '400px';
    v.append(defs.cloneNode(true), drawComponent(ref, true));
    return v;
  }
  routes = buildRoutes();
  renderComponents();
  renderWires();
  setCamera();
  callbacks.warnings?.(routeWarnings);
  return {
    zoom,
    fit,
    exportSvg,
    closeup,
    getRoutes: () => routes,
    getWarnings: () => routeWarnings,
    getCamera: () => ({ ...camera }),
    setCamera(value) {
      camera = value;
      setCamera();
    },
    select(value) {
      selected = value;
      applySelection();
    },
    setLayer(value) {
      layer = value;
      applySelection();
    },
    find(ref) {
      const c = initial.components[ref],
        p = positions[ref];
      if (!c) return false;
      selected = { ref };
      camera = {
        x: p.x - 200,
        y: p.y - 160,
        w: Math.max(600, c.w + 400),
        h: Math.max(600, c.h + 320),
      };
      setCamera();
      applySelection();
      return true;
    },
    destroy() {
      viewport.replaceChildren();
    },
  };
}
