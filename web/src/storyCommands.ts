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

const zh = language === "zh";
const w = (cn: string, en: string): string => (zh ? cn : en);

type Json = unknown;
type Payload = Readonly<Record<string, Json>>;

const str = (value: Json): string | undefined => (typeof value === "string" && value !== "" ? value : undefined);
const num = (value: Json): number | undefined => (typeof value === "number" && Number.isFinite(value) ? value : undefined);
const obj = (value: Json): Payload | undefined => (typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Payload) : undefined);
const seconds = (ms: number): string => `${Math.round(ms / 100) / 10}${w("秒", "s")}`;

const CHARACTER_OP: Record<string, [string, string]> = {
  enter: ["显示", "Show"],
  exit: ["隐藏", "Hide"],
  move: ["变换", "Transform"],
  expression: ["外观", "Face"],
  setName: ["改名", "Rename"],
  setMotion: ["动作", "Motion"],
  setSkin: ["皮肤", "Skin"],
  setParams: ["参数", "Param"],
};

const AUDIO_OP: Record<string, [string, string]> = {
  setBgm: ["背景音乐", "Music"],
  playSound: ["音效", "Sound"],
  setVolume: ["音量", "Volume"],
  setRate: ["倍速", "Rate"],
  stopSound: ["停止", "Stop"],
  pauseSound: ["暂停", "Pause"],
  resumeSound: ["继续", "Resume"],
  muteSound: ["静音", "Mute"],
  seekSound: ["跳转进度", "Seek"],
};

const CAMERA_OP: Record<string, [string, string]> = {
  transform: ["镜头", "Camera"],
  look: ["色调", "Look"],
  motion: ["运镜", "Move"],
  reset: ["重置镜头", "Reset camera"],
};

const TRACK: Record<string, [string, string]> = { bgm: ["音乐", "Music"], voice: ["语音", "Voice"], sound: ["音效", "Sound"], sfx: ["音效", "Sound"] };

const STAGE_ACTION: Record<string, [string, string]> = {
  image: ["图片", "Image"],
  text: ["文本", "Text"],
  layer: ["图层", "Layer"],
  video: ["视频", "Video"],
  vfx: ["氛围特效", "Ambience"],
  displayable: ["变换", "Transform"],
};

const pick = (table: Record<string, [string, string]>, key: string | undefined, fallback: string): string => {
  const pair = key === undefined ? undefined : table[key];
  return pair === undefined ? (key ?? fallback) : w(pair[0], pair[1]);
};

function character(lookups: CommandLookups, id: string | undefined, fallback: string | undefined): CommandArg {
  const found = id === undefined ? undefined : lookups.characters.get(id);
  return found === undefined
    ? { value: fallback ?? w("角色", "Character"), ref: true }
    : { value: found.name, ref: true, ...(found.avatarPath === undefined ? {} : { avatar: found }) };
}

function asset(lookups: CommandLookups, id: string | undefined): CommandArg | undefined {
  if (id === undefined) return undefined;
  return { value: lookups.assets.get(id)?.name ?? w("资产缺失", "Missing asset"), ref: true };
}

function variable(lookups: CommandLookups, target: Json): CommandArg {
  const id = str(obj(target)?.["variableId"]);
  return { value: (id === undefined ? undefined : lookups.variables.get(id)?.name) ?? w("变量", "Variable"), ref: true };
}

function literal(lookups: CommandLookups, value: Json): string {
  if (typeof value === "string") {
    if (value.startsWith("scene:")) return lookups.sceneName(value.slice(6)) ?? value.slice(6, 14);
    return value === "" ? "“”" : value;
  }
  if (value === undefined) return "";
  if (typeof value === "object") return obj(value)?.["kind"] === "variable" ? w("变量", "variable") : "…";
  return String(value);
}

function duration(payload: Payload): CommandArg | undefined {
  const ms = num(obj(payload["transform"])?.["durationMs"]) ?? num(payload["durationMs"]);
  return ms === undefined ? undefined : { key: w("持续时间", "duration"), value: seconds(ms) };
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
      isTrue: w("为真", "is true"),
      isFalse: w("为假", "is false"),
      eq: "=",
      neq: "≠",
      gt: ">",
      gte: "≥",
      lt: "<",
      lte: "≤",
    };
    return `${name} ${op === undefined ? "" : (words[op] ?? op)}${value}`.trim();
  }
  if (c["kind"] === "blueprint") return w("由蓝图判定", "decided by a blueprint");
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
        return { group: "scene", name: w("背景", "Background"), args: defined([asset(lookups, str(p["assetId"])) ?? (str(p["color"]) ? { value: str(p["color"]) ?? "", ref: true } : undefined)]) };
      case "character": {
        const args = [character(lookups, str(p["characterId"]), str(p["objectName"]))];
        if (operation === "setName") args.push({ value: `→ ${str(p["displayName"]) ?? w("未命名", "unnamed")}` });
        if (operation === "expression" || operation === "setMotion" || operation === "setSkin") {
          const want = str(p["puppetName"]) ?? str(p["expression"]) ?? str(p["poseId"]);
          if (want !== undefined) args.push({ value: want, ref: true });
        }
        return { group: "character", name: pick(CHARACTER_OP, operation, w("角色", "Character")), args: defined([...args, duration(p)]) };
      }
      case "audio": {
        const track = str(p["audioTrackId"]);
        const volume = num(p["volume"]);
        const fade = num(p["fadeMs"]);
        return {
          group: "sound",
          name: pick(AUDIO_OP, operation, w("音频", "Audio")),
          args: defined([
            asset(lookups, str(p["assetId"])) ?? (str(p["objectName"]) ? { value: str(p["objectName"]) ?? "", ref: true } : undefined),
            track === undefined || operation !== "setBgm" ? undefined : { key: w("音轨", "track"), value: pick(TRACK, track, track) },
            volume === undefined ? undefined : { key: w("音量", "volume"), value: String(volume) },
            fade === undefined || fade === 0 ? undefined : { key: w("淡入淡出", "fade"), value: seconds(fade) },
            p["loop"] === true ? { key: w("循环", "loop"), value: "true" } : undefined,
          ]),
        };
      }
      case "setVariable": {
        const op = str(p["operator"]) ?? operation;
        const name = op === "add" || op === "increment" ? w("增加", "Add") : op === "subtract" || op === "decrement" ? w("减少", "Subtract") : op === "toggle" ? w("翻转", "Toggle") : op === "reset" ? w("重置", "Reset") : w("赋值", "Set");
        return { group: "data", name, args: defined([variable(lookups, p["target"]), p["value"] === undefined ? undefined : { value: literal(lookups, p["value"]) }]) };
      }
      case "wait": {
        const ms = num(p["durationMs"]);
        return { group: "flow", name: w("等待", "Wait"), args: [{ value: p["mode"] === "duration" && ms !== undefined ? seconds(ms) : w("点击", "click") }] };
      }
      case "camera": {
        const zoom = num(obj(obj(p["transform"])?.["to"])?.["zoom"]);
        return {
          group: "camera",
          name: pick(CAMERA_OP, operation, w("镜头", "Camera")),
          args: defined([zoom === undefined ? undefined : { key: w("缩放", "zoom"), value: String(zoom) }, duration(p)]),
        };
      }
      case "nvl":
        return { group: "scene", name: "NVL", args: [] };
      case "blueprint":
        return { group: "utils", name: w("蓝图", "Blueprint"), args: defined([str(p["blueprintName"]) ? { value: str(p["blueprintName"]) ?? "", ref: true } : undefined]) };
      case "page":
        return { group: "flow", name: w("打开页面", "Open page"), args: defined([str(p["surfaceName"]) ? { value: str(p["surfaceName"]) ?? "", ref: true } : undefined]) };
      case "input":
        return { group: operation === "rumble" || operation === "stopRumble" ? "scene" : "flow", name: operation === "rumble" || operation === "stopRumble" ? w("振动", "Rumble") : w("输入", "Input"), args: [] };
      case "plugin":
        return { group: "utils", name: w("插件", "Plugin"), args: defined([str(p["actionId"]) ? { value: str(p["actionId"]) ?? "" } : undefined]) };
      default:
        if (action !== undefined && action in STAGE_ACTION) {
          return {
            group: "stage",
            name: pick(STAGE_ACTION, action, action),
            args: defined([str(p["objectName"]) ? { value: str(p["objectName"]) ?? "", ref: true } : undefined, duration(p)]),
          };
        }
        return { group: "scene", name: w("特效", "Effect"), args: [] };
    }
  }
  if (row.block === "control") {
    const control = str(p["control"]);
    switch (control) {
      case "condition":
        return { group: "flow", name: w("条件", "If"), args: [] };
      case "conditionBranch": {
        const branch = str(p["branch"]);
        const name = branch === "if" ? w("如果", "If") : branch === "elseIf" ? w("否则如果", "Else if") : w("否则", "Else");
        const cond = conditionText(lookups, p["condition"]);
        return { group: "flow", name, args: cond === undefined ? [] : [{ value: cond }] };
      }
      case "label":
        return { group: "flow", name: w("标签", "Label"), args: [{ value: str(p["name"]) ?? w("未命名", "unnamed"), ref: true }] };
      case "goto":
        return { group: "flow", name: w("跳到标签", "Go to"), args: [{ value: str(p["targetLabel"]) ?? w("未命名", "unnamed"), ref: true }] };
      case "break":
        return { group: "flow", name: w("跳出", "Break"), args: [] };
      case "cut":
        return { group: "flow", name: w("截断", "Cut"), args: [] };
      case "ending":
        return { group: "flow", name: w("结局", "Ending"), args: [{ value: str(p["name"]) ?? w("未命名", "unnamed"), ref: true }] };
      case "quit":
        return { group: "scene", name: w("退出到页面", "Quit to page"), args: [] };
      case "repeat": {
        const times = num(p["times"]);
        return p["until"] !== undefined
          ? { group: "flow", name: w("直到", "Until"), args: defined([conditionText(lookups, p["until"]) === undefined ? undefined : { value: conditionText(lookups, p["until"]) ?? "" }]) }
          : { group: "flow", name: w("重复", "Repeat"), args: [{ value: `${times ?? 1} ${w("次", "times")}` }] };
      }
      default: {
        const mode = str(p["mode"]);
        if (control === "parallel" || mode === "all") return { group: "flow", name: w("并行", "Parallel"), args: [] };
        if (control === "race" || mode === "race" || mode === "any") return { group: "flow", name: w("竞速", "Race"), args: [] };
        return { group: "flow", name: w("顺序", "Sequence"), args: [] };
      }
    }
  }
  if (row.block === "jump") {
    const target = str(p["targetSceneId"]);
    return {
      group: "scene",
      name: w("跳转", "Jump"),
      args: [{ value: (target === undefined ? undefined : lookups.sceneName(target)) ?? w("未指定", "nowhere"), ref: true }],
    };
  }
  if (row.block === "declaration") {
    const scope = str(p["scope"]);
    const name = scope === "saved" ? w("存档变量", "Saved variable") : scope === "persistent" ? w("持久变量", "Persistent variable") : w("场景变量", "Scene variable");
    return {
      group: "data",
      name,
      args: defined([{ value: str(p["name"]) ?? "", ref: true }, p["defaultValue"] === undefined ? undefined : { value: `= ${literal(lookups, p["defaultValue"])}` }]),
    };
  }
  return { group: "utils", name: row.command, args: row.detail === undefined ? [] : [{ value: row.detail }] };
}
