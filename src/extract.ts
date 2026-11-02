/**
 * 抽出 (LLM なし): Claude Code の会話ログ (JSONL) から、ツール呼び出しごとに手がかりを束ねる。
 * 何度回しても同じ結果になる。
 */
import * as fs from 'fs';
import * as path from 'path';
import { OwnWords, SessionDigest, SkillText, Step } from './types';

const EXCERPT = 600;
/** 抽出が意味を知っている行の種類。これ以外は unknownTypes に数える */
const KNOWN_TYPES = new Set([
  'user',
  'assistant',
  'attachment',
  'system',
  'summary',
  'api-request',
  'api-request-blob',
  'api-request-shape',
  'last-prompt',
  'mode',
  'permission-mode',
  'atis-latch',
  'ai-title',
  'queue-operation',
  'tools-used',
  'file-history-snapshot',
  'file-history-delta',
  'cost-state',
]);
/** 中身を読む系のツール (未使用判定の対象) */
const READ_TOOLS = new Set(['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch', 'NotebookRead']);
/** コマンド列のどこかで中身を読むコマンドが動く (cat > file のような書き込みは除く) */
const READ_BASH = /(^|[;&|(]\s*|\n\s*)(cat(?!\s*>)|sed\s+-n|head|tail|grep|rg|ls|find|wc|jq|less)\b/;

interface RawBlock {
  type: string;
  text?: string;
  thinking?: string;
  name?: string;
  id?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}
interface RawLine {
  type?: string;
  timestamp?: string;
  isMeta?: boolean;
  cwd?: string;
  version?: string;
  sessionId?: string;
  attributionSkill?: string;
  message?: { content?: string | RawBlock[] };
}

export function excerpt(s: string, n = EXCERPT): string {
  const t = s.replace(/\s+\n/g, '\n').trim();
  return t.length > n ? t.slice(0, n) + ` …(+${t.length - n} 文字)` : t;
}

function blockText(c: unknown): string {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    return c
      .map((b: RawBlock) =>
        b.type === 'text'
          ? (b.text ?? '')
          : b.type === 'image'
            ? '[画像]'
            : b.type === 'tool_reference'
              ? `[ツール ${String((b as unknown as Record<string, unknown>).tool_name)}]`
              : '',
      )
      .join('\n');
  }
  return '';
}

/** 人が打った依頼か (skill 本文の注入・hook 通知・subagent の報告などを除く) */
function humanPrompt(line: RawLine): string | null {
  if (line.type !== 'user' || line.isMeta) return null;
  const c = line.message?.content;
  let text = '';
  if (typeof c === 'string') text = c;
  else if (Array.isArray(c)) {
    if (c.some((b) => b.type === 'tool_result')) return null;
    text = c
      .filter((b) => b.type === 'text')
      .map((b) => b.text ?? '')
      .join('\n');
  }
  if (!text.trim()) return null;
  const cmd = text.match(/<command-name>([^<]*)<\/command-name>/);
  if (cmd) {
    const args = text.match(/<command-args>([\s\S]*?)<\/command-args>/);
    return `${cmd[1]} ${args ? args[1] : ''}`.trim();
  }
  if (/^<(local-command|bash-|task-notification|system-reminder)/.test(text.trim())) return null;
  return text.trim();
}

export function summarize(
  tool: string,
  input: Record<string, unknown>,
): { summary: string; targets: string[] } {
  const s = (k: string) => (typeof input[k] === 'string' ? (input[k] as string) : '');
  switch (tool) {
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'NotebookEdit':
      return { summary: s('file_path'), targets: [s('file_path')].filter(Boolean) };
    case 'Grep':
      return {
        summary: `${s('pattern')}  ${s('path')}`.trim(),
        targets: [s('path')].filter(Boolean),
      };
    case 'Glob':
      return { summary: s('pattern'), targets: [] };
    case 'Bash': {
      const cmd = s('command');
      const targets = Array.from(
        new Set(cmd.match(/[~\w./-]*\/?[\w.-]+\.[A-Za-z]{1,6}\b/g) ?? []),
      ).filter((t) => !/^\d|^-/.test(t) && t.length > 3);
      return { summary: cmd.split('\n')[0], targets };
    }
    case 'Skill':
      return { summary: `${s('skill')} ${s('args')}`.trim(), targets: [] };
    case 'Agent':
    case 'Task':
      return {
        summary: `${s('subagent_type') || 'general-purpose'}: ${s('description')}`,
        targets: [],
      };
    case 'WebFetch':
      return { summary: s('url'), targets: [s('url')].filter(Boolean) };
    default:
      return { summary: JSON.stringify(input).slice(0, 160), targets: [] };
  }
}

export function isReadStep(tool: string, input: Record<string, unknown>): boolean {
  if (READ_TOOLS.has(tool)) return true;
  return tool === 'Bash' && typeof input.command === 'string' && READ_BASH.test(input.command);
}

function loadSkill(injected: string): SkillText | null {
  const m = injected.match(/^Base directory for this skill:\s*(\S+)/);
  if (!m) return null;
  const dir = m[1];
  const file = path.join(dir, 'SKILL.md');
  const name = path.basename(dir);
  if (fs.existsSync(file)) return { name, file, lines: fs.readFileSync(file, 'utf8').split('\n') };
  return { name, file: null, lines: injected.split('\n').slice(1) };
}

export interface Pending {
  step: Step;
  input: Record<string, unknown>;
  lineNo: number;
  read: boolean;
  resultFull: string;
}

/**
 * 1 本の JSONL を読む。subagent は <session>/subagents/*.meta.json の toolUseId で Agent ステップにぶら下げる。
 */
export function extractSession(file: string, idPrefix = ''): SessionDigest {
  const raw = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  const steps: Step[] = [];
  const byToolUse = new Map<string, Pending>();
  const pendings: Pending[] = [];
  const skills: SkillText[] = [];
  const prompts: string[] = [];
  const unknownTypes: Record<string, number> = {};
  /** 各行の Claude の出力 (本文 + ツール入力)。未使用判定の「後で現れるか」の検索先 */
  const outputs: { lineNo: number; text: string }[] = [];
  let own: OwnWords[] = [];
  let prompt = '';
  let lastResult = '';
  let meta = { sessionId: path.basename(file, '.jsonl'), cwd: '', version: '', start: '', end: '' };

  raw.forEach((rawLine, lineNo) => {
    let line: RawLine;
    try {
      line = JSON.parse(rawLine);
    } catch {
      unknownTypes['(壊れた行)'] = (unknownTypes['(壊れた行)'] ?? 0) + 1;
      return;
    }
    const type = line.type ?? '(type なし)';
    if (!KNOWN_TYPES.has(type)) unknownTypes[type] = (unknownTypes[type] ?? 0) + 1;
    if (line.timestamp) {
      if (!meta.start) meta.start = line.timestamp;
      meta.end = line.timestamp;
    }
    if (line.cwd && !meta.cwd) meta.cwd = line.cwd;
    if (line.version) meta.version = line.version;
    if (line.sessionId && !idPrefix) meta.sessionId = line.sessionId;

    if (type === 'user') {
      const hp = humanPrompt(line);
      if (hp) {
        prompt = hp;
        prompts.push(hp);
        own = [];
      }
      const c = line.message?.content;
      if (Array.isArray(c)) {
        for (const b of c) {
          if (b.type === 'text' && line.isMeta && b.text) {
            const sk = loadSkill(b.text);
            if (sk && !skills.some((x) => x.name === sk.name)) skills.push(sk);
          }
          if (b.type === 'tool_result' && b.tool_use_id) {
            const p = byToolUse.get(b.tool_use_id);
            const full = blockText(b.content);
            lastResult = excerpt(full);
            if (p) {
              p.step.result = lastResult;
              p.step.isError = !!b.is_error;
              p.resultFull = full;
            }
          }
        }
      } else if (typeof c === 'string' && line.isMeta) {
        const sk = loadSkill(c);
        if (sk && !skills.some((x) => x.name === sk.name)) skills.push(sk);
      }
      return;
    }

    if (type !== 'assistant') return;
    const blocks = line.message?.content;
    if (!Array.isArray(blocks)) return;
    const outText: string[] = [];
    for (const b of blocks) {
      if (b.type === 'thinking' && b.thinking?.trim())
        own.push({ kind: 'thinking', text: excerpt(b.thinking, 800) });
      else if (b.type === 'text' && b.text?.trim()) {
        own.push({ kind: 'text', text: excerpt(b.text, 800) });
        outText.push(b.text);
      } else if (b.type === 'tool_use' && b.name && b.id) {
        const input = b.input ?? {};
        outText.push(JSON.stringify(input));
        const words = [...own];
        if (
          b.name === 'Bash' &&
          typeof input.description === 'string' &&
          input.description.trim()
        ) {
          words.push({ kind: 'bash-description', text: input.description });
        }
        const { summary, targets } = summarize(b.name, input);
        const step: Step = {
          id: `${idPrefix}${steps.length + 1}`,
          timestamp: line.timestamp ?? '',
          tool: b.name,
          summary,
          targets,
          skill: line.attributionSkill ?? null,
          userPrompt: excerpt(prompt, 300),
          ownWords: words,
          prevResult: lastResult,
          result: '',
          isError: false,
          unused: null,
          children: [],
        };
        const p: Pending = { step, input, lineNo, read: isReadStep(b.name, input), resultFull: '' };
        steps.push(step);
        pendings.push(p);
        byToolUse.set(b.id, p);
        own = [];
      }
    }
    if (outText.length) outputs.push({ lineNo, text: outText.join('\n') });
  });

  markUnused(pendings, outputs);
  attachSubagents(file, byToolUse);
  return { ...meta, agent: 'claude', file, prompts, skills, steps, unknownTypes };
}

/** 結果の中で「中身を使った」と言える目印 (20 文字の断片) */
function fingerprints(full: string): string[] {
  const out: string[] = [];
  for (const l of full.split('\n')) {
    const t = l.replace(/\s+/g, ' ').trim();
    if (t.length < 20 || !/[\p{L}]/u.test(t)) continue;
    for (let i = 0; i + 20 <= Math.min(t.length, 120); i += 20) out.push(t.slice(i, i + 20));
    if (out.length > 200) break;
  }
  return out;
}

/**
 * 未使用 = 読んだファイルの名前も、結果の中身の断片 (20 文字) も、後の Claude の出力 (本文・ツール入力) に一度も現れない。
 * 言い換えて使った場合は見逃す (機械判定の限界)。
 */
export function markUnused(pendings: Pending[], outputs: { lineNo: number; text: string }[]): void {
  const norm = outputs.map((o) => ({ lineNo: o.lineNo, text: o.text.replace(/\s+/g, ' ') }));
  for (const p of pendings) {
    if (!p.read || p.step.isError || !p.resultFull.trim()) continue;
    const later = norm.filter((o) => o.lineNo > p.lineNo);
    // 同じ assistant 行の後続ブロックも「後」に含めるため、同じ行は除外しない代わりに自分の入力を除く
    const self = JSON.stringify(p.input);
    const corpus = later
      .map((o) => o.text)
      .join('\n')
      .replace(self, '');
    const names = p.step.targets.map((t) => path.basename(t)).filter((n) => n.length >= 4);
    const named = names.some((n) => corpus.includes(n));
    const fp = fingerprints(p.resultFull);
    // 中身の断片が取れない (画像だけ・短すぎる結果) は判定しない
    if (!fp.length) continue;
    const quoted = fp.some((f) => corpus.includes(f));
    p.step.unused = !named && !quoted;
  }
}

function attachSubagents(file: string, byToolUse: Map<string, Pending>): void {
  const dir = path.join(path.dirname(file), path.basename(file, '.jsonl'), 'subagents');
  if (!fs.existsSync(dir)) return;
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.meta.json')) continue;
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      const parent = byToolUse.get(meta.toolUseId);
      const jsonl = path.join(dir, f.replace(/\.meta\.json$/, '.jsonl'));
      if (!parent || !fs.existsSync(jsonl)) continue;
      const sub = extractSession(jsonl, `${parent.step.id}.`);
      parent.step.children = sub.steps;
      parent.step.subagentLabel = `${meta.agentType ?? 'subagent'} — ${meta.description ?? ''}`;
    } catch {
      /* 壊れた meta は無視 */
    }
  }
}

export function flatten(steps: Step[]): Step[] {
  return steps.flatMap((s) => [s, ...flatten(s.children)]);
}
