# cc-why

Claude Code / Codex の会話ログを読み、エージェントがツールを使った理由を 1 ステップずつ推定して、タイムラインの HTML にするツールです。
「なぜこの skill を使ったか」「なぜこのファイルを読んだか」を見えるようにし、CLAUDE.md・skill・hook などのハーネスを直す材料にします。

## 何が分かるか

| 列 | 中身 |
|---|---|
| なぜ | そのステップをした理由 (推定)。本人の言葉がある行は、それを踏まえて書く |
| 根拠 | **強** = 本人の言葉あり (thinking・直前の説明文・Bash の説明) / **中** = 直前の結果か SKILL.md がはっきり促した / **弱** = 流れからの推測だけ |
| 指示元 | そのステップを促したもの。SKILL.md なら `<skill名>:<行番号>` で、行の本文も見られる |
| ⚑ 後で参照なし | 読んだファイルの名前も中身の断片も、その後の出力に一度も出てこない (機械判定。言い換えて使った場合も付くので「確かめる候補」として見る) |

ログには、エージェントの考えはほとんど残っていません (手元の Claude Code のログで、本人の言葉があるツール呼び出しは 36%)。そのため、推定には必ず根拠の強さを添えています。

## 使い方

Node.js 18 以上が要ります。推定には [Claude Code](https://claude.com/claude-code) (`claude`) か [Codex CLI](https://github.com/openai/codex) (`codex`) のどちらかを使います。

```sh
git clone https://github.com/KUMA-roza/cc-why.git
cd cc-why
npm install        # ビルドも一緒に走る
npm link           # どこでも cc-why と打てるようにする
```

分析したいプロジェクトのフォルダで:

```sh
cc-why list                       # このフォルダの Claude Code のセッション
cc-why list --codex [--all]       # Codex のセッション (--all で他のフォルダの分も)
cc-why report 34383e9e            # セッション ID (先頭だけでよい) か .jsonl のパス
```

`report` のオプション:

| オプション | 意味 |
|---|---|
| `--engine claude\|codex` | 推定に使う CLI。既定は `claude` (`claude -p`)。ログの種類とは別に選べる |
| `--model <m>` | 推定に使うモデル (既定は各 CLI の設定) |
| `--skill <name>` | その skill の最中のステップだけ推定・表示する |
| `--no-llm` | 推定せず、本人の言葉がある行だけ並べる (無料・すぐ終わる) |
| `-o <file>` | 出力先。既定は `~/.cache/cc-why/<id>.html` |

推定の結果はレポートの隣の `.infer.json` に保存されます。同じセッションをもう一度 `report` しても、推定するのは増えたステップだけです。

## 読むログ

| エージェント | 場所 |
|---|---|
| Claude Code | `~/.claude/projects/<フォルダ名>/<セッション>.jsonl` (subagent は `<セッション>/subagents/`) |
| Codex | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` |

Codex の reasoning は暗号化されていて読めません。そのため Codex で使える本人の言葉は、途中報告の文だけです。

## 仕組み

1. **抽出** (LLM なし): ログから、ツール呼び出しごとに手がかりを束ねる。直前の人の依頼・直前の結果・本人の言葉・どの skill の最中か・起動された SKILL.md の本文 (行番号付き)
2. **推定**: 手がかりを 30 ステップずつ `claude -p` か `codex exec` に渡し、「なぜ・根拠の強さ・指示元」を JSON で受け取る
3. **レポート**: HTML 1 枚。行は HTML に直接書き出すので、JavaScript が動かないビューアでも読める

## 注意: ログには秘密が入り得る

- ツールの結果に `.env` の中身や API キーが写っていることがあります。推定では、その抜粋を推定に使う CLI の提供元 (Anthropic か OpenAI) に送ります。Claude Code のログを `--engine codex` で推定すると、その抜粋は OpenAI に送られます (逆も同じ)
- レポートと `.infer.json` にもログの一部が入ります。人に渡す時は中身を見てからにしてください
- 推定の LLM は何も実行できない状態で動かします (claude: ツールと MCP を外す / codex: 読み取り専用・空のフォルダ)。ログの中に LLM を操る文が混ざっていても、ゆがむのは「なぜ」の文だけです
- 推定の実行そのものはログに残しません (claude: `--no-session-persistence` / codex: `--ephemeral`)。分析対象に混ざりません

## 設計の記録

[docs/design-01.html](docs/design-01.html) は、作る前に方針を決めた時の設計シートです (推定だけにするか・見せ方・推定エンジン)。回答は [docs/design-01.answer.txt](docs/design-01.answer.txt)。

## ライセンス

MIT
