#!/usr/bin/env node
/**
 * cc-why — Claude Code / Codex の会話ログから「なぜそのツールを使ったか」を推定して HTML にする。
 *
 *   cc-why list [--codex [--all]] [--project <dir>]   セッションの一覧
 *     (既定は今のフォルダの Claude Code のセッション。--codex で Codex、--all で他のフォルダの Codex も)
 *   cc-why report <session> [options]               1 セッションのタイムライン HTML を作る
 *     <session>   セッション ID (先頭だけでよい) か .jsonl のパス。Claude Code / Codex は自動で見分ける
 *     --engine <claude|codex>  推定に使う CLI (既定 claude = claude -p / codex = codex exec)
 *     --model <m>      推定エンジンに渡すモデル (既定は各 CLI の設定)
 *     --skill <name>   この skill のステップだけ推定・表示
 *     --no-llm         推定せず、本人の言葉だけ並べる
 *     -o <file>        出力先 (既定 ~/.cache/cc-why/<id 先頭 8 桁>.html、Codex は codex-<id>.html)
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { codexId, extractCodex, isCodexFile, listCodexFiles } from './codex';
import { extractSession, flatten } from './extract';
import { Engine, infer, noLlm } from './infer';
import { renderReport } from './report';
import { SessionDigest } from './types';

const PROJECTS = path.join(os.homedir(), '.claude', 'projects');
const FLAGS = new Set(['no-llm', 'codex', 'all']);

function projectDir(cwd: string): string {
  return path.join(PROJECTS, cwd.replace(/[^A-Za-z0-9]/g, '-'));
}

function parseArgs(argv: string[]): { pos: string[]; opt: Record<string, string | true> } {
  const pos: string[] = [];
  const opt: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const k = a.replace(/^-+/, '');
    if (a.startsWith('--') && FLAGS.has(k)) opt[k] = true;
    else if (a.startsWith('--') || a === '-o') opt[k] = argv[++i] ?? '';
    else pos.push(a);
  }
  return { pos, opt };
}

function load(file: string): SessionDigest {
  return isCodexFile(file) ? extractCodex(file) : extractSession(file);
}

/** パス → そのまま。ID → 今のフォルダの Claude Code → Codex の順に探す */
function resolveSession(arg: string, dir: string): string {
  if (arg.endsWith('.jsonl') && fs.existsSync(arg)) return path.resolve(arg);
  const claude = fs.existsSync(dir)
    ? fs
        .readdirSync(dir)
        .filter((f) => f.endsWith('.jsonl') && f.startsWith(arg))
        .map((f) => path.join(dir, f))
    : [];
  const codex = listCodexFiles().filter((f) => codexId(f).startsWith(arg));
  const hits = [...claude, ...codex];
  if (hits.length === 1) return hits[0];
  if (hits.length > 1) {
    throw new Error(
      `"${arg}" に当たるセッションが ${hits.length} 本あります。もっと長く指定してください`,
    );
  }
  throw new Error(
    `セッション "${arg}" が見つかりません (cc-why list / cc-why list --codex で一覧)`,
  );
}

function printRow(d: SessionDigest): void {
  const steps = flatten(d.steps);
  const skills = Array.from(new Set(steps.map((s) => s.skill).filter(Boolean))).join(',');
  const first = (d.prompts[0] ?? '').split('\n')[0].slice(0, 50);
  const where = d.agent === 'codex' && d.cwd !== process.cwd() ? `  [${d.cwd}]` : '';
  console.log(
    `${d.sessionId.slice(0, 8)}  ${d.start.slice(0, 16).replace('T', ' ')}  ${String(steps.length).padStart(4)} steps  ${skills || '-'}  ${first}${where}`,
  );
}

function list(opt: Record<string, string | true>, dir: string): void {
  const byTime = (a: string, b: string) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs;
  if (opt.codex) {
    for (const f of listCodexFiles().sort(byTime)) {
      const d = extractCodex(f);
      if (opt.all || d.cwd === process.cwd()) printRow(d);
    }
    return;
  }
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')) : [];
  for (const f of files.map((f) => path.join(dir, f)).sort(byTime)) printRow(extractSession(f));
}

function report(pos: string[], opt: Record<string, string | true>, dir: string): void {
  if (!pos[0]) throw new Error('セッションを指定してください (cc-why list で一覧)');
  const engine = (typeof opt.engine === 'string' ? opt.engine : 'claude') as Engine;
  if (engine !== 'claude' && engine !== 'codex')
    throw new Error(`--engine は claude か codex: "${engine}"`);
  const file = resolveSession(pos[0], dir);
  const d = load(file);
  const skill = typeof opt.skill === 'string' ? opt.skill : undefined;
  const filter = skill ? (s: { skill: string | null }) => s.skill === skill : undefined;
  const base = `${d.agent === 'codex' ? 'codex-' : ''}${d.sessionId.slice(0, 8)}`;
  const out = typeof opt.o === 'string' ? opt.o : path.join(os.homedir(), '.cache', 'cc-why', `${base}.html`);
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  const all = flatten(d.steps);
  console.error(
    `${d.agent} ${path.basename(file)}: ${all.length} ステップ (本人の言葉あり ${all.filter((s) => s.ownWords.length).length})`,
  );

  let inf;
  let note: string;
  if (opt['no-llm']) {
    inf = noLlm(d, filter);
    note = '推定なし (--no-llm): 「なぜ」は本人の言葉がある行だけ。';
  } else {
    const cacheFile = out.replace(/\.html$/, '') + '.infer.json';
    inf = infer(d, {
      cacheFile,
      engine,
      model: typeof opt.model === 'string' ? opt.model : undefined,
      filter,
      log: (m) => console.error(m),
    });
    const cli = engine === 'codex' ? 'codex exec' : 'claude -p';
    note = `「なぜ」は ${cli} による推定 (本人の言葉がある行は根拠「強」)。推定のキャッシュ: ${cacheFile}`;
  }
  if (d.agent === 'codex')
    note += ' Codex の reasoning は暗号化されていて読めないため、本人の言葉は途中報告の文だけ。';
  if (skill) note += ` 推定の対象は skill「${skill}」のステップだけ。`;
  fs.writeFileSync(out, renderReport(d, inf, note));
  console.log(path.resolve(out));
}

function main(): void {
  const [cmd, ...rest] = process.argv.slice(2);
  const { pos, opt } = parseArgs(rest);
  const dir = typeof opt.project === 'string' ? opt.project : projectDir(process.cwd());
  try {
    if (cmd === 'list') list(opt, dir);
    else if (cmd === 'report') report(pos, opt, dir);
    else {
      console.log(
        fs
          .readFileSync(__filename, 'utf8')
          .match(/\/\*\*([\s\S]*?)\*\//)?.[1]
          .replace(/^ \* ?/gm, '') ?? '',
      );
      process.exit(cmd ? 2 : 0);
    }
  } catch (e) {
    console.error(`cc-why: ${(e as Error).message}`);
    process.exit(1);
  }
}

main();
