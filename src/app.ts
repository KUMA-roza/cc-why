/**
 * cc-why serve の画面 (HTML 1 枚)。ログ由来の文字列は必ず textContent で入れる (innerHTML に入れない)。
 */
export const APP_HTML = `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>cc-why</title>
<style>
:root{--ink:#212529;--muted:#64707C;--line:#DEE2E6;--paper:#fff;--dim:#F6F8FA;--accent:#2563EB;--red:#DC2626;--redbg:#FFF5F5;--sel:#EEF4FF}
@media (prefers-color-scheme:dark){:root{--ink:#E6E8EB;--muted:#9AA4AE;--line:#30363D;--paper:#0D1117;--dim:#161B22;--accent:#6CA0FF;--red:#F87171;--redbg:#2A1416;--sel:#132240}}
*{box-sizing:border-box}
body{margin:0;background:var(--paper);color:var(--ink);font:14px/1.7 system-ui,'Hiragino Kaku Gothic ProN',sans-serif}
.app{display:grid;grid-template-columns:340px 1fr;height:100vh}
aside{border-right:1px solid var(--line);overflow:auto;padding:12px}
section{overflow:auto;padding:0 18px 160px}
h1{font-size:16px;margin:0 0 8px}
h2{font-size:17px;margin:14px 0 2px}
.m{color:var(--muted);font-size:12.5px}
.mono{font-family:ui-monospace,Menlo,monospace;font-size:12.5px}
button,select,input[type=text]{font:inherit;color:var(--ink);background:var(--paper);border:1px solid var(--line);border-radius:6px;padding:3px 10px}
button{cursor:pointer}
button.primary{background:var(--accent);border-color:var(--accent);color:#fff}
button:disabled{opacity:.5;cursor:default}
.tabs{display:flex;gap:4px;margin-bottom:6px}
.tabs button.on{border-color:var(--accent);color:var(--accent);font-weight:600}
.sess{border-bottom:1px solid var(--line);padding:6px 4px;cursor:pointer}
.sess:hover{background:var(--dim)}
.sess.on{background:var(--sel)}
.sess .p{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ctl{position:sticky;top:0;background:var(--paper);z-index:3;padding:10px 0 8px;border-bottom:1px solid var(--line);display:flex;flex-wrap:wrap;gap:10px;align-items:center;font-size:13px}
.ctl .grp{display:flex;gap:6px;align-items:center}
#prog{color:var(--accent)}
#err{color:var(--red)}
.live{display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--muted);margin-right:4px}
.live.on{background:#16A34A}
.row{border-bottom:1px solid var(--line)}
.row>summary{list-style:none;display:grid;grid-template-columns:22px 62px 150px 1fr 34px 160px;gap:8px;padding:7px 4px;cursor:pointer;align-items:baseline}
.row>summary::-webkit-details-marker{display:none}
.row.unused>summary{background:var(--redbg)}
.row.picked>summary{box-shadow:inset 3px 0 0 var(--accent)}
.row[data-depth="1"]>summary{padding-left:26px}
.tool{font-family:ui-monospace,Menlo,monospace;font-size:12.5px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tool .s{display:block;font-weight:400;color:var(--muted);overflow:hidden;text-overflow:ellipsis}
.flag{color:var(--red);font-weight:600;font-size:12px;margin-left:6px;white-space:nowrap}
.wait{color:var(--muted);font-size:12px}
.g{display:inline-block;min-width:24px;text-align:center;border-radius:4px;font-size:11px;font-weight:700;padding:0 4px}
.g-強{background:var(--ink);color:var(--paper)}
.g-中{background:var(--dim);color:var(--ink);border:1px solid var(--muted)}
.g-弱{color:var(--muted);border:1px solid var(--line)}
.g-—{color:var(--muted)}
.src{font-family:ui-monospace,Menlo,monospace;font-size:12px;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ev{padding:4px 12px 12px 98px;font-size:13px}
.ev dt{color:var(--muted);font-size:12px;margin-top:6px}
.ev dd{margin:0;white-space:pre-wrap;word-break:break-word;font-family:ui-monospace,Menlo,monospace;font-size:12px;background:var(--dim);border-radius:6px;padding:6px 8px;max-height:220px;overflow:auto}
.ev dd.q{border-left:3px solid var(--accent)}
.memo{width:100%;margin-top:8px}
.sub{color:var(--accent);font-size:12px}
.consult{position:fixed;right:0;bottom:0;left:340px;background:var(--paper);border-top:2px solid var(--accent);padding:10px 18px;z-index:5}
.consult textarea{width:100%;min-height:52px;font:inherit;color:var(--ink);background:var(--paper);border:1px solid var(--line);border-radius:6px;padding:6px 8px}
.consult .bar{display:flex;gap:8px;align-items:center;margin-top:6px}
#out{display:none;width:100%;min-height:120px;margin-top:6px;font-family:ui-monospace,Menlo,monospace;font-size:12px}
.empty{padding:40px 0;color:var(--muted)}
@media (max-width:900px){.app{grid-template-columns:1fr;height:auto}aside{border-right:0;border-bottom:1px solid var(--line);max-height:40vh}.consult{left:0}.row>summary{grid-template-columns:22px 52px 1fr 30px}.row>summary .tool,.row>summary .src{display:none}.ev{padding-left:12px}}
</style></head><body>
<div class="app">
<aside>
  <h1>cc-why</h1>
  <div class="tabs"><button data-agent="claude" class="on">Claude Code</button><button data-agent="codex">Codex</button></div>
  <label class="m"><input type="checkbox" id="all"> 他のフォルダのセッションも</label>
  <p class="m" id="cwd"></p>
  <div id="list"><p class="m">読み込み中…</p></div>
</aside>
<section>
  <div id="none" class="empty">左からセッションを選んでください。</div>
  <div id="main" hidden>
    <h2>なぜそうしたか — <span class="mono" id="sid"></span></h2>
    <p class="m" id="meta"></p>
    <div class="ctl">
      <span class="grp"><span class="live" id="liveDot"></span><span class="m" id="liveTxt">ライブ</span></span>
      <span class="grp">推定: <label><input type="radio" name="engine" value="claude" checked> claude -p</label><label><input type="radio" name="engine" value="codex"> codex</label>
        <input type="text" id="model" placeholder="モデル (任意)" size="12"></span>
      <button class="primary" id="run">推定する</button>
      <label><input type="checkbox" id="auto"> ライブで自動推定</label>
      <span id="prog"></span><span id="err"></span>
    </div>
    <div class="ctl" style="top:44px">
      <label>skill <select id="fSkill"><option value="">すべて</option></select></label>
      <label><input type="checkbox" class="fS" value="強" checked> 強</label>
      <label><input type="checkbox" class="fS" value="中" checked> 中</label>
      <label><input type="checkbox" class="fS" value="弱" checked> 弱</label>
      <label><input type="checkbox" class="fS" value="—" checked> 推定なし</label>
      <label><input type="checkbox" id="fUnused"> 後で参照なしだけ</label>
      <label><input type="checkbox" id="fPicked"> 相談に入れた行だけ</label>
      <span class="m" id="count"></span>
    </div>
    <p class="m"><b>強</b> = 本人の言葉あり　<b>中</b> = 直前の結果か SKILL.md がはっきり促した　<b>弱</b> = 流れからの推測だけ　<span style="color:var(--red)">⚑ 後で参照なし</span> = 読んだ物の名前も中身の断片も後の出力に出ない (機械判定・確かめる候補)。左端の ☐ で相談に入れる。</p>
    <div id="rows"></div>
  </div>
</section>
</div>
<div class="consult" id="consult" hidden>
  <textarea id="ask" placeholder="改善したいこと・相談 (例: このスキルの読み込みを減らしたい)。行の左端の ☐ で材料を選び、行を開くとメモを書けます"></textarea>
  <div class="bar"><button class="primary" id="send">エージェントに送る</button><button id="copy">相談文をコピー</button><span class="m" id="cstat"></span><span class="m" style="margin-left:auto" id="npick"></span></div>
  <textarea id="out" readonly></textarea>
</div>
<script>
(function(){
"use strict";
var params=new URLSearchParams(location.search);
var TOKEN=params.get("t")||"";
var agent="claude", cur=null, es=null, S=null, open=new Set();
function $(id){return document.getElementById(id)}
function el(t,c,x){var e=document.createElement(t);if(c)e.className=c;if(x!=null)e.textContent=x;return e}
function api(p,body){
  var o={headers:{"X-CC-Why-Token":TOKEN}};
  if(body){o.method="POST";o.headers["Content-Type"]="application/json";o.body=JSON.stringify(body)}
  return fetch(p,o).then(function(r){return r.json().then(function(j){if(!r.ok)throw new Error(j.error||r.status);return j})});
}
function lt(s,date){var d=new Date(s);if(isNaN(d))return"";var p=function(n){return String(n).padStart(2,"0")};var t=p(d.getHours())+":"+p(d.getMinutes());return date?(d.getMonth()+1)+"/"+d.getDate()+" "+t:t}
function store(k,v){try{if(v===undefined)return JSON.parse(localStorage.getItem(k)||"null");localStorage.setItem(k,JSON.stringify(v))}catch(e){return null}}
function engine(){return document.querySelector("input[name=engine]:checked").value}

/* ---------- 一覧 ---------- */
function loadList(){
  $("list").textContent="読み込み中…";
  api("/api/sessions?agent="+agent+($("all").checked?"&all=1":"")).then(function(j){
    $("cwd").textContent="今のフォルダ: "+j.cwd;
    var box=$("list");box.textContent="";
    if(!j.sessions.length){box.appendChild(el("p","m","セッションがありません"));return}
    j.sessions.forEach(function(s){
      var d=el("div","sess"+(cur===s.key?" on":""));d.dataset.key=s.key;
      var top=el("div","");top.appendChild(el("span","mono",s.id+"  "));top.appendChild(el("span","m",lt(s.start,true)+" · "+s.steps+" steps"+(s.skills.length?" · "+s.skills.join(","):"")));
      d.appendChild(top);d.appendChild(el("div","p",s.prompt||"(依頼なし)"));
      if(s.cwd!==j.cwd)d.appendChild(el("div","m p",s.cwd));
      d.onclick=function(){select(s.key)};box.appendChild(d);
    });
    var h=decodeURIComponent(location.hash.slice(1));if(h&&!cur&&j.sessions.some(function(s){return s.key===h}))select(h);
  }).catch(function(e){$("list").textContent="読めませんでした: "+e.message});
}
document.querySelectorAll(".tabs button").forEach(function(b){b.onclick=function(){document.querySelectorAll(".tabs button").forEach(function(x){x.classList.toggle("on",x===b)});agent=b.dataset.agent;loadList()}});
$("all").onchange=loadList;

/* ---------- セッション (SSE でライブ更新) ---------- */
function select(key){
  cur=key;open=new Set();history.replaceState(null,"",location.pathname+location.search+"#"+encodeURIComponent(key));
  document.querySelectorAll(".sess").forEach(function(d){d.classList.toggle("on",d.dataset.key===key)});
  $("none").hidden=true;$("main").hidden=false;$("consult").hidden=false;$("err").textContent="";$("prog").textContent="";
  $("ask").value=store("cc-why:ask:"+key)||"";
  connect();
}
function connect(){
  if(es)es.close();
  es=new EventSource("/api/events?t="+encodeURIComponent(TOKEN)+"&key="+encodeURIComponent(cur)+"&engine="+engine());
  es.addEventListener("session",function(m){S=JSON.parse(m.data);render()});
  es.addEventListener("progress",function(m){var p=JSON.parse(m.data);$("prog").textContent=p.done<p.total?"推定中 ("+p.engine+") "+p.done+" / "+p.total:"";$("run").disabled=p.done<p.total});
  es.addEventListener("failure",function(m){$("err").textContent="推定に失敗: "+JSON.parse(m.data).message;$("run").disabled=false;$("prog").textContent=""});
  es.addEventListener("auto",function(m){var a=JSON.parse(m.data);$("auto").checked=!!a});
  es.onopen=function(){$("liveDot").classList.add("on");$("liveTxt").textContent="ライブ (ログの追記をすぐ反映)"};
  es.onerror=function(){$("liveDot").classList.remove("on");$("liveTxt").textContent="切断 — 再接続中"};
}
document.querySelectorAll("input[name=engine]").forEach(function(r){r.onchange=function(){if(cur)connect()}});

var SENDS={claude:"Anthropic",codex:"OpenAI"};
function crossOk(){
  var e=engine(), a=S&&S.agent;
  if(!a||a===e)return true;
  return confirm((a==="claude"?"Claude Code":"Codex")+" のログの抜粋を "+SENDS[e]+" に送って推定します。ログには秘密が写っていることがあります。続けますか？");
}
$("run").onclick=function(){
  if(!cur||!crossOk())return;
  $("err").textContent="";$("run").disabled=true;$("prog").textContent="推定を始めています…";
  api("/api/infer",{key:cur,engine:engine(),model:$("model").value.trim(),run:true}).catch(function(e){$("err").textContent=e.message;$("run").disabled=false});
};
$("auto").onchange=function(){
  if(!cur)return;
  if($("auto").checked&&!crossOk()){$("auto").checked=false;return}
  api("/api/infer",{key:cur,engine:engine(),model:$("model").value.trim(),auto:$("auto").checked}).catch(function(e){$("err").textContent=e.message});
};

/* ---------- 行 ---------- */
var kindJa={thinking:"thinking",text:"直前の説明文","bash-description":"Bash の説明"};
function srcLabel(r){return r.sourceKind==="skill"?r.sourceRef:r.sourceKind==="result"?"直前の結果 "+r.sourceRef:r.sourceKind==="user"?"人の依頼":"—"}
function picks(){return store("cc-why:pick:"+cur)||{}}
function setPick(id,v){var p=picks();if(v==null)delete p[id];else p[id]=v;store("cc-why:pick:"+cur,p);countPicks()}
function countPicks(){var n=Object.keys(picks()).length;$("npick").textContent=n?"相談に入れた行: "+n:"行の左端の ☐ で材料を選べます"}
function render(){
  if(!S||S.key!==cur)return;
  $("sid").textContent=S.session.slice(0,8)+" ("+(S.agent==="codex"?"Codex":"Claude Code")+")";
  $("meta").textContent=S.cwd+" · "+S.version+" · "+lt(S.start,true)+" 〜 "+lt(S.end)+" · 未推定 (結果まで揃った分) "+S.pending;
  var sel=$("fSkill"),keep=sel.value,sk={};S.rows.forEach(function(r){if(r.skill)sk[r.skill]=(sk[r.skill]||0)+1});
  sel.length=1;Object.keys(sk).forEach(function(s){var o=el("option","",s+" ("+sk[s]+")");o.value=s;sel.appendChild(o)});sel.value=keep;
  var box=$("rows");box.textContent="";var p=picks();
  S.rows.forEach(function(r){
    var d=el("details","row"+(r.unused?" unused":"")+(p[r.id]?" picked":""));
    d.dataset.depth=String(Math.min(r.depth,1));d.dataset.id=r.id;d.dataset.skill=r.skill||"";d.dataset.strength=r.strength;d.dataset.unused=r.unused?"1":"0";
    if(open.has(r.id))d.open=true;
    d.addEventListener("toggle",function(){if(d.open)open.add(r.id);else open.delete(r.id)});
    var s=el("summary");
    var cb=el("input");cb.type="checkbox";cb.title="相談に入れる";cb.checked=!!p[r.id];
    cb.onclick=function(ev){ev.stopPropagation()};
    cb.onchange=function(){setPick(r.id,cb.checked?(picks()[r.id]||{memo:""}):null);d.classList.toggle("picked",cb.checked);if($("fPicked").checked)filter()};
    s.appendChild(cb);
    s.appendChild(el("span","mono m",r.time));
    var t=el("span","tool",r.tool);t.title=r.summary;t.appendChild(el("span","s",r.summary));s.appendChild(t);
    var w=el("span","why");
    if(r.why)w.appendChild(document.createTextNode(r.why));
    else w.appendChild(el("span","wait",r.result||r.isError?"(未推定)":"(実行中 — 結果待ち)"));
    if(r.unused)w.appendChild(el("span","flag","⚑ 後で参照なし"));
    if(r.isError)w.appendChild(el("span","flag","× エラー"));
    if(r.sub)w.appendChild(el("div","sub","↳ subagent: "+r.sub));
    s.appendChild(w);
    s.appendChild(el("span","g g-"+r.strength,r.strength));
    var src=el("span","src",srcLabel(r));if(r.sourceText)src.title=r.sourceText;s.appendChild(src);
    d.appendChild(s);
    var ev=el("dl","ev");
    function add(k,v,c){if(!v)return;ev.appendChild(el("dt","",k));ev.appendChild(el("dd",c||"",v))}
    add("入力",r.summary);
    r.own.forEach(function(o){add("本人の言葉 ("+(kindJa[o.kind]||o.kind)+")",o.text,"q")});
    if(r.sourceText)add("指示元の行 ("+r.sourceRef+")",r.sourceText,"q");
    add("直前の人の依頼",r.prompt);add("直前の結果",r.prevResult);add("このステップの結果",r.result);
    var memo=el("input","memo");memo.type="text";memo.placeholder="この行についてのメモ (書くと相談に入る)";memo.value=(p[r.id]&&p[r.id].memo)||"";
    memo.oninput=function(){var v=memo.value;if(v||cb.checked){cb.checked=true;d.classList.add("picked");setPick(r.id,{memo:v})}};
    ev.appendChild(memo);
    d.appendChild(ev);box.appendChild(d);
  });
  filter();countPicks();
}
function filter(){
  var sk=$("fSkill").value,st={},u=$("fUnused").checked,pk=$("fPicked").checked,n=0,p=picks(),rows=document.querySelectorAll("#rows .row");
  document.querySelectorAll(".fS").forEach(function(c){st[c.value]=c.checked});
  rows.forEach(function(r){var show=(!sk||r.dataset.skill===sk)&&st[r.dataset.strength]!==false&&(!u||r.dataset.unused==="1")&&(!pk||p[r.dataset.id]);r.style.display=show?"":"none";if(show)n++});
  $("count").textContent=n+" / "+rows.length+" ステップ";
}
document.querySelectorAll(".ctl input,.ctl select").forEach(function(e){if(e.classList.contains("fS")||e.id==="fSkill"||e.id==="fUnused"||e.id==="fPicked")e.addEventListener("change",filter)});

/* ---------- 相談 ---------- */
$("ask").oninput=function(){store("cc-why:ask:"+cur,$("ask").value)};
function skillFile(name){var s=(S.skills||[]).find(function(x){return x.name===name});return s&&s.file}
function consultText(){
  var p=picks(),L=[];
  L.push("【cc-why 相談】"+(S.agent==="codex"?"Codex":"Claude Code")+" セッション "+S.session+" ("+S.cwd+")");
  S.rows.forEach(function(r){
    if(!p[r.id])return;
    L.push("");
    L.push("#"+r.id+" "+r.tool+": "+r.summary.slice(0,160)+(r.unused?"  ⚑ 後で参照なし":"")+(r.isError?"  × エラー":""));
    if(r.why)L.push("  なぜ (推定・根拠 "+r.strength+"): "+r.why);
    if(r.sourceKind==="skill"){var m=r.sourceRef.match(/^(.+):(\\d+)$/);var f=m&&skillFile(m[1]);L.push("  指示元: "+(f?f+":"+m[2]:r.sourceRef)+(r.sourceText?" 「"+r.sourceText+"」":""))}
    else if(r.sourceKind&&r.sourceKind!=="none")L.push("  指示元: "+srcLabel(r));
    if(r.own.length)L.push("  本人の言葉: "+r.own[r.own.length-1].text.split("\\n")[0].slice(0,200));
    if(p[r.id].memo)L.push("  メモ: "+p[r.id].memo);
  });
  var a=$("ask").value.trim();
  L.push("");L.push("相談: "+(a||"(なし)"));
  L.push("---");
  L.push("指示元のファイル (SKILL.md / CLAUDE.md など) を開いて、ハーネスをどう直すかを提案してください。書き換える前に確認してください。");
  return L.join("\\n");
}
function canSend(){if(!Object.keys(picks()).length&&!$("ask").value.trim()){$("cstat").textContent="行を選ぶか、相談を書いてください";return false}return true}
$("send").onclick=function(){
  if(!canSend())return;
  var t=consultText();$("send").disabled=true;$("cstat").textContent="送信中…";
  api("/api/consult",{text:t}).then(function(){$("cstat").textContent="✓ 送りました。エージェント側で cc-why wait を実行すると届きます";$("send").disabled=false})
  .catch(function(e){$("cstat").textContent="送れませんでした ("+e.message+") — コピーで渡してください";$("send").disabled=false});
};
$("copy").onclick=function(){
  if(!canSend())return;
  var t=consultText(),o=$("out");o.style.display="block";o.value=t;o.select();
  (navigator.clipboard?navigator.clipboard.writeText(t):Promise.reject()).then(function(){$("cstat").textContent="✓ コピーしました — エージェントのターミナルに貼ってください"},function(){$("cstat").textContent="下のテキストを選択してコピーしてください"});
};
loadList();
})();
</script></body></html>
`;
