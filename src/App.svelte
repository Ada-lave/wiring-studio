<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import { createRenderer } from './lib/renderer.js';
  import {
    pinKey,
    report,
    type Project,
    type Pin,
    type Command,
    type Visual,
  } from '../shared/model';
  type Renderer = ReturnType<typeof createRenderer>;
  let project = $state<Project | null>(null),
    library = $state<Record<string, Visual>>({}),
    projects = $state<{ id: string; title: string }[]>([]);
  let host: HTMLDivElement,
    renderer: Renderer | undefined,
    closeupDialog: HTMLDialogElement,
    closeupHost: HTMLDivElement;
  let selected = $state<{ ref: string; pin?: string } | null>(null),
    layer = $state(localStorage.getItem('wiring-layer') || 'all'),
    search = $state(''),
    message = $state('Загрузка проекта…'),
    warnings = $state<string[]>([]),
    busy = $state(false),
    online = $state(true);
  let wireMode = $state(false),
    wireStart = $state<Pin | null>(null),
    merge = $state<{ a: Pin; b: Pin; message: string } | null>(null);
  let showLibrary = $state(false),
    showInspector = $state(false),
    showNew = $state(false),
    showImport = $state(false),
    newTitle = $state('Новая монтажная схема'),
    newExample = $state(false),
    importTitle = $state('Импорт схемы');
  let importFile = $state<File | null>(null),
    layoutFile = $state<File | null>(null),
    exportFormat = $state('svg'),
    draftRevision = $state(0),
    draftValue = $state(''),
    draftName = $state(''),
    draftNote = $state(''),
    draftSource = $state(''),
    draftAssumption = $state(''),
    portsText = $state(''),
    netName = $state('');
  const c = $derived(selected && project ? project.components[selected.ref] : null);
  const v = $derived(selected && project ? project.layout.components[selected.ref] : null);
  const chosenNet = $derived(
    selected?.pin && project
      ? project.nets.find((n) =>
          n.nodes.some((p) => p.ref === selected!.ref && p.pin === selected!.pin),
        )
      : undefined,
  );
  const stats = $derived(
    project
      ? {
          components: Object.keys(project.components).length,
          nets: project.nets.filter((n) => !n.nc).length,
          nc: project.nets.filter((n) => n.nc).length,
        }
      : null,
  );
  const templateLabels: Record<string, string> = {
    esp32: 'ESP32 DevKit',
    matrix: 'Матрица 8×8',
    strip: 'LED-лента',
    dip: 'DIP-14',
    so8: 'SO8-адаптер',
    resistor: 'Резистор',
    capacitor: 'Электролит',
    ceramic: 'Керамический C',
    fuse: 'Предохранитель',
    switch: 'Выключатель',
    connector: 'Разъём',
    custom: 'Свой модуль',
    diode: 'Диод',
    led: 'Светодиод',
    npn: 'NPN-транзистор',
    pnp: 'PNP-транзистор',
    nmos: 'N-MOSFET',
    pmos: 'P-MOSFET',
    button: 'Кнопка без фиксации',
    potentiometer: 'Потенциометр',
    inductor: 'Катушка индуктивности',
    relay: 'Реле SPDT',
    battery: 'Батарея',
    motor: 'Двигатель DC',
    connector3: '3-контактный разъём',
    connector4: '4-контактный разъём',
  };
  const prefixes: Record<string, string> = {
    esp32: 'A',
    matrix: 'M',
    strip: 'M',
    dip: 'U',
    so8: 'Q',
    resistor: 'R',
    capacitor: 'C',
    ceramic: 'C',
    fuse: 'F',
    switch: 'SW',
    connector: 'J',
    custom: 'X',
    diode: 'D',
    led: 'D',
    npn: 'Q',
    pnp: 'Q',
    nmos: 'Q',
    pmos: 'Q',
    button: 'SW',
    potentiometer: 'RV',
    inductor: 'L',
    relay: 'K',
    battery: 'BT',
    motor: 'M',
    connector3: 'J',
    connector4: 'J',
  };
  async function api<T>(path: string, body?: unknown): Promise<T> {
    const r = await fetch(
      '/api' + path,
      body === undefined
        ? {}
        : {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          },
    );
    const data = await r.json();
    if (!r.ok) throw Object.assign(new Error(data.error || 'Ошибка сервера'), { code: data.code });
    return data;
  }
  async function refreshList() {
    projects = await api('/projects');
  }
  function choose(s: { ref: string; pin?: string } | null) {
    selected = s;
    showInspector = !!s;
    const current = s && project?.layout.components[s.ref];
    if (s && current) {
      draftRevision = project!.revision;
      draftValue = project!.components[s.ref].value;
      draftName = current.name;
      draftNote = current.note;
      draftSource = current.sourceUrl || '';
      draftAssumption = current.assumption || '';
      portsText = JSON.stringify(current.ports, null, 2);
      netName =
        project!.nets.find((n) => n.nodes.some((p) => p.ref === s.ref && p.pin === s.pin))?.name ||
        '';
    }
  }
  async function load(id: string) {
    try {
      const p = await api<Project>('/projects/' + encodeURIComponent(id));
      project = p;
      choose(null);
      wireStart = null;
      localStorage.setItem('wiring-active', id);
      await refreshList();
      message = 'Проект открыт';
    } catch (err) {
      message = (err as Error).message;
    }
  }
  async function command(
    commands: Command[],
    allowMerge = false,
    expectedRevision = project?.revision,
  ) {
    if (!project || busy) return;
    busy = true;
    try {
      project = await api<Project>('/projects/' + project.id + '/commands', {
        expectedRevision,
        commands,
      });
      if (selected && !project.components[selected.ref]) choose(null);
      if (draftRevision === expectedRevision) draftRevision = project.revision;
      message = 'Сохранено · ревизия ' + project.revision;
      await refreshList();
    } catch (err) {
      const e = err as Error & { code: string };
      if (e.code === 'MERGE_REQUIRED' && !allowMerge) {
        merge = { a: commands[0].a!, b: commands[0].b!, message: e.message };
      } else message = e.message;
      if (project) {
        project = await api<Project>('/projects/' + project.id);
      }
    } finally {
      busy = false;
    }
  }
  async function selectPin(s: { ref: string; pin?: string } | null) {
    if (s?.pin && wireMode) {
      const pin = { ref: s.ref, pin: s.pin };
      if (!wireStart) {
        wireStart = pin;
        message = 'Выберите второй контакт';
      } else if (pinKey(wireStart) !== pinKey(pin)) {
        const a = wireStart;
        wireStart = null;
        wireMode = false;
        await command([{ op: 'connect', a, b: pin }]);
      }
    }
    choose(s);
  }
  async function add(kind: string) {
    if (!project) return;
    let i = 1;
    while (project.components[prefixes[kind] + i]) i++;
    const ref = prefixes[kind] + i,
      view = renderer?.getCamera();
    const x = Math.max(
      50,
      Math.min(
        project.layout.width - 600,
        Math.round((view ? view.x + view.w / 2 - 80 : 400) / 10) * 10,
      ),
    );
    const y = Math.max(
      120,
      Math.min(
        project.layout.height - 500,
        Math.round((view ? view.y + view.h / 2 - 60 : 300) / 10) * 10,
      ),
    );
    await command([{ op: 'add_component', ref, template: kind, x, y }]);
    choose({ ref });
    showLibrary = false;
  }
  async function history(action: 'undo' | 'redo') {
    if (!project || busy) return;
    busy = true;
    try {
      project = await api<Project>('/projects/' + project.id + '/history', {
        expectedRevision: project.revision,
        action,
      });
      if (selected && !project.components[selected.ref]) choose(null);
      message = action === 'undo' ? 'Действие отменено' : 'Действие повторено';
    } catch (e) {
      message = (e as Error).message;
    } finally {
      busy = false;
    }
  }
  async function createProject() {
    if (!newTitle.trim()) return;
    try {
      const id = 'project-' + crypto.randomUUID().slice(0, 8);
      const p = await api<Project>('/projects', {
        id,
        title: newTitle,
        example: newExample ? 'esp32-led' : undefined,
      });
      showNew = false;
      await load(p.id);
    } catch (e) {
      message = (e as Error).message;
    }
  }
  async function doImport() {
    if (!importFile) return;
    try {
      const text = await importFile.text(),
        id = 'import-' + crypto.randomUUID().slice(0, 8);
      let p: Project;
      if (importFile.name.endsWith('.json'))
        p = await api('/projects', { id, title: importTitle, project: JSON.parse(text) });
      else
        p = await api('/import', {
          id,
          title: importTitle,
          xml: text,
          layout: layoutFile ? JSON.parse(await layoutFile.text()) : undefined,
        });
      showImport = false;
      await load(p.id);
    } catch (e) {
      message = (e as Error).message;
    }
  }
  async function saveProperties() {
    if (!selected || !v) return;
    try {
      const ports = JSON.parse(portsText);
      await command(
        [
          {
            op: 'update_component',
            ref: selected.ref,
            value: draftValue,
            patch: {
              name: draftName,
              note: draftNote,
              sourceUrl: draftSource,
              assumption: draftAssumption,
              ports,
            },
          },
        ],
        false,
        draftRevision,
      );
    } catch (e) {
      message = (e as Error).message;
    }
  }
  function find() {
    const ref = search.trim().toUpperCase();
    if (renderer?.find(ref)) choose({ ref });
    else message = 'Компонент ' + ref + ' не найден';
  }
  async function exportFile() {
    if (!project) return;
    busy = true;
    message = 'Подготовка ' + exportFormat.toUpperCase() + '…';
    try {
      const r = await fetch('/api/projects/' + project.id + '/export/' + exportFormat);
      if (!r.ok) throw new Error((await r.json()).error);
      const url = URL.createObjectURL(await r.blob()),
        a = document.createElement('a');
      a.href = url;
      a.download = project.id + '.' + exportFormat;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      message = 'Экспорт готов';
    } catch (e) {
      message = (e as Error).message;
    } finally {
      busy = false;
    }
  }
  async function showCloseup() {
    if (!selected || !renderer) return;
    closeupHost.replaceChildren(renderer.closeup(selected.ref));
    closeupDialog.showModal();
  }
  function modal(node: HTMLDialogElement) {
    node.showModal();
  }
  function validate() {
    if (project) {
      const r = report(project);
      message = `Проверка связности: ${r.components} деталей, ${r.pins} контактов, ${r.nets} сетей, ${r.nc} NC; свободных ${r.unconnected.length}. Это не ERC.`;
    }
  }
  $effect(() => {
    const p = project;
    if (!p || !host) return;
    const oldCamera = renderer?.getCamera();
    let savedCamera: any;
    try {
      savedCamera = JSON.parse(localStorage.getItem('wiring-camera:' + p.id) || 'null');
      if (
        !savedCamera ||
        !['x', 'y', 'w', 'h'].every((k) => Number.isFinite(savedCamera[k])) ||
        savedCamera.w < 100 ||
        savedCamera.h < 100
      )
        savedCamera = null;
    } catch {}
    renderer?.destroy();
    renderer = createRenderer(host, $state.snapshot(p), {
      select: selectPin,
      move: (ref: string, pos: { x: number; y: number }) =>
        void command([{ op: 'place_component', ref, ...pos }]),
      camera: (camera: unknown) => {
        try {
          localStorage.setItem('wiring-camera:' + p.id, JSON.stringify(camera));
        } catch {}
      },
      warnings: (w: string[]) => {
        warnings = w;
      },
    } as any);
    untrack(() => {
      renderer!.setLayer(layer);
      renderer!.select(selected);
    });
    if (oldCamera && host.dataset.project === p.id) renderer.setCamera(oldCamera);
    else if (savedCamera) renderer.setCamera(savedCamera);
    host.dataset.project = p.id;
  });
  $effect(() => {
    renderer?.setLayer(layer);
    try {
      localStorage.setItem('wiring-layer', layer);
    } catch {}
  });
  $effect(() => {
    renderer?.select(selected);
  });
  onMount(() => {
    let es: EventSource;
    void (async () => {
      library = await api('/library');
      await refreshList();
      const active = localStorage.getItem('wiring-active');
      await load(projects.some((p) => p.id === active) ? active! : 'esp32-led');
      es = new EventSource('/api/events');
      es.onopen = async () => {
        online = true;
        if (project) {
          const id = project.id;
          const p = await api<Project>('/projects/' + id);
          if (project?.id === id && p.revision > project.revision) project = p;
        }
        await refreshList();
      };
      es.onerror = () => (online = false);
      es.onmessage = async (e) => {
        const event = JSON.parse(e.data);
        if (event.type === 'open_project') {
          await load(event.id);
          return;
        }
        if (project && event.id === project.id && event.revision > project.revision) {
          const id = project.id;
          const p = await api<Project>('/projects/' + id);
          if (project?.id === id && p.revision > project.revision) {
            project = p;
            message = 'Обновлено через другой клиент · ревизия ' + p.revision;
          }
        }
        await refreshList();
      };
    })().catch((e) => (message = e.message));
    return () => {
      es?.close();
      renderer?.destroy();
    };
  });
</script>

<svelte:head><title>{project?.title || 'Монтажные схемы'} · Wiring Studio</title></svelte:head>
<header class="app-header">
  <a class="brand" href="/" aria-label="Wiring Studio"
    ><span class="brand-mark">w<span>•</span></span><span
      >Wiring<span class="brand-light">Studio</span><small>МОНТАЖНЫЕ СХЕМЫ</small></span
    ></a
  >
  <div class="project-switch">
    <span class="eyebrow">ПРОЕКТ</span><select
      aria-label="Выбрать проект"
      value={project?.id}
      onchange={(e) => load(e.currentTarget.value)}
      >{#each projects as p}<option value={p.id}>{p.title}</option>{/each}</select
    >
  </div>
  <div class="header-actions">
    <span class:offline={!online} class="connection"
      ><i></i>MCP {online ? 'доступен' : 'недоступен'}</span
    ><button onclick={() => (showNew = true)}>＋ Проект</button><button
      onclick={() => (showImport = true)}>Импорт</button
    >
    <div class="export-group">
      <select aria-label="Формат экспорта" bind:value={exportFormat}
        ><option value="svg">SVG</option><option value="pdf">PDF</option><option value="html"
          >HTML</option
        ><option value="json">JSON</option></select
      ><button class="primary" disabled={busy} onclick={exportFile}>↓ Экспорт</button>
    </div>
  </div>
</header>
<div class="mobile-panels">
  <button onclick={() => (showLibrary = !showLibrary)}>＋ Компоненты</button><button
    onclick={() => (showInspector = !showInspector)}>Свойства и контакты</button
  >
</div>
<main class="workspace">
  <aside class:mobile-open={showLibrary} class="library">
    <div class="panel-title">
      <span class="eyebrow">БИБЛИОТЕКА</span><span class="count">12</span>
    </div>
    <h2>Добавить компонент</h2>
    <p class="subtle">Выберите деталь для размещения на поле.</p>
    <div class="palette">
      {#each Object.keys(templateLabels) as kind}<button
          class="palette-item"
          disabled={busy || !project}
          onclick={() => add(kind)}
          ><span class={'part-icon ' + kind} aria-hidden="true"><span></span></span><span
            >{templateLabels[kind]}<small>{library[kind]?.package || 'Настраиваемый модуль'}</small
            ></span
          ><span class="add-sign">＋</span></button
        >{/each}
    </div>
    <div class="library-note">
      <span class="note-icon">?</span>
      <div>
        <strong>Проверьте распиновку</strong>
        <p>Шаблоны условные. Укажите модель и источник, прежде чем подтвердить контакты.</p>
      </div>
    </div>
    <div class="server-card">
      <span class="eyebrow">УПРАВЛЕНИЕ ИЗ CODEX</span><code>/mcp</code>
      <p>Одни соединения в браузере и MCP. Изменения появляются здесь сразу.</p>
    </div>
  </aside>
  <section class="editor" aria-label="Редактор монтажной карты">
    <div class="toolbar">
      <div class="tool-group">
        <button
          title="Отменить"
          aria-label="Отменить"
          disabled={busy}
          onclick={() => history('undo')}>↶</button
        ><button
          title="Повторить"
          aria-label="Повторить"
          disabled={busy}
          onclick={() => history('redo')}>↷</button
        >
      </div>
      <div class="tool-group">
        <button
          class:active={!wireMode}
          onclick={() => {
            wireMode = false;
            wireStart = null;
          }}>↖ Выбор</button
        ><button
          class:active={wireMode}
          onclick={() => {
            wireMode = !wireMode;
            wireStart = null;
            message = 'Выберите первый, затем второй контакт';
          }}>⌁ Провод</button
        >
      </div>
      <div class="search">
        <span>⌕</span><input
          aria-label="Найти компонент"
          placeholder="Найти U1, M1…"
          bind:value={search}
          onkeydown={(e) => {
            if (e.key === 'Enter') find();
          }}
        /><button aria-label="Найти" onclick={find}>↵</button>
      </div>
      <button class="check-button" onclick={validate}>✓ Проверить</button>
    </div>
    <div class="canvas-top">
      <span class="sheet-tag">МОНТАЖНЫЙ ВИД <span>•</span> СТОРОНА КОМПОНЕНТОВ</span>
      <div class="layers" aria-label="Слои">
        {#each [['all', 'Все'], ['power', 'Питание'], ['ground', 'GND'], ['data', 'DATA']] as [key, label]}<button
            class:active={layer === key}
            aria-pressed={layer === key}
            onclick={() => (layer = key)}
            >{#if key !== 'all'}<i class={key}></i>{/if}{label}</button
          >{/each}
      </div>
    </div>
    <div class:connecting={wireMode} class="canvas" bind:this={host}></div>
    <div class="canvas-bottom">
      <span
        >{#if wireStart}Начало: {wireStart.ref}/{wireStart.pin} → выберите второй контакт{:else}Колесо
          — масштаб <span class="dot">·</span> Перетащите поле или деталь{/if}</span
      >
      <div class="zoom-controls">
        <button aria-label="Уменьшить" onclick={() => renderer?.zoom(1 / 1.3)}>−</button><button
          onclick={() => renderer?.fit()}>Вписать</button
        ><button aria-label="Увеличить" onclick={() => renderer?.zoom(1.3)}>＋</button>
      </div>
    </div>
    {#if warnings.length}<details class="routing-warning">
        <summary>⚠ Не проложено / конфликтов: {warnings.length}</summary>
        <p>{warnings.slice(0, 8).join('; ')}</p>
      </details>{/if}
  </section>
  <aside class:mobile-open={showInspector} class="inspector">
    <div class="panel-title">
      <span class="eyebrow">СВОЙСТВА</span><span class="count">{selected?.ref || '—'}</span>
    </div>
    {#if c && v && selected}
      <h2>{selected.ref} <span class="subtle">/ {v.kind}</span></h2>
      <p class="part-value">{c.value}</p>
      <span class="package">{v.package || 'Готовый модуль'}</span>
      {#if v.assumption}<div class="assumption">
          <strong>? Условный вид</strong>
          <p>{v.assumption}</p>
        </div>{/if}
      <div class="component-actions">
        <button onclick={showCloseup}>⤢ Увеличить</button><button
          disabled={busy}
          onclick={() =>
            command([
              {
                op: 'place_component',
                ref: selected!.ref,
                rotation: ((v!.rotation + 90) % 360) as 0 | 90 | 180 | 270,
              },
            ])}>↻ 90°</button
        ><button
          class="danger"
          disabled={busy}
          onclick={() => {
            if (confirm('Удалить ' + selected!.ref + ' и его подключения?'))
              void command([{ op: 'remove_component', ref: selected!.ref }]);
          }}>Удалить</button
        >
      </div>
      <h3>Контакты <span class="count">{v.ports.length}</span></h3>
      <div class="port-list">
        {#each v.ports as port}{@const n = project!.nets.find((n) =>
            n.nodes.some((p) => p.ref === selected!.ref && p.pin === port.pin),
          )}<button
            class:chosen={selected.pin === port.pin}
            onclick={() => selectPin({ ref: selected!.ref, pin: port.pin })}
            ><span><b>{port.pin}</b> {port.label}{port.status === 'assumed' ? ' ?' : ''}</span
            ><small>{n?.nc ? 'NC' : n?.name || 'свободен'}</small></button
          >{/each}
      </div>
      {#if selected.pin}<section class="pin-details">
          <h3>Вывод {selected.pin}</h3>
          <p class="net-name">
            {chosenNet?.nc ? 'NC — не подключать' : chosenNet?.name || 'Свободный вывод'}
          </p>
          <div class="component-actions">
            <button
              onclick={() => {
                wireMode = true;
                wireStart = { ref: selected!.ref, pin: selected!.pin! };
                message = 'Выберите второй контакт';
              }}>Соединить</button
            ><button
              disabled={busy || !chosenNet}
              onclick={() =>
                command([{ op: 'disconnect', a: { ref: selected!.ref, pin: selected!.pin! } }])}
              >Отключить</button
            ><button
              disabled={busy}
              onclick={() =>
                command([
                  {
                    op: 'set_nc',
                    a: { ref: selected!.ref, pin: selected!.pin! },
                    nc: !chosenNet?.nc,
                  },
                ])}>{chosenNet?.nc ? 'Снять NC' : 'NC'}</button
            >
          </div>
          {#if chosenNet && !chosenNet.nc}<label
              >Слой сети<select
                aria-label="Слой сети"
                value={chosenNet.layer ||
                  (chosenNet.name === 'GND'
                    ? 'ground'
                    : /^(VIN_|V5_|[+]?[35]V|VCC|VDD)/.test(chosenNet.name)
                      ? 'power'
                      : 'data')}
                onchange={(e) =>
                  command([
                    {
                      op: 'set_net_layer',
                      name: chosenNet!.name,
                      layer: e.currentTarget.value as 'power' | 'ground' | 'data',
                    },
                  ])}
                ><option value="power">Питание</option><option value="ground">GND</option><option
                  value="data">DATA</option
                ></select
              ></label
            ><label>Имя сети<input aria-label="Имя сети" bind:value={netName} /></label><button
              onclick={() =>
                command([{ op: 'rename_net', name: chosenNet!.name, newName: netName }])}
              >Переименовать сеть</button
            >
            <ul class="net-nodes">
              {#each chosenNet.nodes as pin}<li>
                  <button
                    onclick={() => {
                      renderer?.find(pin.ref);
                      choose(pin);
                    }}>{pin.ref} / {pin.pin}</button
                  >
                </li>{/each}
            </ul>{/if}
        </section>{/if}
      <details class="properties">
        <summary>Редактировать деталь</summary><label
          >Название<input bind:value={draftName} /></label
        ><label>Номинал / модель<input bind:value={draftValue} /></label><label
          >Примечание<textarea rows="3" bind:value={draftNote}></textarea></label
        ><label>Документация<input bind:value={draftSource} /></label><label
          >Допущение<textarea rows="3" bind:value={draftAssumption}></textarea></label
        ><label
          >Контакты (JSON)<textarea class="code-editor" rows="10" bind:value={portsText}
          ></textarea></label
        >
        <p class="subtle">
          Номер, подпись, x/y, сторона, status: assumed или verified. Для verified требуется
          источник.
        </p>
        <button class="primary" disabled={busy} onclick={saveProperties}>Сохранить свойства</button>
      </details>
    {:else}
      <div class="empty-state">
        <div class="empty-icon">⌁</div>
        <h2>Каждый провод —<br />между контактами</h2>
        <p>Выберите компонент, чтобы увидеть его выводы, корпус и подключения.</p>
        <div class="instruction"><b>01</b><span>Добавьте деталь из библиотеки</span></div>
        <div class="instruction">
          <b>02</b><span>Включите «Провод» и выберите два контакта</span>
        </div>
        <div class="instruction"><b>03</b><span>Проверьте сети и экспортируйте карту</span></div>
      </div>
      {#if project?.notes.length}<div class="project-notes">
          <h3>Перед сборкой</h3>
          {#each project.notes as note}<p>{note}</p>{/each}
        </div>{/if}
      {#if project?.erc}<div class="erc-note">
          <strong>Отчёт KiCad импортирован</strong>
          <p>
            Относится к исходной схеме. {project.revision === project.erc.importRevision
              ? 'Импорт ещё не изменён.'
              : 'Текущий проект изменён; ERC исходника не проверяет эти изменения.'}
          </p>
        </div>{/if}
    {/if}
  </aside>
</main>
<footer class="statusbar">
  <span class:has-error={warnings.length > 0}><i class:pending={busy}></i>{message}</span><span
    >{stats?.components || 0} компонентов <span class="dot">·</span>
    {stats?.nets || 0} сетей <span class="dot">·</span>
    {stats?.nc || 0} NC <span class="revision">REV {project?.revision || 0}</span></span
  >
</footer>
<dialog bind:this={closeupDialog} class="closeup-dialog">
  <div class="dialog-heading">
    <h2>{selected?.ref} · {c?.value}</h2>
    <button onclick={() => closeupDialog.close()}>Закрыть</button>
  </div>
  <div bind:this={closeupHost}></div>
  <p>
    {v?.orientation || 'Вид со стороны компонентов'} · {v?.assumption ||
      'Сверьте корпус с документацией'}
  </p>
</dialog>
{#if showNew}<dialog
    class="modal"
    use:modal
    oncancel={() => (showNew = false)}
    aria-label="Новый проект"
  >
    <span class="eyebrow">НОВЫЙ ПРОЕКТ</span>
    <h2>Новая монтажная схема</h2>
    <label>Название<input bind:value={newTitle} /></label><label class="checkbox"
      ><input type="checkbox" bind:checked={newExample} /> Начать с примера ESP32 + 316 LED</label
    >
    <div class="modal-actions">
      <button onclick={() => (showNew = false)}>Отмена</button><button
        class="primary"
        onclick={createProject}>Создать</button
      >
    </div>
  </dialog>{/if}
{#if showImport}<dialog
    class="modal"
    use:modal
    oncancel={() => (showImport = false)}
    aria-label="Импорт проекта"
  >
    <span class="eyebrow">ИМПОРТ</span>
    <h2>Открыть существующую схему</h2>
    <label>Название<input bind:value={importTitle} /></label><label
      >Проект JSON или KiCad XML<input
        type="file"
        accept=".json,.xml"
        onchange={(e) => (importFile = e.currentTarget.files?.[0] || null)}
      /></label
    ><label
      >Раскладка layout.json (для XML, необязательно)<input
        type="file"
        accept=".json"
        onchange={(e) => (layoutFile = e.currentTarget.files?.[0] || null)}
      /></label
    >
    <p>Создаётся самостоятельная копия. Изменения здесь не изменяют исходник KiCad.</p>
    <div class="modal-actions">
      <button onclick={() => (showImport = false)}>Отмена</button><button
        class="primary"
        disabled={!importFile}
        onclick={doImport}>Импортировать</button
      >
    </div>
  </dialog>{/if}
{#if merge}<dialog
    class="modal"
    use:modal
    oncancel={() => (merge = null)}
    aria-label="Объединить сети"
  >
    <h2>Объединение сетей</h2>
    <p>{merge.message}</p>
    <p>Все контакты обеих сетей станут электрически соединёнными.</p>
    <div class="modal-actions">
      <button onclick={() => (merge = null)}>Отмена</button><button
        class="primary"
        onclick={() => {
          const m = merge!;
          merge = null;
          void command([{ op: 'connect', a: m.a, b: m.b, allowMerge: true }], true);
        }}>Объединить сети</button
      >
    </div>
  </dialog>{/if}
