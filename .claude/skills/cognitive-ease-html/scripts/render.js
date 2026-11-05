#!/usr/bin/env node
'use strict';
// content.json → out.html を組む render (外部ライブラリ不要。同じ入力からは常に同じ出力)。
// 使い方: node render.js <content.json> [-t template.html] [-o out.html] [--check]
// --check は検査のみ (exit 0/1)。テンプレは既定で ../assets/template.html。

const fs = require('fs');
const path = require('path');

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// **強調** → <b> (escape 後に変換。対にならない ** は文字のまま残す)
function escBold(s) {
  return esc(s).replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
}

// URL を含む文字列のリンク化 (escape 込み。PDF でも注釈として生きる)
function linkify(s) {
  return String(s).split(/(https?:\/\/[^\s]+)/g).map((seg) =>
    /^https?:\/\//.test(seg) ? `<a href="${esc(seg)}">${esc(seg)}</a>` : esc(seg)
  ).join('');
}

function fail(errors) {
  for (const e of errors) console.error('NG: ' + e);
  process.exit(1);
}

// ---- 引数 ----
const argv = process.argv.slice(2);
let contentPath = null, templatePath = null, outPath = null, checkOnly = false;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '-t') templatePath = argv[++i];
  else if (a === '-o') outPath = argv[++i];
  else if (a === '--check') checkOnly = true;
  else if (!contentPath) contentPath = a;
  else fail([`未知の引数: ${a}`]);
}
if (!contentPath) fail(['使い方: node render.js <content.json> [-t template.html] [-o out.html] [--check]']);
templatePath = templatePath || path.join(__dirname, '..', 'assets', 'template.html');
outPath = outPath || path.join(path.dirname(path.resolve(contentPath)), 'out.html');

// ---- 読み込み ----
let c;
try { c = JSON.parse(fs.readFileSync(contentPath, 'utf8')); }
catch (e) { fail([`content.json が読めない: ${e.message}`]); }

// テンプレは検査でも使う (使ってよい token 名 = テンプレ :root の定義)。--check でもここで読む
let tpl;
try { tpl = fs.readFileSync(templatePath, 'utf8'); }
catch (e) { fail([`テンプレートが読めない: ${e.message}`]); }
const TOKEN_SET = new Set(Array.from(tpl.matchAll(/(--[a-zA-Z0-9-]+)\s*:/g), (m) => m[1]));
const outDir = path.dirname(path.resolve(outPath));

// ---- 検査 (assets/content.schema.json と同じ契約を自前実装) ----
const errors = [];
const isStr = (v) => typeof v === 'string' && v.length > 0;

function checkSvg(svg, where) {
  if (!/^<svg[\s>]/.test(svg)) errors.push(`${where}: svg は <svg で始まること`);
  if (!/viewBox=/.test(svg)) errors.push(`${where}: svg に viewBox が必要`);
  if (!/aria-label=/.test(svg)) errors.push(`${where}: svg に aria-label が必要 (role="img" 併用)`);
  if (!/xmlns="http:\/\/www\.w3\.org\/2000\/svg"/.test(svg)) errors.push(`${where}: svg に xmlns="http://www.w3.org/2000/svg" が必要 (無いと単体ファイル・転用時に画像として表示されない)`);
  // token 名: テンプレ :root に無い var 名は解決されず、黙って黒く描画される
  for (const m of svg.matchAll(/var\((--[a-zA-Z0-9-]+)/g)) {
    if (!TOKEN_SET.has(m[1])) errors.push(`${where}: var(${m[1]}) はテンプレに無い token — 未定義 var は黒く描画される (使える色: --ink --muted --line --paper --paper-dim --accent --ok --warn --err)`);
  }
  // 色の役割: 図形の面塗りに ink は禁止 — 黒い面・黒い棒になって図が潰れる
  for (const m of svg.matchAll(/<(rect|circle|ellipse|polygon|polyline|path)\b[^>]*>/g)) {
    if (/fill\s*[=:]\s*"?var\(--ink\)/.test(m[0])) {
      errors.push(`${where}: <${m[1]}> の fill に var(--ink) は禁止 — 黒い面になる。データ/導線は var(--accent) + opacity 3 段、状態は --ok/--err、面は --paper/--paper-dim (ink は文字と輪郭線 stroke のみ)`);
    }
  }
  if (/<script|<foreignObject|javascript:|\bon\w+\s*=/i.test(svg)) errors.push(`${where}: svg に script/foreignObject/イベントハンドラは禁止`);
  if (/(xlink:href|href)\s*=\s*"(?!#)/.test(svg)) errors.push(`${where}: svg の外部参照は禁止 (href は #内部参照のみ)`);
  if (/#[0-9a-fA-F]{3,8}\b/.test(svg)) errors.push(`${where}: svg に生 hex 色は禁止 — var(--accent) 等のトークン参照で書く`);
  // 濃淡語彙: opacity 系は 0 / 0.35 / 0.6 / 1 のみ
  const OP_OK = new Set(['0', '0.35', '0.6', '1', '1.0']);
  for (const m of svg.matchAll(/(?:fill-|stroke-)?opacity\s*[=:]\s*"?([\d.]+)"?/g)) {
    if (!OP_OK.has(m[1])) errors.push(`${where}: opacity ${m[1]} は語彙外 — 濃淡は 1 / 0.6 / 0.35 (/0) のみ`);
  }
  // 書体語彙: Mono に 700 は存在しない。同一要素での Mono×700 を拒否
  for (const m of svg.matchAll(/<[^>]+>/g)) {
    const tag = m[0];
    if (/font-weight\s*[=:]\s*"?700"?/.test(tag) && /Mono/i.test(tag)) {
      errors.push(`${where}: Mono に font-weight 700 は禁止 — Mono は 400/600 のみ`);
    }
  }
}

// 画像参照 (hero.src / sections[].image.src): out.html からの相対パスで実在すること。
// 参照切れは本文を読むだけのチェックでは見落とされ、「画像の枠だけ空いた紙面」が
// そのまま配られてしまうため、ここで機械的に止める。
function checkImgSrc(src, where) {
  if (src.startsWith('data:')) return;
  if (/^https?:\/\//.test(src)) { errors.push(`${where}: 外部 URL は禁止 — 画像は出力 dir に置いて相対パスで参照する (自己完結性)`); return; }
  if (path.isAbsolute(src)) { errors.push(`${where}: 絶対パスは禁止 — out.html からの相対パスで書く (持ち出しで壊れる)`); return; }
  const p = path.join(outDir, src);
  if (!fs.existsSync(p)) { errors.push(`${where}: 参照先が存在しない: ${src} (out.html と同じ dir 基準。生成前なら先に手順 3 の画像を置く)`); return; }
  if (/\.svg$/i.test(src)) {
    const s = fs.readFileSync(p, 'utf8');
    if (!/xmlns="http:\/\/www\.w3\.org\/2000\/svg"/.test(s)) errors.push(`${where}: <img> 参照の svg に xmlns が無い — 画像として表示されない`);
    if (/var\(--/.test(s)) errors.push(`${where}: <img> 参照の svg に var(--…) がある — img 文脈では token が解決されず黒くなる。inline の sections[].svg にするか色を実値で書く`);
  }
}

// 一文の長さ (手順 2 で書いた文の機械検査 — 長い文は読む負担が大きい。URL と **強調** 記号は数えない)
function checkSentences(text, where) {
  const clean = String(text).replace(/https?:\/\/[^\s]+/g, '').replace(/\*\*/g, '');
  for (const s of clean.split('。')) {
    const t = s.trim();
    if (t.length > 80) errors.push(`${where}: 一文 ${t.length} 字 — 80 字以内に分割する (「${t.slice(0, 24)}…」)`);
  }
}

if (!isStr(c.kicker) || c.kicker.length > 60) errors.push('kicker: 1〜60 文字の文字列が必要');
if (!isStr(c.title) || c.title.length > 80) errors.push('title: 1〜80 文字の文字列が必要');
if (!isStr(c.conclusion) || c.conclusion.length > 200) errors.push('conclusion: 1〜200 文字の文字列が必要 (「結論:」はテンプレが前置するので書かない)');
if (isStr(c.conclusion) && /^結論[:：]/.test(c.conclusion.trim())) errors.push('conclusion: 「結論:」を本文に含めない (テンプレが前置して二重になる)');
if (isStr(c.conclusion)) checkSentences(c.conclusion, 'conclusion');
if (!Array.isArray(c.three_lines) || c.three_lines.length !== 3 || !c.three_lines.every(isStr)) {
  errors.push('three_lines: ちょうど 3 本の非空文字列の配列が必要');
} else {
  c.three_lines.forEach((l, i) => checkSentences(l, `three_lines[${i}]`));
}
if (c.hero !== undefined) {
  if (typeof c.hero !== 'object' || c.hero === null || !isStr(c.hero.src) || !isStr(c.hero.alt) || !isStr(c.hero.caption)) {
    errors.push('hero: {src, alt, caption} が必要 (画像なし構成なら hero キーごと省略)');
  } else {
    checkImgSrc(c.hero.src, 'hero.src');
    const hasW = c.hero.width !== undefined, hasH = c.hero.height !== undefined;
    if (hasW !== hasH) errors.push('hero: width と height は対で指定 (片方だけは不可)');
    if (hasW && (!Number.isInteger(c.hero.width) || !Number.isInteger(c.hero.height) || c.hero.width < 1 || c.hero.height < 1)) {
      errors.push('hero: width/height は正の整数 (px、実画像の実寸)');
    }
    const hk = ['src', 'alt', 'caption', 'width', 'height'];
    for (const k of Object.keys(c.hero)) if (!hk.includes(k)) errors.push(`hero: 未知のキー ${k}`);
  }
}
if (!Array.isArray(c.sections) || c.sections.length < 1 || c.sections.length > 5) {
  errors.push('sections: 1〜5 個 (4±1) の配列が必要');
} else {
  c.sections.forEach((s, i) => {
    const w = `sections[${i}]`;
    if (!isStr(s.heading) || s.heading.length > 60) errors.push(`${w}.heading: 1〜60 文字が必要`);
    if (!Array.isArray(s.body) || s.body.length < 1 || s.body.length > 3 || !s.body.every(isStr)) {
      errors.push(`${w}.body: 1〜3 段落の配列が必要`);
    } else {
      s.body.forEach((p, pi) => checkSentences(p, `${w}.body[${pi}]`));
    }
    const sk2 = ['heading', 'body', 'svg', 'image', 'fig_caption', 'table', 'table_caption'];
    for (const key of Object.keys(s)) if (!sk2.includes(key)) errors.push(`${w}: 未知のキー ${key}`);
    if (s.svg !== undefined) {
      if (!isStr(s.svg)) errors.push(`${w}.svg: 文字列が必要`);
      else checkSvg(s.svg, `${w}.svg`);
      if (!isStr(s.fig_caption)) errors.push(`${w}.fig_caption: svg があるなら必須 (何を見るかを書く)`);
    }
    if (s.image !== undefined) {
      if (s.svg !== undefined) errors.push(`${w}: svg と image は併用不可 (1 節 1 図 — データ図は svg、概念図は image)`);
      if (typeof s.image !== 'object' || s.image === null || !isStr(s.image.src) || !isStr(s.image.alt)) {
        errors.push(`${w}.image: {src, alt} が必要 (節のグラレコ画像。実数・量を見せる図は svg で)`);
      } else {
        checkImgSrc(s.image.src, `${w}.image.src`);
        const hasW = s.image.width !== undefined, hasH = s.image.height !== undefined;
        if (hasW !== hasH) errors.push(`${w}.image: width と height は対で指定 (片方だけは不可)`);
        if (hasW && (!Number.isInteger(s.image.width) || !Number.isInteger(s.image.height) || s.image.width < 1 || s.image.height < 1)) {
          errors.push(`${w}.image: width/height は正の整数 (px、実画像の実寸)`);
        }
        const ik = ['src', 'alt', 'width', 'height'];
        for (const k of Object.keys(s.image)) if (!ik.includes(k)) errors.push(`${w}.image: 未知のキー ${k}`);
      }
      if (!isStr(s.fig_caption)) errors.push(`${w}.fig_caption: image があるなら必須 (何を見るかを書く)`);
    }
    if (s.table !== undefined) {
      const t = s.table;
      if (typeof t !== 'object' || !Array.isArray(t.headers) || t.headers.length < 2 || t.headers.length > 6 || !t.headers.every(isStr)
        || !Array.isArray(t.rows) || t.rows.length < 1 || !t.rows.every((row) => Array.isArray(row) && row.length === t.headers.length && row.every(isStr))) {
        errors.push(`${w}.table: {headers[2-6], rows[][]} (各行は headers と同じ列数の文字列) が必要`);
      }
      if (!isStr(s.table_caption)) errors.push(`${w}.table_caption: table があるなら必須 (何を見るかを書く)`);
    }
  });
}
if (c.appendix !== undefined) {
  if (typeof c.appendix === 'object' && c.appendix !== null && Array.isArray(c.appendix.body)) {
    c.appendix.body.forEach((para, i) => { if (typeof para === 'string' && para) checkSentences(para, `appendix.body[${i}]`); });
  }
  if (typeof c.appendix !== 'object' || !isStr(c.appendix.summary) || !Array.isArray(c.appendix.body) || !c.appendix.body.every(isStr)) {
    errors.push('appendix: {summary, body[]} が必要 (不要なら省略)');
  } else if (/^(詳細|その他|まとめ)$/.test(c.appendix.summary.trim())) {
    errors.push('appendix.summary: 「詳細/その他/まとめ」は禁止 — 中身と分量が予測できる文言に');
  }
  if (c.appendix && c.appendix.table !== undefined) {
    const t = c.appendix.table;
    if (typeof t !== 'object' || !Array.isArray(t.headers) || t.headers.length < 2 || t.headers.length > 6 || !t.headers.every(isStr)
      || !Array.isArray(t.rows) || t.rows.length < 1 || !t.rows.every((r) => Array.isArray(r) && r.length === t.headers.length && r.every(isStr))) {
      errors.push('appendix.table: {headers[2-6], rows[][]} (各行は headers と同じ列数の文字列) が必要 — 数値主体の補足は本文段落でなくこの表で');
    }
  }
  if (typeof c.appendix === 'object' && c.appendix !== null) {
    const ak = ['summary', 'body', 'table'];
    for (const k of Object.keys(c.appendix)) if (!ak.includes(k)) errors.push(`appendix: 未知のキー ${k}`);
  }
}
if (c.kpis !== undefined) {
  if (!Array.isArray(c.kpis) || c.kpis.length < 2 || c.kpis.length > 4) {
    errors.push('kpis: 2〜4 枚 (4±1) の配列が必要 (不要なら省略)');
  } else {
    c.kpis.forEach((k, i) => {
      const w = `kpis[${i}]`;
      if (typeof k !== 'object' || !isStr(k.n) || !isStr(k.label)) errors.push(`${w}: {n (大数字+単位), label (完全語)} が必要`);
      else {
        if (k.delta !== undefined && !isStr(k.delta)) errors.push(`${w}.delta: 文字列 (省略可)`);
        for (const key of Object.keys(k)) if (!['n', 'label', 'delta'].includes(key)) errors.push(`${w}: 未知のキー ${key}`);
      }
    });
  }
}
if (c.callout !== undefined) {
  if (typeof c.callout !== 'object' || !isStr(c.callout.label) || !isStr(c.callout.text)) {
    errors.push('callout: {label (先頭太字の見出し語), text} が必要 (不要なら省略)');
  } else {
    for (const key of Object.keys(c.callout)) if (!['label', 'text'].includes(key)) errors.push(`callout: 未知のキー ${key}`);
  }
}
if (typeof c.meta !== 'object' || !isStr(c.meta && c.meta.date) || !isStr(c.meta && c.meta.source)) {
  errors.push('meta: {date, source} が必要');
}
const known = ['kicker', 'title', 'conclusion', 'three_lines', 'hero', 'kpis', 'sections', 'callout', 'appendix', 'meta'];
for (const k of Object.keys(c)) if (!known.includes(k)) errors.push(`未知のキー: ${k}`);

if (errors.length) fail(errors);
if (checkOnly) { console.log('OK: content.json は契約に適合'); process.exit(0); }

// ---- 組版 ----
let fig = 0;
let heroHtml = '';
if (c.hero) {
  fig++;
  const dims = c.hero.width ? ` width="${c.hero.width}" height="${c.hero.height}"` : '';
  heroHtml = [
    '  <figure class="hero">',
    `    <img src="${esc(c.hero.src)}" alt="${esc(c.hero.alt)}"${dims}>`,
    `    <figcaption class="caption">図 ${fig} — ${esc(c.hero.caption)}</figcaption>`,
    '  </figure>',
  ].join('\n');
}

const threeLines = c.three_lines.map((l) => `    <li>${escBold(l)}</li>`).join('\n');

function tableHtml(t, pad) {
  const isNum = (s) => /^[\d,.$¥%±〜~\-+:/\s分秒時hms]+$/.test(s);
  const numCol = (i) => i > 0 && t.rows.every((r2) => isNum(r2[i]));
  // .table-scroll: 多列 + URL セルの表はスマホ幅を超える — 紙面全体でなく表内の横スクロールに閉じ込める
  const rows = [
    `${pad}<div class="table-scroll">`,
    `${pad}<table class="data">`,
    `${pad}  <thead><tr>` + t.headers.map((hd, i) => `<th${numCol(i) ? ' class="num"' : ''}>${esc(hd)}</th>`).join('') + '</tr></thead>',
    `${pad}  <tbody>`,
    ...t.rows.map((row) => `${pad}    <tr>` + row.map((v, i) => `<td${numCol(i) ? ' class="num"' : ''}>${linkify(v)}</td>`).join('') + '</tr>'),
    `${pad}  </tbody>`,
    `${pad}</table>`,
    `${pad}</div>`,
  ];
  return rows;
}

let tbl = 0;
const sections = c.sections.map((s, si) => {
  const parts = ['  <section class="block">',
    `    <h2 class="title">${esc(s.heading)}</h2>`];
  for (const p of s.body) parts.push(`    <p>${escBold(p)}</p>`);
  if (s.svg) {
    fig++;
    parts.push('    <figure class="diagram">');
    parts.push('      ' + s.svg.trim());
    parts.push(`      <figcaption class="caption">図 ${fig} — ${esc(s.fig_caption)}</figcaption>`);
    parts.push('    </figure>');
  }
  if (s.image) {
    fig++;
    const dims = s.image.width ? ` width="${s.image.width}" height="${s.image.height}"` : '';
    parts.push('    <figure class="diagram">');
    parts.push(`      <img src="${esc(s.image.src)}" alt="${esc(s.image.alt)}"${dims}>`);
    parts.push(`      <figcaption class="caption">図 ${fig} — ${esc(s.fig_caption)}</figcaption>`);
    parts.push('    </figure>');
  }
  if (s.table) {
    tbl++;
    parts.push('    <figure class="diagram">');
    parts.push(...tableHtml(s.table, '      '));
    parts.push(`      <figcaption class="caption">表 ${tbl} — ${esc(s.table_caption)}</figcaption>`);
    parts.push('    </figure>');
  }
  parts.push('  </section>');
  return parts.join('\n');
}).join('\n\n');

let appendixHtml = '';
if (c.appendix) {
  const t = c.appendix.table;
  const sizeLabel = `${c.appendix.body.length} 段落${t ? ` + 表 ${t.rows.length} 行` : ''}`;
  const parts = [
    '  <details class="fold">',
    `    <summary>${esc(c.appendix.summary)}<span class="size">${sizeLabel}</span></summary>`,
    '    <div class="body">',
    ...c.appendix.body.map((p) => `      <p>${linkify(p) === esc(p) ? escBold(p) : linkify(p)}</p>`),
  ];
  if (t) parts.push(...tableHtml(t, '      '));
  parts.push('    </div>', '  </details>');
  appendixHtml = parts.join('\n');
}

let kpisHtml = '';
if (c.kpis) {
  kpisHtml = ['  <div class="kpis" aria-label="主要数値">',
    ...c.kpis.map((k) => `    <div class="kpi"><div class="n">${esc(k.n)}</div><div class="label">${esc(k.label)}</div>${k.delta ? `<div class="delta">${esc(k.delta)}</div>` : ''}</div>`),
    '  </div>'].join('\n');
}

let calloutHtml = '';
if (c.callout) {
  calloutHtml = `  <div class="callout"><span><b>${esc(c.callout.label)}:</b> ${escBold(c.callout.text)}</span></div>`;
}

const metaSpans = [`<span>作成 ${esc(c.meta.date)}</span>`, `<span>出所 ${linkify(c.meta.source)}</span>`];
if (isStr(c.meta.author)) metaSpans.push(`<span>作成者 ${esc(c.meta.author)}</span>`);

const out = tpl
  .replace(/\{\{TITLE\}\}/g, esc(c.title))
  .replace('{{KICKER}}', esc(c.kicker))
  .replace('{{CONCLUSION}}', escBold(c.conclusion))
  .replace('{{HERO}}', heroHtml)
  .replace('{{KPIS}}', kpisHtml)
  .replace('{{CALLOUT}}', calloutHtml)
  .replace('{{THREE_LINES}}', threeLines)
  .replace('{{SECTIONS}}', sections)
  .replace('{{APPENDIX}}', appendixHtml)
  .replace('{{META}}', metaSpans.join(''));

if (/\{\{[A-Z_]+\}\}/.test(out)) fail(['テンプレートに未解決のプレースホルダが残った (テンプレ改変とデータの不整合)']);

// 配る HTML の <style> から開発者向けコメントを取り除く。手順 5 の読み手チェックは out.html を
// ソースごと読むため、コメント内の作り手向けの言葉が「説明の無い言葉」として数えられてしまう。
// コメントはテンプレ (保守する人向け) にだけ残す。
const cleaned = out.replace(/<style>[\s\S]*?<\/style>/, (block) =>
  block.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\n[ \t]*\n(?:[ \t]*\n)+/g, '\n\n'));

fs.writeFileSync(outPath, cleaned);
console.log(`OK: ${outPath} (図 ${fig} 点 / セクション ${c.sections.length})`);
