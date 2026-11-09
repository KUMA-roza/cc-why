#!/usr/bin/env python3
"""赤ペン先生 — ローカル中継 (直接送信)。人がブラウザで [送信] を押した回答を、貼り戻し無しで agent が読む。

  python3 akapen-serve.py open   <sheet.html>              # 中継を起動 (常駐) してブラウザでシートを開く。URL を表示
  python3 akapen-serve.py wait   <sheet.html> [--timeout 570] [--fresh]
                                                          # 回答が届くまで待ち、届いたら全文を stdout に出す (exit 0)
                                                          # 時間切れは exit 3 (もう一度 wait すればよい)
  python3 akapen-serve.py status [<sheet.html>|<dir>]      # 中継の状態と、届いている回答の一覧
  python3 akapen-serve.py stop   [<sheet.html>|<dir>]      # 中継を止める (回答を反映した後に)

仕組み:
- シート (<sheet.html>) の親ディレクトリ (通常 ./akapen/) を 127.0.0.1 の空きポート (8765 から探す) で配信する
  小さな HTTP サーバをバックグラウンドで 1 つ動かす。同じディレクトリなら再利用する (状態は <dir>/.akapen-serve.json)。
- シートは http://127.0.0.1:<port>/<sheet 名> で開く。シートの JavaScript が GET /akapen-ping で中継を見つけると、
  ボタンが [送信] になり、押すと POST /akapen-answer で【赤ペン回答】固定形のテキストが届く。
- 届いたテキストは <dir>/<sheet 名>.answer.txt に保存され (受信時刻は .answer.json)、wait がそれを stdout に出す。
- 外部ネットワーク・追加ライブラリは使わない (python3 3.7 以上の標準ライブラリのみ)。127.0.0.1 以外からは繋がらない。
- file:// で開いたシートは従来どおり [貼り付ける文章を作る] → クリップボード → ターミナルへ貼る経路で動く。

終了コード: 0 = 成功 / 1 = 使い方・環境の誤り / 2 = 中継を起動できない / 3 = wait の時間切れ (回答未着)
"""
import argparse
import json
import os
import signal
import socket
import subprocess
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

if sys.version_info < (3, 7):
    sys.exit('akapen-serve: python3 3.7 以上が必要です (現在 %d.%d)。新しい python3 で実行してください。'
             % (sys.version_info[0], sys.version_info[1]))

from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer  # noqa: E402

STATE_NAME = '.akapen-serve.json'
LOG_NAME = '.akapen-serve.log'
PORT_FIRST = 8765
PORT_LAST = 8865
MAX_BODY = 5 * 1024 * 1024  # 5MB
ANSWER_SUFFIX = '.answer.txt'
META_SUFFIX = '.answer.json'


# ---------------------------------------------------------------- 共通
def resolve_target(arg: str):
    """引数 (シートのパス or ディレクトリ) → (dir, sheet 名 or None)"""
    p = Path(arg).expanduser()
    if p.is_dir():
        return p.resolve(), None
    if p.suffix.lower() in ('.html', '.htm') or p.is_file():
        return p.resolve().parent, p.name
    if not p.exists():
        sys.exit('akapen-serve: 見つかりません: %s' % arg)
    return p.resolve().parent, p.name


def state_path(d: Path) -> Path:
    return d / STATE_NAME


def read_state(d: Path):
    try:
        return json.loads(state_path(d).read_text(encoding='utf-8'))
    except (OSError, ValueError):
        return None


def write_state(d: Path, st: dict) -> None:
    state_path(d).write_text(json.dumps(st, ensure_ascii=False, indent=1), encoding='utf-8')


def pid_alive(pid: int) -> bool:
    if not pid or pid <= 0:
        return False
    if os.name == 'nt':
        try:
            out = subprocess.run(['tasklist', '/FI', 'PID eq %d' % pid], capture_output=True, text=True, timeout=5)
            return str(pid) in out.stdout
        except Exception:
            return False
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


def ping(port: int, timeout: float = 1.0):
    """GET /akapen-ping → dict か None"""
    try:
        with urllib.request.urlopen('http://127.0.0.1:%d/akapen-ping' % port, timeout=timeout) as r:
            j = json.loads(r.read().decode('utf-8'))
            return j if j.get('ok') else None
    except Exception:
        return None


def relay_running(d: Path):
    """このディレクトリの中継が生きていれば state を返す"""
    st = read_state(d)
    if not st:
        return None
    j = ping(int(st.get('port', 0)))
    if j and j.get('dir') == str(d) and pid_alive(int(st.get('pid', 0))):
        return st
    return None


def port_free(port: int) -> bool:
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        s.bind(('127.0.0.1', port))
        return True
    except OSError:
        return False
    finally:
        s.close()


def pick_port(preferred) -> int:
    cands = []
    if preferred:
        cands.append(int(preferred))
    cands += [p for p in range(PORT_FIRST, PORT_LAST + 1) if p not in cands]
    for p in cands:
        if port_free(p):
            return p
    sys.exit('akapen-serve: 127.0.0.1 の %d〜%d に空きポートがありません。`stop` で古い中継を止めるか、'
             '他のプロセスを終了してください。' % (PORT_FIRST, PORT_LAST))


def open_browser(url: str) -> bool:
    try:
        if sys.platform == 'darwin':
            return subprocess.run(['open', url], timeout=15).returncode == 0
        if os.name == 'nt':
            os.startfile(url)  # type: ignore[attr-defined]
            return True
        return subprocess.run(['xdg-open', url], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=15).returncode == 0
    except Exception:
        return False


# ---------------------------------------------------------------- サーバ本体 (_serve)
def make_handler(root: Path):
    root_str = str(root)

    class Handler(SimpleHTTPRequestHandler):
        def __init__(self, *a, **kw):
            super().__init__(*a, directory=root_str, **kw)

        def log_message(self, fmt, *args):  # ログは控えめに (ファイルへ)
            sys.stderr.write('%s %s\n' % (time.strftime('%H:%M:%S'), fmt % args))

        def end_headers(self):
            self.send_header('Cache-Control', 'no-store')
            super().end_headers()

        def _json(self, code: int, obj: dict):
            body = json.dumps(obj, ensure_ascii=False).encode('utf-8')
            self.send_response(code)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        # --- 同一マシンのブラウザからだけ受ける (DNS rebinding / CSRF 対策) ---
        def _allowed_hosts(self):
            port = self.server.server_port
            return ('127.0.0.1:%d' % port, 'localhost:%d' % port)

        def _host_ok(self) -> bool:
            # Host が 127.0.0.1:<port> / localhost:<port> 以外 (= 外部ドメインを 127.0.0.1 に向けた DNS rebinding) は拒否
            return self.headers.get('Host', '') in self._allowed_hosts()

        def _origin_ok(self) -> bool:
            # POST はシート (同一オリジン) の fetch だけ。ブラウザは POST に必ず Origin を付けるので、
            # 無い / 一致しない Origin と、preflight を起こさない Content-Type (text/plain 等) は拒否
            origin = self.headers.get('Origin', '')
            if origin not in tuple('http://' + h for h in self._allowed_hosts()):
                return False
            ctype = self.headers.get('Content-Type', '').split(';')[0].strip().lower()
            return ctype == 'application/json'

        def do_GET(self):
            if not self._host_ok():
                return self._json(403, {'ok': False, 'error': 'forbidden host'})
            path = urllib.parse.urlsplit(self.path).path
            if path == '/akapen-ping':
                return self._json(200, {'ok': True, 'dir': root_str, 'pid': os.getpid()})
            # 静的配信 (SimpleHTTPRequestHandler.translate_path が .. を落とし root 外へ出ない)
            return super().do_GET()

        def do_HEAD(self):
            # 親クラスの do_HEAD は send_head を直接呼ぶので、ここでも Host を検査する (存在・サイズの探索を塞ぐ)
            if not self._host_ok():
                self.send_response(403)  # HEAD は本文を返さない (Content-Length も付けない: GET の本文長と食い違わせない)
                self.end_headers()
                return
            return super().do_HEAD()

        def do_POST(self):
            if not self._host_ok():
                return self._json(403, {'ok': False, 'error': 'forbidden host'})
            path = urllib.parse.urlsplit(self.path).path
            if path != '/akapen-answer':
                return self._json(404, {'ok': False, 'error': 'not found'})
            if not self._origin_ok():
                return self._json(403, {'ok': False, 'error': 'forbidden origin (sheet must be opened via the relay URL)'})
            try:
                n = int(self.headers.get('Content-Length', '0'))
            except ValueError:
                return self._json(400, {'ok': False, 'error': 'bad Content-Length'})
            if n <= 0 or n > MAX_BODY:
                return self._json(413 if n > MAX_BODY else 400, {'ok': False, 'error': 'body size %d out of range (max %d)' % (n, MAX_BODY)})
            try:
                data = json.loads(self.rfile.read(n).decode('utf-8'))
            except (ValueError, UnicodeDecodeError):
                return self._json(400, {'ok': False, 'error': 'body must be JSON {sheet, text}'})
            sheet = data.get('sheet') if isinstance(data, dict) else None
            text = data.get('text') if isinstance(data, dict) else None
            if not isinstance(sheet, str) or not isinstance(text, str) or not sheet or not text.strip():
                return self._json(400, {'ok': False, 'error': 'sheet and text are required'})
            if '/' in sheet or '\\' in sheet or sheet in ('.', '..') or sheet.startswith('.') or '\x00' in sheet:
                return self._json(400, {'ok': False, 'error': 'invalid sheet name'})
            target = (root / (sheet + ANSWER_SUFFIX))
            if target.resolve().parent != root:
                return self._json(400, {'ok': False, 'error': 'invalid sheet name'})
            if not (root / sheet).is_file():
                return self._json(404, {'ok': False, 'error': 'sheet not found: %s' % sheet})
            if not text.endswith('\n'):
                text += '\n'
            tmp = root / (sheet + ANSWER_SUFFIX + '.tmp')
            tmp.write_text(text, encoding='utf-8')
            os.replace(tmp, target)  # wait 側が書きかけを読まないよう atomic に置く
            now = time.time()
            (root / (sheet + META_SUFFIX)).write_text(json.dumps({
                'sheet': sheet, 'received_at': time.strftime('%Y-%m-%dT%H:%M:%S%z', time.localtime(now)),
                'received_epoch': now, 'bytes': len(text.encode('utf-8')), 'lines': text.count('\n'),
            }, ensure_ascii=False, indent=1), encoding='utf-8')
            self.log_message('answer received: %s (%d bytes)', sheet, len(text))
            return self._json(200, {'ok': True, 'saved': str(target)})

    return Handler


def cmd_serve(d: Path, port: int) -> None:
    """常駐プロセスの本体 (open から起動される)"""
    srv = ThreadingHTTPServer(('127.0.0.1', port), make_handler(d))
    srv.daemon_threads = True
    write_state(d, {'pid': os.getpid(), 'port': port, 'dir': str(d), 'started_at': time.strftime('%Y-%m-%dT%H:%M:%S')})

    def _stop(*_):
        raise KeyboardInterrupt

    signal.signal(signal.SIGTERM, _stop)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        srv.server_close()
        st = read_state(d)
        if st and int(st.get('pid', 0)) == os.getpid():
            try:
                state_path(d).unlink()
            except OSError:
                pass


def spawn_daemon(d: Path, port: int) -> dict:
    log = open(d / LOG_NAME, 'ab')
    cmd = [sys.executable, os.path.abspath(__file__), '_serve', str(d), str(port)]
    kw = dict(stdin=subprocess.DEVNULL, stdout=log, stderr=log, cwd=str(d), close_fds=True)
    if os.name == 'nt':
        kw['creationflags'] = 0x00000008 | 0x00000200  # DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP
    else:
        kw['start_new_session'] = True
    proc = subprocess.Popen(cmd, **kw)
    log.close()
    deadline = time.time() + 8
    while time.time() < deadline:
        j = ping(port, 0.5)
        if j and j.get('dir') == str(d):
            return {'pid': proc.pid, 'port': port}
        if proc.poll() is not None:
            break
        time.sleep(0.15)
    tail = ''
    try:
        tail = (d / LOG_NAME).read_text(encoding='utf-8', errors='replace')[-800:]
    except OSError:
        pass
    sys.exit('akapen-serve: 中継を起動できませんでした (port %d)。ログ %s:\n%s' % (port, d / LOG_NAME, tail))


# ---------------------------------------------------------------- サブコマンド
def cmd_open(args) -> None:
    d, sheet = resolve_target(args.sheet)
    if not sheet:
        sys.exit('akapen-serve: open にはシート (HTML ファイル) を指定してください: %s' % args.sheet)
    if not (d / sheet).is_file():
        sys.exit('akapen-serve: シートが見つかりません: %s' % (d / sheet))
    st = relay_running(d)
    if st:
        port = int(st['port'])
        print('中継: 稼働中を再利用 (pid %s, port %d, dir %s)' % (st.get('pid'), port, d), file=sys.stderr)
    else:
        old = read_state(d)
        port = pick_port(old.get('port') if old else None)
        st = spawn_daemon(d, port)
        print('中継: 起動 (pid %s, port %d, dir %s)' % (st['pid'], port, d), file=sys.stderr)
    url = 'http://127.0.0.1:%d/%s' % (port, urllib.parse.quote(sheet))
    # 古い回答が残っていれば人に分かるように (再往復で同名にした時の取り違え防止)
    ans = d / (sheet + ANSWER_SUFFIX)
    if ans.is_file():
        print('注意: 前回の回答 %s が残っています。新しい回答を待つなら `wait --fresh` を使ってください。' % ans.name, file=sys.stderr)
    opened = False if args.no_browser else open_browser(url)
    if not opened and not args.no_browser:
        print('ブラウザを自動で開けませんでした。次の URL を人に開いてもらってください:', file=sys.stderr)
    print(url)


def cmd_wait(args) -> None:
    d, sheet = resolve_target(args.sheet)
    if not sheet:
        sys.exit('akapen-serve: wait にはシート (HTML ファイル) を指定してください')
    ans = d / (sheet + ANSWER_SUFFIX)
    start = time.time()
    if args.fresh and ans.is_file():
        try:
            ans.unlink()
            (d / (sheet + META_SUFFIX)).unlink()
        except OSError:
            pass
    if not relay_running(d):
        print('注意: この dir の中継が動いていません (`open` で起動できます)。ファイル %s の出現だけを待ちます。' % ans.name, file=sys.stderr)
    deadline = start + max(1, args.timeout)
    while True:
        if ans.is_file():
            # 書きかけ回避: 直後の書き込みが落ち着くまで少し待つ (os.replace で atomic だが念のため)
            time.sleep(0.2)
            text = ans.read_text(encoding='utf-8')
            sys.stdout.write(text)
            if not text.endswith('\n'):
                sys.stdout.write('\n')
            sys.stdout.flush()
            return
        if time.time() >= deadline:
            print('まだ回答がありません (%d 秒待ちました)。もう一度 wait してください: python3 %s wait %s'
                  % (int(args.timeout), os.path.basename(__file__), args.sheet), file=sys.stderr)
            sys.exit(3)
        time.sleep(1.0)


def cmd_status(args) -> None:
    d, _ = resolve_target(args.target or os.path.join(os.getcwd(), 'akapen'))
    st = read_state(d)
    live = relay_running(d)
    print('dir:    %s' % d)
    if live:
        print('中継:   稼働中 (pid %s, port %s, since %s)' % (live.get('pid'), live.get('port'), live.get('started_at', '?')))
        print('URL:    http://127.0.0.1:%s/<sheet.html>' % live.get('port'))
    elif st:
        print('中継:   停止 (状態ファイルが残存: pid %s, port %s)' % (st.get('pid'), st.get('port')))
    else:
        print('中継:   なし')
    sheets = sorted(p.name for p in d.glob('*.html'))
    for s in sheets:
        a = d / (s + ANSWER_SUFFIX)
        if a.is_file():
            try:
                meta = json.loads((d / (s + META_SUFFIX)).read_text(encoding='utf-8'))
                when = meta.get('received_at', '?')
            except (OSError, ValueError):
                when = '?'
            print('シート:     %s — 回答あり (%s, %d bytes)' % (s, when, a.stat().st_size))
        else:
            print('シート:     %s — 回答なし' % s)


def cmd_stop(args) -> None:
    d, _ = resolve_target(args.target or os.path.join(os.getcwd(), 'akapen'))
    st = read_state(d)
    if not st:
        print('中継: 状態ファイルがありません (%s)。止めるものはありません。' % state_path(d))
        return
    pid, port = int(st.get('pid', 0)), int(st.get('port', 0))
    if pid_alive(pid):
        try:
            os.kill(pid, signal.SIGTERM)
        except OSError as e:
            sys.exit('akapen-serve: pid %d を止められません: %s' % (pid, e))
        for _ in range(40):
            if not pid_alive(pid):
                break
            time.sleep(0.1)
        else:
            try:
                os.kill(pid, signal.SIGKILL if hasattr(signal, 'SIGKILL') else signal.SIGTERM)
            except OSError:
                pass
        print('中継: 停止しました (pid %d, port %d)' % (pid, port))
    else:
        print('中継: すでに動いていません (pid %d)。状態ファイルを消します。' % pid)
    try:
        state_path(d).unlink()
    except OSError:
        pass


def main() -> None:
    ap = argparse.ArgumentParser(prog='akapen-serve.py', description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest='cmd')
    p = sub.add_parser('open', help='中継を起動 (稼働中なら再利用) し、シートをブラウザで開く。URL を stdout に出す')
    p.add_argument('sheet', help='シートの HTML (例: ./akapen/topic-01.html)。親 dir が配信対象')
    p.add_argument('--no-browser', action='store_true', help='ブラウザを開かず URL だけ出す')
    p.set_defaults(fn=cmd_open)
    p = sub.add_parser('wait', help='回答 (<sheet>.answer.txt) が届くまで待ち、全文を stdout に出す。時間切れは exit 3')
    p.add_argument('sheet', help='シートの HTML (open に渡したもの)')
    p.add_argument('--timeout', type=int, default=570, help='待つ秒数 (既定 570 = Bash の 600 秒 timeout に収まる値)')
    p.add_argument('--fresh', action='store_true', help='残っている古い回答を捨て、新しく届く回答だけを待つ')
    p.set_defaults(fn=cmd_wait)
    p = sub.add_parser('status', help='中継の状態と、届いている回答の一覧')
    p.add_argument('target', nargs='?', help='シートの HTML か dir (省略 = ./akapen)')
    p.set_defaults(fn=cmd_status)
    p = sub.add_parser('stop', help='中継を止める (回答を反映した後に)')
    p.add_argument('target', nargs='?', help='シートの HTML か dir (省略 = ./akapen)')
    p.set_defaults(fn=cmd_stop)
    p = sub.add_parser('_serve')  # 内部用: open が起動する常駐プロセス
    p.add_argument('dir')
    p.add_argument('port', type=int)
    p.set_defaults(fn=lambda a: cmd_serve(Path(a.dir), a.port))
    a = ap.parse_args()
    if not a.cmd:
        ap.print_help()
        sys.exit(1)
    a.fn(a)


if __name__ == '__main__':
    main()
