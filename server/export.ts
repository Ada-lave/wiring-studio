import { promises as fs, existsSync } from 'node:fs';
import path from 'node:path';
import { transform } from 'esbuild';
import { chromium } from 'playwright';
import type { Project } from '../shared/model.js';
export async function offlineHtml(p: Project, root: string) {
  const code = await fs.readFile(path.join(root, 'src/lib/renderer.js'), 'utf8');
  const built = await transform(code, {
    format: 'iife',
    globalName: 'WiringRenderer',
    target: 'es2022',
  });
  const data = JSON.stringify(p).replace(/</g, '\\u003c');
  return `<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Wiring Studio — монтажная карта</title><style>body{margin:0;font:14px system-ui;color:#19373c}header{padding:12px 20px;border-bottom:1px solid #ddd;display:flex;gap:12px;flex-wrap:wrap;align-items:center}button,select,input{font:inherit;padding:7px;border:1px solid #bdcccc;border-radius:6px;background:white}#field{height:80vh;touch-action:none}#field>svg{width:100%;height:100%;user-select:none}.hidden{display:none}.dim{opacity:.15}.selection-ring{display:none}.selected>.selection-ring{display:block}.wire-hit{fill:none;stroke:transparent;stroke-width:14}.wire-layer.focus .wire{stroke-width:4}.component{cursor:grab}.pin{cursor:pointer}.pad{stroke:#b48e3b;stroke-width:2}.assumed .pad{stroke-dasharray:2 2}#info{white-space:pre-wrap;padding:15px;border-top:1px solid #ddd}@media print{header,#info{display:none}#field{height:auto}#field>svg{height:auto}}</style><header><strong id="title"></strong><button id="minus">−</button><button id="plus">+</button><button id="fit">Вписать</button><select id="layers"><option value="all">Все</option><option value="power">Питание</option><option value="ground">GND</option><option value="data">DATA</option></select><input id="find" placeholder="Обозначение"><button id="search">Найти</button><button id="reset">Исходная раскладка</button><button id="print">Печать / PDF</button></header><div id="field"></div><div id="info"></div><script>${built.code.replace(/<\/script/gi, '<\\/script')}\nconst project=${data};document.getElementById('title').textContent=project.title;let renderer;const field=document.getElementById('field'),info=document.getElementById('info');const key='wiring-offline:'+project.id+':'+project.revision;let positions={};try{positions=JSON.parse(localStorage.getItem(key)||'{}')}catch{}const original=structuredClone(project);for(const[r,v]of Object.entries(positions))if(project.layout.components[r]&&Number.isFinite(v.x)&&Number.isFinite(v.y))Object.assign(project.layout.components[r],v);function render(){field.replaceChildren();renderer=WiringRenderer.createRenderer(field,project,{select(s){if(!s)return;const c=project.components[s.ref],v=project.layout.components[s.ref];info.textContent=s.ref+' · '+c.value+'\\n'+v.note+'\\n'+(v.assumption||'')+'\\n'+(s.pin?JSON.stringify(project.nets.find(n=>n.nodes.some(p=>p.ref===s.ref&&p.pin===s.pin)),null,2):'');},move(ref,p){Object.assign(project.layout.components[ref],p);positions[ref]=p;try{localStorage.setItem(key,JSON.stringify(positions))}catch{}},warnings(w){info.textContent=w.length?'Проблемы трассировки: '+w.join('; '):project.notes.join('\\n');}});window.studioExport={svg:()=>renderer.exportSvg(),warnings:()=>renderer.getWarnings()};}render();document.getElementById('plus').onclick=()=>renderer.zoom(1.3);document.getElementById('minus').onclick=()=>renderer.zoom(1/1.3);document.getElementById('fit').onclick=()=>renderer.fit();document.getElementById('layers').onchange=e=>renderer.setLayer(e.target.value);document.getElementById('search').onclick=()=>renderer.find(document.getElementById('find').value.trim());document.getElementById('reset').onclick=()=>{project.layout=structuredClone(original.layout);positions={};try{localStorage.removeItem(key)}catch{}render()};document.getElementById('print').onclick=()=>window.print();</script></html>`;
}
export async function exportProject(
  p: Project,
  format: 'json' | 'html' | 'svg' | 'pdf',
  root: string,
) {
  if (format === 'json') return Buffer.from(JSON.stringify(p, null, 2));
  const html = await offlineHtml(p, root);
  if (format === 'html') return Buffer.from(html);
  const executablePath =
    process.env.CHROMIUM_PATH ||
    (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined);
  const browser = await chromium.launch({ headless: true, executablePath });
  try {
    const page = await browser.newPage({ viewport: { width: 1800, height: 1680 } });
    await page.setContent(html, { waitUntil: 'load' });
    await page.waitForFunction(() => !!(window as any).studioExport);
    const svg = await page.evaluate(() => (window as any).studioExport.svg());
    if (format === 'svg') return Buffer.from(svg);
    await page.setContent(
      '<style>@page{size:594mm 420mm;margin:10mm}html,body{margin:0;padding:0}svg{display:block;width:574mm;height:399mm}</style>' +
        svg,
    );
    return await page.pdf({ preferCSSPageSize: true, printBackground: true });
  } finally {
    await browser.close();
  }
}
