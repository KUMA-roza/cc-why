/**
 * 推定: 抽出したステップを claude -p か codex exec に渡し、各ステップに「なぜ・根拠の強さ・指示元」を付ける。
 * 推定の実行はログに残さない (claude: --no-session-persistence / codex: --ephemeral) (分析対象に混ざらない)。
 */
import { spawn } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Inference, SessionDigest, Step } from './types';
import { flatten } from './extract';

const BATCH = 30;
const SKILL_LINES_MAX = 400;

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    steps: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string' },
          why: { type: 'string', description: 'このステップをした理由。日本語 1〜2 文' },
          strength: { type: 'string', enum: ['中', '弱'] },
          sourceKind: { type: 'string', enum: ['user', 'skill', 'result', 'none'] },
          sourceRef: {
            type: 'string',
            description:
              "skill なら '<skill名>:<行番号>'、result なら '#<ステップid>'、user なら空",
          },
        },
        required: ['id', 'why', 'strength', 'sourceKind', 'sourceRef'],
      },
    },
  },
  required: ['steps'],
};

const SYSTEM = `あなたは AI コーディングエージェント (Claude Code / Codex) の会話ログを読む分析器です。ツールは使わず、指定の JSON だけを返します。
各ステップ (ツール呼び出し) について、エージェントが「なぜそれをしたか」を推し量ってください。

- why: 理由を日本語 1〜2 文。「〜を確かめるため」「手順 N に従って」のように目的を書く。何をしたかの言い換えにしない
- strength: 中 = 直前の結果か SKILL.md の文が、このステップをはっきり促している。弱 = 流れからの推測だけ
  (本人の言葉があるステップの強さは呼び出し側が「強」に決めるので、あなたは中か弱だけを選ぶ。ただし why は本人の言葉を踏まえて書く)
- sourceKind / sourceRef: このステップを促したもの
  - skill: SKILL.md の行。sourceRef は "<skill名>:<行番号>" (与えた行番号をそのまま使う)
  - result: 直前のステップの結果。sourceRef は "#<そのステップの id>"
  - user: 人の依頼。sourceRef は ""
  - none: 特定できない。sourceRef は ""
- 確かでない指示元をでっち上げない。迷ったら none / 弱`;

interface Cache {
  [key: string]: Inference;
}

export type Engine = 'claude' | 'codex';

/** claude の鍵は従来どおり (既存のキャッシュを生かす)。他のエンジンは頭に名前を足して別に持つ */
function keyOf(s: Step, engine: Engine = 'claude'): string {
  return crypto
    .createHash('sha1')
    .update(
      [...(engine === 'claude' ? [] : [engine]), s.id, s.tool, s.summary, s.prevResult, s.ownWords.map((w) => w.text).join('|')].join(
        '\u0000',
      ),
    )
    .digest('hex')
    .slice(0, 16);
}

function renderSkills(d: SessionDigest): string {
  return d.skills
    .map((sk) => {
      const body = sk.lines
        .slice(0, SKILL_LINES_MAX)
        .map((l, i) => `${sk.name}:${i + 1}| ${l}`)
        .join('\n');
      return `### skill ${sk.name}${sk.file ? ` (${sk.file})` : ''}\n${body}`;
    })
    .join('\n\n');
}

function renderStep(s: Step): string {
  const own = s.ownWords.map((w) => `  本人の言葉 [${w.kind}]: ${w.text}`).join('\n');
  return [
    `## #${s.id} ${s.tool}: ${s.summary}`,
    s.subagentLabel ? `  (subagent を起動: ${s.subagentLabel})` : '',
    `  skill: ${s.skill ?? 'なし'}`,
    `  直前の人の依頼: ${s.userPrompt.split('\n')[0]}`,
    own,
    s.prevResult ? `  直前の結果: ${s.prevResult.slice(0, 400)}` : '',
    s.result ? `  このステップの結果: ${s.result.slice(0, 200)}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

type Answer = { steps: (Inference & { id: string })[] };

/** 子プロセスを非同期で動かす (serve の中でもイベントループを止めない)。シェルは通さない */
function run(cmd: string, args: string[], input: string, cwd: string): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const ch = spawn(cmd, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => ch.kill('SIGTERM'), 10 * 60 * 1000);
    ch.stdout.on('data', (b) => (stdout += b));
    ch.stderr.on('data', (b) => (stderr += b));
    ch.on('error', (e) => {
      clearTimeout(timer);
      reject(new Error(`${cmd} を起動できません: ${e.message}`));
    });
    ch.on('close', (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
    ch.stdin.end(input);
  });
}

async function callClaude(prompt: string, model: string | undefined): Promise<Answer> {
  const args = [
    '-p',
    '--no-session-persistence',
    '--tools',
    '',
    '--strict-mcp-config',
    '--mcp-config',
    '{"mcpServers":{}}',
    '--setting-sources',
    '',
    '--system-prompt',
    SYSTEM,
    '--output-format',
    'json',
    '--json-schema',
    JSON.stringify(SCHEMA),
  ];
  if (model) args.push('--model', model);
  const r = await run('claude', args, prompt, os.tmpdir());
  let out: { structured_output?: Answer; is_error?: boolean; result?: string };
  try {
    out = JSON.parse(r.stdout);
  } catch {
    throw new Error(`claude -p の出力が JSON ではありません (exit ${r.status}): ${(r.stderr || r.stdout).slice(0, 400)}`);
  }
  if (out.is_error || !out.structured_output) {
    throw new Error(`claude -p が失敗しました: ${String(out.result).slice(0, 400)}`);
  }
  return out.structured_output;
}

/**
 * codex exec で推定する。--ephemeral でセッションを残さない (分析対象に混ざらない)。
 * read-only の sandbox・空の作業フォルダで動かす。codex にはシステムプロンプトの引数が無いので先頭に足す。
 */
async function callCodex(prompt: string, model: string | undefined): Promise<Answer> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-why-codex-'));
  try {
    const schemaFile = path.join(dir, 'schema.json');
    const outFile = path.join(dir, 'out.json');
    fs.writeFileSync(schemaFile, JSON.stringify(SCHEMA));
    const args = ['exec', '--ephemeral', '--skip-git-repo-check', '-s', 'read-only', '-C', dir, '--output-schema', schemaFile, '-o', outFile];
    if (model) args.push('-m', model);
    args.push('-');
    const r = await run('codex', args, `${SYSTEM}\n\n${prompt}`, dir);
    if (r.status !== 0 || !fs.existsSync(outFile)) {
      throw new Error(`codex exec が失敗しました (exit ${r.status}): ${(r.stderr || r.stdout).slice(-400)}`);
    }
    try {
      return JSON.parse(fs.readFileSync(outFile, 'utf8'));
    } catch {
      throw new Error(`codex exec の出力が JSON ではありません: ${fs.readFileSync(outFile, 'utf8').slice(0, 400)}`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function skillLine(d: SessionDigest, ref: string): string | undefined {
  const m = ref.match(/^(.+):(\d+)$/);
  if (!m) return undefined;
  const sk = d.skills.find((s) => s.name === m[1]);
  return sk?.lines[Number(m[2]) - 1]?.trim() || undefined;
}

function readCache(file: string | undefined): Cache {
  if (!file || !fs.existsSync(file)) return {};
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

/** 推定済みの分だけを引く (LLM は呼ばない) */
export function cached(d: SessionDigest, cacheFile: string | undefined, engine: Engine = 'claude'): Map<string, Inference> {
  const cache = readCache(cacheFile);
  const out = new Map<string, Inference>();
  for (const s of flatten(d.steps)) {
    const c = cache[keyOf(s, engine)];
    if (c) out.set(s.id, c);
  }
  return out;
}

/** まだ推定していないステップの数 */
export function pendingCount(d: SessionDigest, cacheFile: string | undefined, engine: Engine, filter?: (s: Step) => boolean): number {
  const cache = readCache(cacheFile);
  return flatten(d.steps).filter(filter ?? (() => true)).filter((s) => !cache[keyOf(s, engine)]).length;
}

/**
 * 推定を付ける。cacheFile があれば読み書きし、手がかりが同じステップは再推定しない。
 * filter で対象を絞る (例: 特定 skill のステップだけ / 結果まで揃ったステップだけ)。
 */
export async function infer(
  d: SessionDigest,
  opts: {
    cacheFile?: string;
    model?: string;
    engine?: Engine;
    filter?: (s: Step) => boolean;
    log?: (m: string) => void;
    progress?: (done: number, total: number) => void;
  },
): Promise<Map<string, Inference>> {
  const log = opts.log ?? (() => {});
  const engine: Engine = opts.engine ?? 'claude';
  const cache = readCache(opts.cacheFile);
  const all = flatten(d.steps).filter(opts.filter ?? (() => true));
  const todo = all.filter((s) => !cache[keyOf(s, engine)]);
  const head = [
    `# セッション ${d.sessionId} (cwd: ${d.cwd})`,
    `## 人の依頼 (順に)\n${d.prompts.map((p, i) => `${i + 1}. ${p.split('\n')[0].slice(0, 200)}`).join('\n')}`,
    d.skills.length ? `## 起動された skill の本文 (行番号付き)\n${renderSkills(d)}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');

  opts.progress?.(0, todo.length);
  for (let i = 0; i < todo.length; i += BATCH) {
    const batch = todo.slice(i, i + BATCH);
    log(`推定中 (${engine}) ${i + 1}-${i + batch.length} / ${todo.length} ステップ…`);
    const prompt = `${head}\n\n# 推定するステップ\n${batch.map(renderStep).join('\n\n')}\n\n上の ${batch.length} ステップすべてについて JSON で答えてください。`;
    const res = engine === 'codex' ? await callCodex(prompt, opts.model) : await callClaude(prompt, opts.model);
    for (const s of batch) {
      const r = res.steps.find((x) => String(x.id).replace(/[^0-9.]/g, '').replace(/\.$/, '') === s.id);
      if (!r) continue;
      cache[keyOf(s, engine)] = {
        why: r.why,
        strength: s.ownWords.length ? '強' : r.strength === '中' ? '中' : '弱',
        sourceKind: r.sourceKind,
        sourceRef: r.sourceRef,
        sourceText: r.sourceKind === 'skill' ? skillLine(d, r.sourceRef) : undefined,
      };
    }
    if (opts.cacheFile) fs.writeFileSync(opts.cacheFile, JSON.stringify(cache, null, 1));
    opts.progress?.(Math.min(i + BATCH, todo.length), todo.length);
  }
  return mapFrom(all, cache, engine);
}

function mapFrom(all: Step[], cache: Cache, engine: Engine): Map<string, Inference> {
  const out = new Map<string, Inference>();
  for (const s of all) {
    const c = cache[keyOf(s, engine)];
    if (c) out.set(s.id, c);
  }
  return out;
}

/** LLM を使わない時: 本人の言葉だけを「なぜ」に並べる */
export function noLlm(d: SessionDigest, filter?: (s: Step) => boolean): Map<string, Inference> {
  const out = new Map<string, Inference>();
  for (const s of flatten(d.steps).filter(filter ?? (() => true))) {
    if (!s.ownWords.length) continue;
    const w = s.ownWords[s.ownWords.length - 1];
    out.set(s.id, {
      why: w.text.split('\n')[0].slice(0, 200),
      strength: '強',
      sourceKind: 'none',
      sourceRef: '',
    });
  }
  return out;
}
