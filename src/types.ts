/** 本人の言葉 (ステップの直前に Claude 自身が残した説明)。あれば根拠「強」 */
export interface OwnWords {
  kind: 'thinking' | 'text' | 'bash-description';
  text: string;
}

/** ツール呼び出し 1 回 = 分析の 1 行 */
export interface Step {
  /** 表示用 ID。親セッションは "12"、subagent 内は "12.3" */
  id: string;
  timestamp: string;
  tool: string;
  /** 入力の 1 行要約 (コマンド・パスなど) */
  summary: string;
  /** 読み書きしたファイルなど */
  targets: string[];
  /** どの skill の最中か (ログの attributionSkill) */
  skill: string | null;
  /** 直前の人の依頼 (1 行目付近) */
  userPrompt: string;
  ownWords: OwnWords[];
  /** 直前のステップの結果の抜粋 (判断材料) */
  prevResult: string;
  /** このステップの結果の抜粋 */
  result: string;
  isError: boolean;
  /** 読んだのに後で名前も中身も現れない (機械判定)。読む系のステップ以外は null */
  unused: boolean | null;
  /** Agent ツールが立てた subagent のステップ */
  children: Step[];
  subagentLabel?: string;
}

/** セッション中で起動された skill の本文 (指示元の行番号の土台) */
export interface SkillText {
  name: string;
  /** 実ファイルがあればその絶対パス */
  file: string | null;
  lines: string[];
}

export interface SessionDigest {
  /** どのエージェントのログか */
  agent: "claude" | "codex";
  sessionId: string;
  file: string;
  cwd: string;
  version: string;
  start: string;
  end: string;
  prompts: string[];
  skills: SkillText[];
  steps: Step[];
  /** 知らない種類の行 (Claude Code の版でログの形が変わった時の目印) */
  unknownTypes: Record<string, number>;
}

export type Strength = '強' | '中' | '弱';

export interface Inference {
  why: string;
  strength: Strength;
  /** 指示元: user = 人の依頼 / skill = SKILL.md の行 / result = 直前の結果 / none */
  sourceKind: 'user' | 'skill' | 'result' | 'none';
  /** 例: "akapen SKILL.md:42"。sourceKind=none なら空 */
  sourceRef: string;
  /** source が skill の時、その行の本文 (表示用) */
  sourceText?: string;
}
