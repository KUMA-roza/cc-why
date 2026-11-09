/** レポート: 1 セッションのタイムラインを HTML 1 枚にする (外部ファイル・外部通信なし) */
import { Inference, SessionDigest, Step } from './types';
import { flatten } from './extract';

export interface Row {
  id: string;
  depth: number;
  time: string;
  tool: string;
  summary: string;
  skill: string | null;
  why: string;
  strength: string;
  sourceKind: string;
  sourceRef: string;
  sourceText: string;
  unused: boolean | null;
  isError: boolean;
  own: { kind: string; text: string }[];
  prompt: string;
  prevResult: string;
  result: string;
  sub: string;
}

export function toRows(steps: Step[], inf: Map<string, Inference>): Row[] {
  return flatten(steps).map((s) => {
    const i = inf.get(s.id);
    return {
      id: s.id,
      depth: s.id.split('.').length - 1,
      time: s.timestamp ? new Date(s.timestamp).toLocaleTimeString('ja-JP', { hour12: false }) : '',
      tool: s.tool,
      summary: s.summary,
      skill: s.skill,
      why: i?.why ?? '',
      strength: i?.strength ?? (s.ownWords.length ? '強' : '—'),
      sourceKind: i?.sourceKind ?? '',
      sourceRef: i?.sourceRef ?? '',
      sourceText: i?.sourceText ?? '',
      unused: s.unused,
      isError: s.isError,
      own: s.ownWords,
      prompt: s.userPrompt,
      prevResult: s.prevResult,
      result: s.result,
      sub: s.subagentLabel ?? '',
    };
  });
}

const esc = (v: string): string =>
  v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const KIND_JA: Record<string, string> = { thinking: "thinking", text: "直前の説明文", "bash-description": "Bash の説明" };

function srcLabel(r: Row): string {
  if (r.sourceKind === "skill") return r.sourceRef;
  if (r.sourceKind === "result") return `直前の結果 ${r.sourceRef}`;
  if (r.sourceKind === "user") return "人の依頼";
  return "—";
}

function rowHtml(r: Row): string {
  const dd = (k: string, v: string, cls = "") => (v ? `<dt>${esc(k)}</dt><dd${cls ? ` class="${cls}"` : ""}>${esc(v)}</dd>` : "");
  const why =
    (r.why ? esc(r.why) : '<span class="empty">(推定なし)</span>') +
    (r.unused ? '<span class="flag">⚑ 後で参照なし</span>' : "") +
    (r.isError ? '<span class="err">× エラー</span>' : "") +
    (r.sub ? `<div class="sub">↳ subagent: ${esc(r.sub)}</div>` : "");
  return `<details class="row${r.unused ? " unused" : ""}" data-depth="${Math.min(r.depth, 2)}" data-skill="${esc(r.skill ?? "")}" data-strength="${esc(r.strength)}" data-unused="${r.unused === true ? 1 : 0}">
<summary><span class="mono m">${esc(r.time)}</span><span class="tool" title="${esc(r.summary)}">${esc(r.tool)}<span class="s">${esc(r.summary)}</span></span><span class="why">${why}</span><span class="g g-${esc(r.strength)}">${esc(r.strength)}</span><span class="src"${r.sourceText ? ` title="${esc(r.sourceText)}"` : ""}>${esc(srcLabel(r))}</span></summary>
<dl class="ev">${dd("入力", r.summary)}${r.own.map((o) => dd(`本人の言葉 (${KIND_JA[o.kind] ?? o.kind})`, o.text, "q")).join("")}${r.sourceText ? dd(`指示元の行 (${r.sourceRef})`, r.sourceText, "q") : ""}${dd("直前の人の依頼", r.prompt)}${dd("直前の結果", r.prevResult)}${dd("このステップの結果", r.result)}</dl>
</details>`;
}

function localTime(iso: string, withDate: boolean): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const p = (n: number) => String(n).padStart(2, "0");
  const t = `${p(d.getHours())}:${p(d.getMinutes())}`;
  return withDate ? `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${t}` : t;
}

/** 行は HTML に直接書き出す (JS が動かないビューアでも読める)。JS は絞り込みだけ */
export function renderReport(d: SessionDigest, inf: Map<string, Inference>, note: string): string {
  const rows = toRows(d.steps, inf);
  const skills = new Map<string, number>();
  for (const r of rows) if (r.skill) skills.set(r.skill, (skills.get(r.skill) ?? 0) + 1);
  const unk = Object.entries(d.unknownTypes);
  return `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>cc-why ${esc(d.sessionId.slice(0, 8))}</title>
${CSS}
</head><body><main>
<h1>なぜそうしたか — セッション <span class="mono">${esc(d.sessionId.slice(0, 8))}</span></h1>
<p class="m">${esc(d.cwd)} · ${d.agent === "codex" ? "Codex" : "Claude Code"} ${esc(d.version)} · ${localTime(d.start, true)} 〜 ${localTime(d.end, false)}</p>
<p class="m">${esc(note)}</p>
<div class="bar">
  <label>skill <select id="fSkill"><option value="">すべて</option>${[...skills].map(([k, n]) => `<option value="${esc(k)}">${esc(k)} (${n})</option>`).join("")}</select></label>
  <label><input type="checkbox" class="fS" value="強" checked> 強</label>
  <label><input type="checkbox" class="fS" value="中" checked> 中</label>
  <label><input type="checkbox" class="fS" value="弱" checked> 弱</label>
  <label><input type="checkbox" class="fS" value="—" checked> 推定なし</label>
  <label><input type="checkbox" id="fUnused"> 後で参照なしだけ</label>
  <span class="m" id="count">${rows.length} ステップ</span>
</div>
<p class="m legend"><span><b>強</b> = 本人の言葉あり (thinking・説明文・Bash の説明)</span><span><b>中</b> = 直前の結果か SKILL.md がはっきり促した</span><span><b>弱</b> = 流れからの推測だけ</span><span style="color:var(--red)">⚑ 後で参照なし</span> = 読んだファイルの名前も中身の断片も、その後の出力に出てこない (機械判定。言い換えて使った場合は見逃す)</p>
<div class="head"><span>時刻</span><span class="c2">ツール</span><span>なぜ</span><span>根拠</span><span class="c5">指示元</span></div>
<div id="rows">
${rows.length ? rows.map(rowHtml).join("\n") : '<p class="m">このセッションにはツール呼び出しがありません。</p>'}
</div>
<details style="margin-top:20px"><summary class="m">このセッションの人の依頼とログの情報</summary><ol class="m">${d.prompts.map((p) => `<li>${esc(p.split("\n")[0].slice(0, 200))}</li>`).join("")}</ol><p class="m">知らない種類の行: ${unk.length ? esc(unk.map(([k, n]) => `${k} × ${n}`).join(", ")) : "なし"}</p></details>
</main>
<script>
(function(){
  var rows=document.querySelectorAll("#rows .row");
  function apply(){
    var sk=document.getElementById("fSkill").value, st={}, onlyU=document.getElementById("fUnused").checked, n=0;
    document.querySelectorAll(".fS").forEach(function(c){st[c.value]=c.checked});
    rows.forEach(function(r){
      var show=(!sk||r.dataset.skill===sk)&&st[r.dataset.strength]!==false&&(!onlyU||r.dataset.unused==="1");
      r.style.display=show?"":"none"; if(show)n++;
    });
    document.getElementById("count").textContent=n+" / "+rows.length+" ステップ";
  }
  document.querySelectorAll(".bar input,.bar select").forEach(function(e){e.addEventListener("change",apply)});
})();
</script></body></html>
`;
}

const CSS = `<style>
:root{--ink:#212529;--muted:#64707C;--line:#DEE2E6;--paper:#fff;--dim:#F6F8FA;--accent:#2563EB;--red:#DC2626;--redbg:#FFF5F5}
@media (prefers-color-scheme:dark){:root{--ink:#E6E8EB;--muted:#9AA4AE;--line:#30363D;--paper:#0D1117;--dim:#161B22;--accent:#6CA0FF;--red:#F87171;--redbg:#2A1416}}
*{box-sizing:border-box}
body{margin:0;background:var(--paper);color:var(--ink);font:14px/1.7 system-ui,'Hiragino Kaku Gothic ProN',sans-serif;padding:0 16px 40px}
main{max-width:1100px;margin:0 auto}
h1{font-size:20px;margin:18px 0 4px}
.m{color:var(--muted);font-size:12.5px}
.mono{font-family:ui-monospace,Menlo,monospace;font-size:12.5px}
.bar{position:sticky;top:0;background:var(--paper);display:flex;flex-wrap:wrap;gap:14px;align-items:center;padding:10px 0;border-bottom:1px solid var(--line);z-index:2;font-size:13px}
select{font:inherit;background:var(--paper);color:var(--ink);border:1px solid var(--line);border-radius:6px;padding:2px 6px}
.legend span{margin-right:10px}
.row{border-bottom:1px solid var(--line)}
.row>summary{list-style:none;display:grid;grid-template-columns:62px 150px 1fr 34px 170px;gap:10px;padding:7px 4px;cursor:pointer;align-items:baseline}
.row>summary::-webkit-details-marker{display:none}
.row.unused>summary{background:var(--redbg)}
.row[data-depth="1"]>summary{padding-left:28px}
.row[data-depth="2"]>summary{padding-left:52px}
.tool{font-family:ui-monospace,Menlo,monospace;font-size:12.5px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tool .s{display:block;font-weight:400;color:var(--muted);overflow:hidden;text-overflow:ellipsis}
.why .flag{color:var(--red);font-weight:600;font-size:12px;margin-left:6px;white-space:nowrap}
.why .err{color:var(--red);font-size:12px;margin-left:6px}
.why .empty{color:var(--muted)}
.g{display:inline-block;min-width:24px;text-align:center;border-radius:4px;font-size:11px;font-weight:700;padding:0 4px}
.g-強{background:var(--ink);color:var(--paper)}
.g-中{background:var(--dim);color:var(--ink);border:1px solid var(--muted)}
.g-弱{color:var(--muted);border:1px solid var(--line)}
.g-—{color:var(--muted)}
.src{font-family:ui-monospace,Menlo,monospace;font-size:12px;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ev{padding:4px 12px 12px 76px;font-size:13px}
.ev dt{color:var(--muted);font-size:12px;margin-top:6px}
.ev dd{margin:0;white-space:pre-wrap;word-break:break-word;font-family:ui-monospace,Menlo,monospace;font-size:12px;background:var(--dim);border-radius:6px;padding:6px 8px;max-height:220px;overflow:auto}
.ev dd.q{border-left:3px solid var(--accent)}
.sub{color:var(--accent);font-size:12px}
.head{display:grid;grid-template-columns:62px 150px 1fr 34px 170px;gap:10px;padding:6px 4px;font-size:11.5px;color:var(--muted);border-bottom:1.5px solid var(--ink)}
@media (max-width:760px){.row>summary,.head{grid-template-columns:52px 1fr 30px}.row>summary .tool,.row>summary .src,.head .c2,.head .c5{display:none}.ev{padding-left:12px}}
</style>`;
