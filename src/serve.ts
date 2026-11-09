/**
 * cc-why serve — ブラウザで一覧・推定・ライブ更新・改善の相談をするためのローカルサーバー。
 *
 * 守り (README の「serve の安全性」と対応):
 *  - 127.0.0.1 だけで待ち受ける (他の PC からは繋がらない)
 *  - 起動ごとの合言葉 (トークン) が無いリクエストは拒否する。ページは URL の ?t=、API はヘッダー、SSE は ?t= で渡す
 *  - Host が 127.0.0.1:<port> / localhost:<port> 以外は拒否 (DNS リバインディング対策)
 *  - POST は Origin が一致し、Content-Type が application/json の時だけ (他のサイトからの送り込みを防ぐ)
 *  - CORS の許可ヘッダーは出さない。画面にはログの文字列を textContent でしか入れない
 *  - ブラウザから受け取るのはセッションの鍵 (一覧で配ったもの) だけ。ファイルのパスは受け取らない
 *  - 推定の CLI はシェルを通さず起動し、モデル名は英数字と -._: だけ許す
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import { codexId, extractCodex, listCodexFiles, CODEX_SESSIONS } from './codex';
import { extractSession, flatten } from './extract';
import { cached, Engine, infer, pendingCount } from './infer';
import { toRows } from './report';
import { SessionDigest, Step } from './types';
import { APP_HTML } from './app';

export const CACHE_DIR = path.join(os.homedir(), '.cache', 'cc-why');
export const CONSULT_DIR = path.join(CACHE_DIR, 'consult');
const PROJECTS = path.join(os.homedir(), '.claude', 'projects');

/** ライブで自動推定する条件: 結果まで揃った未推定のステップがこの数たまるか、ログがこの時間止まった時 */
const AUTO_BATCH = 10;
const AUTO_IDLE_MS = 20_000;
const MODEL_RE = /^[\w.:-]{1,64}$/;

interface Entry {
  key: string;
  agent: 'claude' | 'codex';
  file: string;
}

interface Live {
  clients: Set<http.ServerResponse>;
  watchers: fs.FSWatcher[];
  debounce?: NodeJS.Timeout;
  idle?: NodeJS.Timeout;
  auto?: { engine: Engine; model?: string };
  running: boolean;
}

/** 結果まで揃ったステップだけ推定する (結果の前に推定すると、届いた後で推定が変わるため) */
const settled = (s: Step) => s.result !== '' || s.isError;

export function cacheFileFor(d: SessionDigest, engineTag = ''): string {
  const base = `${d.agent === 'codex' ? 'codex-' : ''}${d.sessionId.slice(0, 8)}`;
  return path.join(CACHE_DIR, `${base}${engineTag}.infer.json`);
}

export async function serve(opts: { port?: number; cwd: string; claudeDir: string; open: boolean }): Promise<void> {
  const token = crypto.randomBytes(18).toString('base64url');
  const registry = new Map<string, Entry>();
  const digests = new Map<string, { mtime: number; size: number; d: SessionDigest }>();
  const lives = new Map<string, Live>();
  let port = 0;

  const load = (e: Entry): SessionDigest => {
    const st = fs.statSync(e.file);
    const hit = digests.get(e.file);
    if (hit && hit.mtime === st.mtimeMs && hit.size === st.size) return hit.d;
    const d = e.agent === 'codex' ? extractCodex(e.file) : extractSession(e.file);
    digests.set(e.file, { mtime: st.mtimeMs, size: st.size, d });
    return d;
  };

  const register = (agent: 'claude' | 'codex', file: string): Entry => {
    const id = agent === 'codex' ? codexId(file) : path.basename(file, '.jsonl');
    const e = { key: `${agent}:${id}`, agent, file };
    registry.set(e.key, e);
    return e;
  };

  const listSessions = (agent: string, all: boolean) => {
    let files: { agent: 'claude' | 'codex'; file: string }[] = [];
    if (agent === 'codex') {
      files = listCodexFiles().map((file) => ({ agent: 'codex' as const, file }));
    } else {
      const dirs = all
        ? fs.readdirSync(PROJECTS).map((p) => path.join(PROJECTS, p)).filter((p) => fs.statSync(p).isDirectory())
        : [opts.claudeDir];
      for (const dir of dirs) {
        if (!fs.existsSync(dir)) continue;
        for (const f of fs.readdirSync(dir)) if (f.endsWith('.jsonl')) files.push({ agent: 'claude', file: path.join(dir, f) });
      }
    }
    files.sort((a, b) => fs.statSync(b.file).mtimeMs - fs.statSync(a.file).mtimeMs);
    const out = [];
    for (const f of files) {
      const e = register(f.agent, f.file);
      const d = load(e);
      if (agent === 'codex' && !all && d.cwd !== opts.cwd) continue;
      const steps = flatten(d.steps);
      out.push({
        key: e.key,
        id: d.sessionId.slice(0, 8),
        start: d.start,
        end: d.end,
        cwd: d.cwd,
        steps: steps.length,
        skills: Array.from(new Set(steps.map((s) => s.skill).filter(Boolean))),
        prompt: (d.prompts[0] ?? '').split('\n')[0].slice(0, 80),
      });
    }
    return out;
  };

  const engineTag = (engine: Engine) => (engine === 'claude' ? '' : `.by-${engine}`);

  const snapshot = (e: Entry, engine: Engine) => {
    const d = load(e);
    const cacheFile = cacheFileFor(d, engineTag(engine));
    return {
      key: e.key,
      agent: d.agent,
      session: d.sessionId,
      cwd: d.cwd,
      version: d.version,
      start: d.start,
      end: d.end,
      prompts: d.prompts.map((p) => p.split('\n')[0].slice(0, 200)),
      skills: d.skills.map((s) => ({ name: s.name, file: s.file })),
      rows: toRows(d.steps, cached(d, cacheFile, engine)),
      pending: pendingCount(d, cacheFile, engine, settled),
      unknownTypes: d.unknownTypes,
    };
  };

  const send = (key: string, event: string, data: unknown) => {
    const l = lives.get(key);
    if (!l) return;
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const c of l.clients) c.write(msg);
  };

  const runInfer = async (e: Entry, engine: Engine, model: string | undefined) => {
    const l = lives.get(e.key);
    if (l?.running) return;
    if (l) l.running = true;
    try {
      const d = load(e);
      await infer(d, {
        cacheFile: cacheFileFor(d, engineTag(engine)),
        engine,
        model,
        filter: settled,
        progress: (done, total) => send(e.key, 'progress', { done, total, engine }),
      });
      send(e.key, 'session', snapshot(e, engine));
    } catch (err) {
      send(e.key, 'failure', { message: (err as Error).message });
    } finally {
      if (l) l.running = false;
    }
  };

  /** ライブの自動推定: たまったらすぐ、少なければログが止まってから */
  const scheduleAuto = (e: Entry) => {
    const l = lives.get(e.key);
    if (!l?.auto || l.running) return;
    const { engine, model } = l.auto;
    const n = pendingCount(load(e), cacheFileFor(load(e), engineTag(engine)), engine, settled);
    if (l.idle) clearTimeout(l.idle);
    if (n >= AUTO_BATCH) void runInfer(e, engine, model).then(() => scheduleAuto(e));
    else if (n > 0) l.idle = setTimeout(() => void runInfer(e, engine, model).then(() => scheduleAuto(e)), AUTO_IDLE_MS);
  };

  const watch = (e: Entry, engine: Engine): Live => {
    let l = lives.get(e.key);
    if (l) return l;
    l = { clients: new Set(), watchers: [], running: false };
    lives.set(e.key, l);
    const onChange = () => {
      const cur = lives.get(e.key);
      if (!cur) return;
      if (cur.debounce) clearTimeout(cur.debounce);
      cur.debounce = setTimeout(() => {
        send(e.key, 'session', snapshot(e, cur.auto?.engine ?? engine));
        scheduleAuto(e);
      }, 400);
    };
    const targets = [e.file];
    const sub = path.join(path.dirname(e.file), path.basename(e.file, '.jsonl'), 'subagents');
    if (fs.existsSync(sub)) targets.push(sub);
    for (const t of targets) {
      try {
        l.watchers.push(fs.watch(t, onChange));
      } catch {
        /* 監視できない環境では更新が届かないだけ */
      }
    }
    return l;
  };

  const unwatchIfIdle = (key: string) => {
    const l = lives.get(key);
    if (!l || l.clients.size) return;
    l.watchers.forEach((w) => w.close());
    if (l.debounce) clearTimeout(l.debounce);
    if (l.idle) clearTimeout(l.idle);
    lives.delete(key);
  };

  const json = (res: http.ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  };

  const readBody = (req: http.IncomingMessage): Promise<Record<string, unknown>> =>
    new Promise((resolve, reject) => {
      let buf = '';
      req.on('data', (c) => {
        buf += c;
        if (buf.length > 1_000_000) {
          reject(new Error('too large'));
          req.destroy();
        }
      });
      req.on('end', () => {
        try {
          resolve(JSON.parse(buf || '{}'));
        } catch {
          reject(new Error('bad json'));
        }
      });
    });

  const tokenOk = (given: string | null | undefined) => {
    const a = Buffer.from(String(given ?? ''));
    const b = Buffer.from(token);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    if (!hosts.includes(req.headers.host ?? '')) return json(res, 403, { error: 'forbidden host' });
    const t = url.searchParams.get('t') ?? (req.headers['x-cc-why-token'] as string | undefined);
    if (!tokenOk(t)) return json(res, 403, { error: 'missing or wrong token (cc-why serve が表示した URL で開いてください)' });

    try {
      if (req.method === 'GET' && url.pathname === '/') {
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
          'Content-Security-Policy':
            "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src data:; base-uri 'none'; form-action 'none'",
        });
        return res.end(APP_HTML);
      }
      if (req.method === 'GET' && url.pathname === '/api/sessions') {
        return json(res, 200, { cwd: opts.cwd, sessions: listSessions(url.searchParams.get('agent') ?? 'claude', url.searchParams.get('all') === '1') });
      }
      const engineOf = (v: unknown): Engine => (v === 'codex' ? 'codex' : 'claude');
      if (req.method === 'GET' && url.pathname === '/api/events') {
        const e = registry.get(url.searchParams.get('key') ?? '');
        if (!e) return json(res, 404, { error: 'unknown session' });
        const engine = engineOf(url.searchParams.get('engine'));
        const l = watch(e, engine);
        res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
        l.clients.add(res);
        res.write(`event: session\ndata: ${JSON.stringify(snapshot(e, l.auto?.engine ?? engine))}\n\n`);
        if (l.auto) res.write(`event: auto\ndata: ${JSON.stringify(l.auto)}\n\n`);
        const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
        req.on('close', () => {
          clearInterval(ping);
          l.clients.delete(res);
          unwatchIfIdle(e.key);
        });
        return;
      }
      if (req.method === 'POST') {
        const origins = hosts.map((h) => `http://${h}`);
        if (!origins.includes(String(req.headers.origin ?? ''))) return json(res, 403, { error: 'forbidden origin' });
        if (!/^application\/json\b/.test(String(req.headers['content-type'] ?? ''))) return json(res, 415, { error: 'json only' });
        const body = await readBody(req);
        if (url.pathname === '/api/infer') {
          const e = registry.get(String(body.key ?? ''));
          if (!e) return json(res, 404, { error: 'unknown session' });
          const engine = engineOf(body.engine);
          const model = typeof body.model === 'string' && body.model ? body.model : undefined;
          if (model && !MODEL_RE.test(model)) return json(res, 400, { error: 'モデル名は英数字と -._: だけ' });
          const l = watch(e, engine);
          if (body.auto === true) l.auto = { engine, model };
          else if (body.auto === false) l.auto = undefined;
          send(e.key, 'auto', l.auto ?? null);
          if (body.run === true) void runInfer(e, engine, model).then(() => scheduleAuto(e));
          else scheduleAuto(e);
          unwatchIfIdle(e.key);
          return json(res, 202, { ok: true });
        }
        if (url.pathname === '/api/consult') {
          const text = String(body.text ?? '').trim();
          if (!text) return json(res, 400, { error: 'empty' });
          fs.mkdirSync(CONSULT_DIR, { recursive: true, mode: 0o700 });
          const stamp = new Date().toISOString().replace(/[:.]/g, '-');
          fs.writeFileSync(path.join(CONSULT_DIR, `${stamp}.txt`), text + '\n', { mode: 0o600 });
          return json(res, 200, { ok: true });
        }
      }
      return json(res, 404, { error: 'not found' });
    } catch (err) {
      return json(res, 500, { error: (err as Error).message });
    }
  });

  port = await listen(server, opts.port ?? 8790);
  const url = `http://127.0.0.1:${port}/?t=${token}`;
  console.log(`cc-why serve: ${url}`);
  console.log('このターミナルを閉じると止まります (Ctrl+C)。相談を受け取るには、エージェント側で `cc-why wait` を実行します。');
  if (opts.open) openBrowser(url);
}

function listen(server: http.Server, from: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const tryPort = (p: number) => {
      server.once('error', (e: NodeJS.ErrnoException) => {
        if (e.code === 'EADDRINUSE' && p < from + 50) tryPort(p + 1);
        else reject(e);
      });
      server.listen(p, '127.0.0.1', () => resolve(p));
    };
    tryPort(from);
  });
}

function openBrowser(url: string): void {
  const isWsl = os.release().toLowerCase().includes('microsoft');
  const [cmd, args] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', url]]
        : isWsl
          ? ['cmd.exe', ['/c', 'start', '', url.replace(/&/g, '^&')]]
          : ['xdg-open', [url]];
  try {
    const ch = spawn(cmd as string, args as string[], { stdio: 'ignore', detached: true });
    ch.on('error', () => console.log('ブラウザを自動で開けませんでした。上の URL を開いてください。'));
    ch.unref();
  } catch {
    console.log('ブラウザを自動で開けませんでした。上の URL を開いてください。');
  }
}

/**
 * cc-why wait — ブラウザの [送信] で届いた相談を待って表示する (エージェントのセッションから実行する)。
 * 届いたら全文を表示して exit 0。時間切れは exit 3 (もう一度 wait すればよい)。
 */
export async function waitConsult(timeoutSec: number): Promise<number> {
  fs.mkdirSync(CONSULT_DIR, { recursive: true, mode: 0o700 });
  const deadline = Date.now() + timeoutSec * 1000;
  for (;;) {
    const files = fs.readdirSync(CONSULT_DIR).filter((f) => f.endsWith('.txt')).sort();
    if (files.length) {
      const f = path.join(CONSULT_DIR, files[0]);
      process.stdout.write(fs.readFileSync(f, 'utf8'));
      fs.renameSync(f, f.replace(/\.txt$/, '.done'));
      return 0;
    }
    if (Date.now() > deadline) {
      console.error('cc-why wait: まだ相談が届いていません (もう一度 cc-why wait で待てます)');
      return 3;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}

export { CODEX_SESSIONS, PROJECTS };
