/**
 * A story step read the way Studio's script editor reads it: the command's
 * own name ("@背景音乐"), what it acts on by name rather than by id, and the
 * few settings worth seeing at a glance ("音量=0.7"). The names and colours
 * follow Studio's catalogue (story.command / story.badge) and its command
 * groups (storyCommandCategories), so a row here looks like the row there.
 */
import type { AssetView, CharacterView, StoryRow, VariableView } from "@narraleaf/project-view";
import { language } from "./i18n";
import type { IconName } from "./Icon";

/** Studio's command groups, each with the hue its rows wear. */
export type CommandGroup = "character" | "stage" | "camera" | "scene" | "sound" | "data" | "flow" | "utils";

export const GROUP_COLOR: Record<CommandGroup, string> = {
  character: "rgb(var(--nl-primary))",
  stage: "#96b8a0",
  camera: "#d1a176",
  scene: "#8fa9c7",
  sound: "#bd97a3",
  data: "#b8aa86",
  flow: "#b2a6c9",
  utils: "#a8adb5",
};

export const GROUP_ICON: Record<CommandGroup, IconName> = {
  character: "people",
  stage: "image",
  camera: "play",
  scene: "image",
  sound: "music",
  data: "key",
  flow: "graph",
  utils: "file",
};

/** One setting of a step: a bare value, or `key=value`. `ref` values name something in the project. */
export interface CommandArg {
  readonly key?: string;
  readonly value: string;
  readonly ref?: boolean;
  /** A character's face, drawn before its name. */
  readonly avatar?: CharacterView;
}

export interface CommandView {
  readonly group: CommandGroup;
  readonly name: string;
  readonly args: readonly CommandArg[];
}

export interface CommandLookups {
  readonly characters: ReadonlyMap<string, CharacterView>;
  readonly variables: ReadonlyMap<string, VariableView>;
  readonly assets: ReadonlyMap<string, AssetView>;
  readonly sceneName: (id: string) => string | undefined;
}

/** One word in the console's three languages. */
const w = (cn: string, en: string, ja: string): string => (language === "zh" ? cn : language === "ja" ? ja : en);

type Json = unknown;
type Payload = Readonly<Record<string, Json>>;

const str = (value: Json): string | undefined => (typeof value === "string" && value !== "" ? value : undefined);
const num = (value: Json): number | undefined => (typeof value === "number" && Number.isFinite(value) ? value : undefined);
const obj = (value: Json): Payload | undefined => (typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Payload) : undefined);
const seconds = (ms: number): string => `${Math.round(ms / 100) / 10}${w("秒", "s", "秒")}`;

const CHARACTER_OP: Record<string, [string, string, string]> = {
  enter: ["显示", "Show", "表示"],
  exit: ["隐藏", "Hide", "非表示"],
  move: ["变换", "Transform", "変形"],
  expression: ["外观", "Face", "見た目"],
  setName: ["改名", "Rename", "改名"],
  setMotion: ["动作", "Motion", "モーション"],
  setSkin: ["皮肤", "Skin", "スキン"],
  setParams: ["参数", "Param", "パラメータ"],
};

const AUDIO_OP: Record<string, [string, string, string]> = {
  setBgm: ["背景音乐", "Music", "BGM"],
  playSound: ["音效", "Sound", "効果音"],
  setVolume: ["音量", "Volume", "音量"],
  setRate: ["倍速", "Rate", "速度"],
  stopSound: ["停止", "Stop", "停止"],
  pauseSound: ["暂停", "Pause", "一時停止"],
  resumeSound: ["继续", "Resume", "再開"],
  muteSound: ["静音", "Mute", "消音"],
  seekSound: ["跳转进度", "Seek", "シーク"],
};

const CAMERA_OP: Record<string, [string, string, string]> = {
  transform: ["镜头", "Camera", "カメラ"],
  look: ["色调", "Look", "色調"],
  motion: ["运镜", "Move", "カメラワーク"],
  reset: ["重置镜头", "Reset camera", "カメラをリセット"],
};

const TRACK: Record<string, [string, string, string]> = { bgm: ["音乐", "Music", "BGM"], voice: ["语音", "Voice", "ボイス"], sound: ["音效", "Sound", "効果音"], sfx: ["音效", "Sound", "効果音"] };

const STAGE_ACTION: Record<string, [string, string, string]> = {
  image: ["图片", "Image", "画像"],
  text: ["文本", "Text", "テキスト"],
  layer: ["图层", "Layer", "レイヤー"],
  video: ["视频", "Video", "動画"],
  vfx: ["氛围特效", "Ambience", "環境演出"],
  displayable: ["变换", "Transform", "変形"],
};

const pick = (table: Record<string, [string, string, string]>, key: string | undefined, fallback: string): string => {
  const pair = key === undefined ? undefined : table[key];
  return pair === undefined ? (key ?? fallback) : w(pair[0], pair[1], pair[2]);
};

function character(lookups: CommandLookups, id: string | undefined, fallback: string | undefined): CommandArg {
  const found = id === undefined ? undefined : lookups.characters.get(id);
  return found === undefined
    ? { value: fallback ?? w("角色", "Character", "キャラクター"), ref: true }
    : { value: found.name, ref: true, ...(found.avatarPath === undefined ? {} : { avatar: found }) };
}

function asset(lookups: CommandLookups, id: string | undefined): CommandArg | undefined {
  if (id === undefined) return undefined;
  return { value: lookups.assets.get(id)?.name ?? w("资产缺失", "Missing asset", "アセットが見つからない"), ref: true };
}

function variable(lookups: CommandLookups, target: Json): CommandArg {
  const id = str(obj(target)?.["variableId"]);
  return { value: (id === undefined ? undefined : lookups.variables.get(id)?.name) ?? w("变量", "Variable", "変数"), ref: true };
}

function literal(lookups: CommandLookups, value: Json): string {
  if (typeof value === "string") {
    if (value.startsWith("scene:")) return lookups.sceneName(value.slice(6)) ?? value.slice(6, 14);
    return value === "" ? "“”" : value;
  }
  if (value === undefined) return "";
  if (typeof value === "object") return obj(value)?.["kind"] === "variable" ? w("变量", "variable", "変数") : "…";
  return String(value);
}

function duration(payload: Payload): CommandArg | undefined {
  const ms = num(obj(payload["transform"])?.["durationMs"]) ?? num(payload["durationMs"]);
  return ms === undefined ? undefined : { key: w("持续时间", "duration", "時間"), value: seconds(ms) };
}

const defined = (args: readonly (CommandArg | undefined)[]): CommandArg[] => args.filter((arg): arg is CommandArg => arg !== undefined);

function conditionText(lookups: CommandLookups, condition: Json): string | undefined {
  const c = obj(condition);
  if (c === undefined) return undefined;
  if (c["kind"] === "variable") {
    const name = variable(lookups, c["target"]).value;
    const op = str(c["operator"]);
    const value = c["value"] === undefined ? "" : ` ${literal(lookups, c["value"])}`;
    const words: Record<string, string> = {
      isTrue: w("为真", "is true", "が真"),
      isFalse: w("为假", "is false", "が偽"),
      eq: "=",
      neq: "≠",
      gt: ">",
      gte: "≥",
      lt: "<",
      lte: "≤",
    };
    return `${name} ${op === undefined ? "" : (words[op] ?? op)}${value}`.trim();
  }
  if (c["kind"] === "blueprint") return w("由蓝图判定", "decided by a blueprint", "ブループリントで判定");
  return undefined;
}

/** What a command row is, in Studio's words. */
export function describeCommand(row: Extract<StoryRow, { kind: "command" }>, lookups: CommandLookups): CommandView {
  const p = row.payload;
  const action = str(p["action"]);
  const operation = str(p["operation"]);
  if (row.block === "action") {
    switch (action) {
      case "setBackground":
        return { group: "scene", name: w("背景", "Background", "背景"), args: defined([asset(lookups, str(p["assetId"])) ?? (str(p["color"]) ? { value: str(p["color"]) ?? "", ref: true } : undefined)]) };
      case "character": {
        const args = [character(lookups, str(p["characterId"]), str(p["objectName"]))];
        if (operation === "setName") args.push({ value: `→ ${str(p["displayName"]) ?? w("未命名", "unnamed", "名前なし")}` });
        if (operation === "expression" || operation === "setMotion" || operation === "setSkin") {
          const want = str(p["puppetName"]) ?? str(p["expression"]) ?? str(p["poseId"]);
          if (want !== undefined) args.push({ value: want, ref: true });
        }
        return { group: "character", name: pick(CHARACTER_OP, operation, w("角色", "Character", "キャラクター")), args: defined([...args, duration(p)]) };
      }
      case "audio": {
        const track = str(p["audioTrackId"]);
        const volume = num(p["volume"]);
        const fade = num(p["fadeMs"]);
        return {
          group: "sound",
          name: pick(AUDIO_OP, operation, w("音频", "Audio", "音声")),
          args: defined([
            asset(lookups, str(p["assetId"])) ?? (str(p["objectName"]) ? { value: str(p["objectName"]) ?? "", ref: true } : undefined),
            track === undefined || operation !== "setBgm" ? undefined : { key: w("音轨", "track", "トラック"), value: pick(TRACK, track, track) },
            volume === undefined ? undefined : { key: w("音量", "volume", "音量"), value: String(volume) },
            fade === undefined || fade === 0 ? undefined : { key: w("淡入淡出", "fade", "フェード"), value: seconds(fade) },
            p["loop"] === true ? { key: w("循环", "loop", "ループ"), value: "true" } : undefined,
          ]),
        };
      }
      case "setVariable": {
        const op = str(p["operator"]) ?? operation;
        const name = op === "add" || op === "increment" ? w("增加", "Add", "増加") : op === "subtract" || op === "decrement" ? w("减少", "Subtract", "減少") : op === "toggle" ? w("翻转", "Toggle", "反転") : op === "reset" ? w("重置", "Reset", "リセット") : w("赋值", "Set", "代入");
        return { group: "data", name, args: defined([variable(lookups, p["target"]), p["value"] === undefined ? undefined : { value: literal(lookups, p["value"]) }]) };
      }
      case "wait": {
        const ms = num(p["durationMs"]);
        return { group: "flow", name: w("等待", "Wait", "待機"), args: [{ value: p["mode"] === "duration" && ms !== undefined ? seconds(ms) : w("点击", "click", "クリック") }] };
      }
      case "camera": {
        const zoom = num(obj(obj(p["transform"])?.["to"])?.["zoom"]);
        return {
          group: "camera",
          name: pick(CAMERA_OP, operation, w("镜头", "Camera", "カメラ")),
          args: defined([zoom === undefined ? undefined : { key: w("缩放", "zoom", "ズーム"), value: String(zoom) }, duration(p)]),
        };
      }
      case "nvl":
        return { group: "scene", name: "NVL", args: [] };
      case "blueprint":
        return { group: "utils", name: w("蓝图", "Blueprint", "ブループリント"), args: defined([str(p["blueprintName"]) ? { value: str(p["blueprintName"]) ?? "", ref: true } : undefined]) };
      case "page":
        return { group: "flow", name: w("打开页面", "Open page", "ページを開く"), args: defined([str(p["surfaceName"]) ? { value: str(p["surfaceName"]) ?? "", ref: true } : undefined]) };
      case "input":
        return { group: operation === "rumble" || operation === "stopRumble" ? "scene" : "flow", name: operation === "rumble" || operation === "stopRumble" ? w("振动", "Rumble", "振動") : w("输入", "Input", "入力"), args: [] };
      case "plugin":
        return { group: "utils", name: w("插件", "Plugin", "プラグイン"), args: defined([str(p["actionId"]) ? { value: str(p["actionId"]) ?? "" } : undefined]) };
      default:
        if (action !== undefined && action in STAGE_ACTION) {
          return {
            group: "stage",
            name: pick(STAGE_ACTION, action, action),
            args: defined([str(p["objectName"]) ? { value: str(p["objectName"]) ?? "", ref: true } : undefined, duration(p)]),
          };
        }
        return { group: "scene", name: w("特效", "Effect", "エフェクト"), args: [] };
    }
  }
  if (row.block === "control") {
    const control = str(p["control"]);
    switch (control) {
      case "condition":
        return { group: "flow", name: w("条件", "If", "条件"), args: [] };
      case "conditionBranch": {
        const branch = str(p["branch"]);
        const name = branch === "if" ? w("如果", "If", "もし") : branch === "elseIf" ? w("否则如果", "Else if", "そうでなくもし") : w("否则", "Else", "そうでなければ");
        const cond = conditionText(lookups, p["condition"]);
        return { group: "flow", name, args: cond === undefined ? [] : [{ value: cond }] };
      }
      case "label":
        return { group: "flow", name: w("标签", "Label", "ラベル"), args: [{ value: str(p["name"]) ?? w("未命名", "unnamed", "名前なし"), ref: true }] };
      case "goto":
        return { group: "flow", name: w("跳到标签", "Go to", "ラベルへ"), args: [{ value: str(p["targetLabel"]) ?? w("未命名", "unnamed", "名前なし"), ref: true }] };
      case "break":
        return { group: "flow", name: w("跳出", "Break", "中断"), args: [] };
      case "cut":
        return { group: "flow", name: w("截断", "Cut", "カットポイント"), args: [] };
      case "ending":
        return { group: "flow", name: w("结局", "Ending", "エンディング"), args: [{ value: str(p["name"]) ?? w("未命名", "unnamed", "名前なし"), ref: true }] };
      case "quit":
        return { group: "scene", name: w("退出到页面", "Quit to page", "ページへ戻る"), args: [] };
      case "repeat": {
        const times = num(p["times"]);
        return p["until"] !== undefined
          ? { group: "flow", name: w("直到", "Until", "まで繰り返し"), args: defined([conditionText(lookups, p["until"]) === undefined ? undefined : { value: conditionText(lookups, p["until"]) ?? "" }]) }
          : { group: "flow", name: w("重复", "Repeat", "繰り返し"), args: [{ value: `${times ?? 1} ${w("次", "times", "回")}` }] };
      }
      default: {
        const mode = str(p["mode"]);
        if (control === "parallel" || mode === "all") return { group: "flow", name: w("并行", "Parallel", "並行"), args: [] };
        if (control === "race" || mode === "race" || mode === "any") return { group: "flow", name: w("竞速", "Race", "先着"), args: [] };
        return { group: "flow", name: w("顺序", "Sequence", "順次"), args: [] };
      }
    }
  }
  if (row.block === "jump") {
    const target = str(p["targetSceneId"]);
    return {
      group: "scene",
      name: w("跳转", "Jump", "ジャンプ"),
      args: [{ value: (target === undefined ? undefined : lookups.sceneName(target)) ?? w("未指定", "nowhere", "未指定"), ref: true }],
    };
  }
  if (row.block === "declaration") {
    const scope = str(p["scope"]);
    const name = scope === "saved" ? w("存档变量", "Saved variable", "セーブ変数") : scope === "persistent" ? w("持久变量", "Persistent variable", "永続変数") : w("场景变量", "Scene variable", "シーン変数");
    return {
      group: "data",
      name,
      args: defined([{ value: str(p["name"]) ?? "", ref: true }, p["defaultValue"] === undefined ? undefined : { value: `= ${literal(lookups, p["defaultValue"])}` }]),
    };
  }
  return { group: "utils", name: row.command, args: row.detail === undefined ? [] : [{ value: row.detail }] };
}
