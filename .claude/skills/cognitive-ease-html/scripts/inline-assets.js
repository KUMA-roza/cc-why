#!/usr/bin/env node
'use strict';
// out.html → 画像を data URI に焼き込んだ自己完結 HTML (外部ライブラリ不要)。
// 使い方: node inline-assets.js <out.html> [-o out-shared.html]
//
// 素の out.html の画像は相対参照 — HTML 1 ファイルだけを持ち出す場面 (チャットや
// 共有ストレージへのアップロード / PDF 化 / 別フォルダへのコピー) では画像が欠落する。
// 共有・PDF 化の前に必ずこれを通し、out-shared.html の方を渡す (手順 6)。

const fs = require('fs');
const path = require('path');

const MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
};

function fail(msgs) {
  for (const m of msgs) console.error('NG: ' + m);
  process.exit(1);
}

// ---- 引数 ----
const argv = process.argv.slice(2);
let inPath = null, outPath = null;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '-o') outPath = argv[++i];
  else if (!inPath) inPath = a;
  else fail([`未知の引数: ${a}`]);
}
if (!inPath) fail(['使い方: node inline-assets.js <out.html> [-o out-shared.html]']);
outPath = outPath || path.join(path.dirname(path.resolve(inPath)), 'out-shared.html');

let html;
try { html = fs.readFileSync(inPath, 'utf8'); }
catch (e) { fail([`入力 HTML が読めない: ${e.message}`]); }

const baseDir = path.dirname(path.resolve(inPath));
const missing = [];
let count = 0;

const out = html.replace(/(<img\b[^>]*\bsrc=")([^"]+)(")/g, (whole, pre, src, post) => {
  if (src.startsWith('data:')) return whole; // 既に自己完結
  if (/^https?:\/\//.test(src) || path.isAbsolute(src)) {
    missing.push(`${src} — 外部 URL / 絶対パスは inline 化できない (render.js が拒否する形。相対パスに直す)`);
    return whole;
  }
  const p = path.join(baseDir, src);
  const mime = MIME[path.extname(src).toLowerCase()];
  if (!mime) { missing.push(`${src} — 未知の拡張子 (対応: ${Object.keys(MIME).join(' ')})`); return whole; }
  let buf;
  try { buf = fs.readFileSync(p); }
  catch (e) { missing.push(`${src} — 読めない: ${e.message}`); return whole; }
  count++;
  return `${pre}data:${mime};base64,${buf.toString('base64')}${post}`;
});

// 1 枚でも焼き込めなければ自己完結にならない — 部分成功の HTML を渡させない
if (missing.length) fail(missing);

fs.writeFileSync(outPath, out);
const kb = Math.round(fs.statSync(outPath).size / 1024);
console.log(`OK: ${outPath} (画像 ${count} 枚を data URI 化, ${kb}KB)`);
