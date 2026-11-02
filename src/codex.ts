/**
 * 抽出 (Codex 版): ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl を Claude Code 版と同じ SessionDigest に揃える。
 * - ツール呼び出しは function_call (exec_command など) と custom_tool_call (exec = JS の中で tools.exec_command を呼ぶ / apply_patch)
 * - reasoning は暗号化されていて読めない。本人の言葉は assistant の message (phase=commentary など) だけ
 * - skill の欄は無い。$skill で注入された時か、Codex が SKILL.md を自分で読んだ時から、次の skill までを「その skill の最中」とみなす
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { excerpt, isReadStep, markUnused, Pending, summarize } from './extract';
import { OwnWords, SessionDigest, SkillText, Step } from './types';

export const CODEX_SESSIONS = path.join(os.homedir(), '.codex', 'sessions');

const KNOWN = new Set([
  'session_meta',
  'turn_context',
  'event_msg',
  'response_item',
  'token_usage_record',
  'world_state',
  'compacted',
]);
const SKILL_PATH = /([^\s"'`]*\/skills\/([\w.-]+)\/SKILL\.md)/;

interface Payload {
  type?: string;
  role?: string;
  phase?: string;
  name?: string;
  arguments?: string;
  input?: string;
  call_id?: string;
  output?: unknown;
  content?: { type: string; text?: string }[];
  summary?: { text?: string }[];
  message?: string;
  id?: string;
  cwd?: string;
  cli_version?: string;
}

export function isCodexFile(file: string): boolean {
  if (/rollout-.*\.jsonl$/.test(path.basename(file))) return true;
  try {
    const first = fs.readFileSync(file, 'utf8').split('\n', 1)[0];
    return JSON.parse(first).type === 'session_meta';
  } catch {
    return false;
  }
}

export function listCodexFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.jsonl')) out.push(p);
    }
  };
  walk(CODEX_SESSIONS);
  return out;
}

/** rollout-<日時>-<uuid>.jsonl の uuid 部分 */
export function codexId(file: string): string {
  const m = path.basename(file).match(/rollout-\d{4}-\d\d-\d\dT[\d-]+-(.+)\.jsonl$/);
  return m ? m[1] : path.basename(file, '.jsonl');
}

function outputText(o: unknown): string {
  if (typeof o === 'string') return o;
  if (Array.isArray(o))
    return o.map((b) => (b && typeof b.text === 'string' ? b.text : '')).join('\n');
  if (o && typeof o === 'object' && typeof (o as { output?: unknown }).output === 'string') {
    return (o as { output: string }).output;
  }
  return o == null ? '' : JSON.stringify(o);
}

/** exec の JS から実際のコマンドを取り出す (cmd:"..." を全部) */
function commandsInJs(js: string): string[] {
  const out: string[] = [];
  const re = /\bcmd\s*:\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(js))) {
    const lit = m[1];
    try {
      out.push(lit.startsWith('"') ? JSON.parse(lit) : lit.slice(1, -1).replace(/\\(.)/g, '$1'));
    } catch {
      out.push(lit.slice(1, -1));
    }
  }
  return out;
}

function patchTargets(patch: string): string[] {
  return Array.from(patch.matchAll(/\*\*\* (?:Update|Add|Delete) File: (.+)/g), (m) => m[1].trim());
}

/** ツール呼び出しを Step の材料 (表示名・要約・対象・読む系か) にする */
function describe(p: Payload): {
  tool: string;
  input: Record<string, unknown>;
  summary: string;
  targets: string[];
  read: boolean;
} {
  const name = p.name ?? '?';
  if (p.type === 'function_call') {
    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(p.arguments ?? '{}');
    } catch {
      args = { raw: p.arguments };
    }
    if (name === 'exec_command' || name === 'shell' || name === 'local_shell') {
      const cmd = Array.isArray(args.cmd)
        ? (args.cmd as string[]).join(' ')
        : String(args.cmd ?? args.command ?? '');
      const bash = { command: cmd };
      return {
        tool: name,
        input: args,
        ...summarize('Bash', bash),
        read: isReadStep('Bash', bash),
      };
    }
    return {
      tool: name,
      input: args,
      summary: JSON.stringify(args).slice(0, 160),
      targets: [],
      read: false,
    };
  }
  // custom_tool_call
  const raw = p.input ?? '';
  if (name === 'apply_patch') {
    const targets = patchTargets(raw);
    return {
      tool: name,
      input: { patch: raw },
      summary: targets.join(', ') || raw.split('\n')[0],
      targets,
      read: false,
    };
  }
  const cmds = commandsInJs(raw);
  // exec の JS の中で文字列に入った patch (\n がエスケープされたまま) も拾う
  const unescaped = raw.replace(/\\n/g, '\n').replace(/\\"/g, '"');
  const patched = patchTargets(unescaped);
  if (!cmds.length && /\*\*\* Begin Patch/.test(unescaped)) {
    return { tool: `${name}→apply_patch`, input: { js: raw }, summary: patched.join(', ') || 'patch', targets: patched, read: false };
  }
  if (cmds.length) {
    const bash = { command: cmds.join('\n') };
    const s = summarize('Bash', bash);
    return {
      tool: `${name}→exec_command`,
      input: { js: raw },
      summary: s.summary,
      targets: [...s.targets, ...patched],
      read: isReadStep('Bash', bash),
    };
  }
  return {
    tool: name,
    input: { js: raw },
    summary: raw.split('\n')[0].slice(0, 160),
    targets: patched,
    read: false,
  };
}

function loadSkillFile(file: string, name: string, fallback: string, cwd: string): SkillText {
  const p = path.resolve(cwd || '/', file.replace(/^~/, os.homedir()));
  if (fs.existsSync(p)) return { name, file: p, lines: fs.readFileSync(p, 'utf8').split('\n') };
  return { name, file: null, lines: fallback.split('\n') };
}

export function extractCodex(file: string): SessionDigest {
  const raw = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  const steps: Step[] = [];
  const pendings: Pending[] = [];
  const byCall = new Map<string, Pending & { skillPath?: { file: string; name: string } }>();
  const skills: SkillText[] = [];
  const prompts: string[] = [];
  const unknownTypes: Record<string, number> = {};
  const outputs: { lineNo: number; text: string }[] = [];
  let own: OwnWords[] = [];
  let prompt = '';
  let lastResult = '';
  let skill: string | null = null;
  const meta = { sessionId: codexId(file), cwd: '', version: '', start: '', end: '' };

  raw.forEach((rawLine, lineNo) => {
    let line: { type?: string; timestamp?: string; payload?: Payload };
    try {
      line = JSON.parse(rawLine);
    } catch {
      unknownTypes['(壊れた行)'] = (unknownTypes['(壊れた行)'] ?? 0) + 1;
      return;
    }
    const type = line.type ?? '(type なし)';
    if (!KNOWN.has(type)) unknownTypes[type] = (unknownTypes[type] ?? 0) + 1;
    if (line.timestamp) {
      if (!meta.start) meta.start = line.timestamp;
      meta.end = line.timestamp;
    }
    const p = line.payload ?? {};
    if (type === 'session_meta') {
      if (p.id) meta.sessionId = p.id;
      meta.cwd = p.cwd ?? meta.cwd;
      meta.version = p.cli_version ?? meta.version;
      return;
    }
    const newPrompt = (text: string) => {
      if (text === prompt) return; // 古い版は event_msg と response_item の両方に同じ依頼が載る
      prompt = text;
      prompts.push(text);
      own = [];
      // skill は一度注入されると文脈に残るので、次の skill が来るまで「その最中」のまま
    };
    if (type === 'event_msg' && p.type === 'user_message' && p.message?.trim()) {
      newPrompt(p.message.trim());
      return;
    }
    if (type !== 'response_item') return;

    if (p.type === 'message' && p.role === 'user') {
      const t = (p.content ?? []).map((c) => c.text ?? '').join('\n').trim();
      // $skill で起動された skill は <skill><name>…</name><path>…/SKILL.md</path> として注入される
      const sk = t.match(/^<skill>\s*<name>([^<]+)<\/name>\s*<path>([^<]+)<\/path>/);
      if (sk) {
        skill = sk[1].trim();
        if (!skills.some((x) => x.name === skill)) skills.push(loadSkillFile(sk[2].trim(), skill, t, meta.cwd));
        return;
      }
      // 環境・権限・AGENTS.md などの注入は依頼ではない
      if (!t || /^<[a-z_]+[\s>]/.test(t) || /^# AGENTS\.md/.test(t)) return;
      newPrompt(t);
      return;
    }

    if (p.type === 'reasoning') {
      const t = (p.summary ?? [])
        .map((x) => x.text ?? '')
        .join('\n')
        .trim();
      if (t) own.push({ kind: 'thinking', text: excerpt(t, 800) });
      return;
    }
    if (p.type === 'message' && p.role === 'assistant') {
      const t = (p.content ?? [])
        .map((c) => c.text ?? '')
        .join('\n')
        .trim();
      if (t) {
        own.push({ kind: 'text', text: excerpt(t, 800) });
        outputs.push({ lineNo, text: t });
      }
      return;
    }
    if ((p.type === 'function_call' || p.type === 'custom_tool_call') && p.call_id) {
      const d = describe(p);
      outputs.push({ lineNo, text: JSON.stringify(d.input) });
      const step: Step = {
        id: String(steps.length + 1),
        timestamp: line.timestamp ?? '',
        tool: d.tool,
        summary: d.summary,
        targets: d.targets,
        skill,
        userPrompt: excerpt(prompt, 300),
        ownWords: own,
        prevResult: lastResult,
        result: '',
        isError: false,
        unused: null,
        children: [],
      };
      const sp = d.summary.match(SKILL_PATH) ?? JSON.stringify(d.input).match(SKILL_PATH);
      const pend = {
        step,
        input: d.input,
        lineNo,
        read: d.read,
        resultFull: '',
        skillPath: sp ? { file: sp[1], name: sp[2] } : undefined,
      };
      steps.push(step);
      pendings.push(pend);
      byCall.set(p.call_id, pend);
      own = [];
      return;
    }
    if ((p.type === 'function_call_output' || p.type === 'custom_tool_call_output') && p.call_id) {
      const full = outputText(p.output);
      lastResult = excerpt(full);
      const pend = byCall.get(p.call_id);
      if (!pend) return;
      pend.step.result = lastResult;
      pend.resultFull = full;
      const code = full.match(/(?:Process exited with code|exit code:?)\s*(-?\d+)/i);
      pend.step.isError = !!code && code[1] !== '0';
      // SKILL.md を読んだら、このターンの残りは「その skill の最中」
      if (pend.skillPath && !pend.step.isError) {
        skill = pend.skillPath.name;
        if (!skills.some((s) => s.name === skill))
          skills.push(loadSkillFile(pend.skillPath.file, skill, full, meta.cwd));
      }
    }
  });

  markUnused(pendings, outputs);
  return { ...meta, agent: 'codex', file, prompts, skills, steps, unknownTypes };
}
