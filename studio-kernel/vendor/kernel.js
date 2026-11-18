// Generated from NarraLeaf Studio's src/shared/authority/kernel.ts by scripts/vendor-studio.mjs. Do not edit it by hand.

// ../NarraLeaf-Studio/src/shared/types/appTag.ts
var APP_TAG_SCHEMA_VERSION = 1;
var APP_TAG_ID_RELEASE = "main";
var LEGACY_APP_TAG_ID_RELEASE = "release";
function migrateAppTagId(id) {
  return id === LEGACY_APP_TAG_ID_RELEASE ? APP_TAG_ID_RELEASE : id;
}
var APP_TAG_OVERRIDE_KEYS = ["displayName", "identifier", "version"];
var RELEASE_APP_TAG = Object.freeze({
  id: APP_TAG_ID_RELEASE,
  name: "main",
  overrides: Object.freeze({}),
  builtin: true
});
function isBuiltinAppTagId(id) {
  return id === APP_TAG_ID_RELEASE || id === LEGACY_APP_TAG_ID_RELEASE;
}
function normalizeProjectAppTag(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const record = raw;
  const id = typeof record.id === "string" ? record.id.trim() : "";
  if (!id || isBuiltinAppTagId(id)) {
    return null;
  }
  const name = typeof record.name === "string" && record.name.trim() ? record.name.trim() : id;
  const pluginConfig = normalizeAppTagPluginConfig(record.pluginConfig);
  const reachableScenes = normalizeAppTagReachableScenes(record.reachableScenes);
  const assetAxes = normalizeAppTagAssetAxes(record.assetAxes);
  return {
    id,
    name,
    overrides: normalizeAppTagOverrides(record.overrides),
    // Omitted when empty rather than written as `{}`, so adopting this feature does not rewrite
    // every tag in every project the author merely opened.
    ...hasAppTagPluginConfig(pluginConfig) ? { pluginConfig } : {},
    ...hasAppTagReachableScenes(reachableScenes) ? { reachableScenes } : {},
    ...hasAppTagAssetAxes(assetAxes) ? { assetAxes } : {},
    // Kept whenever the key is present, blank included, for the reason the list above is: on a
    // variant "" is the statement "this edition shows nothing when its story ends", and dropping
    // it would silently hand the variant the project's page instead.
    ...record.endingSurfaceId === void 0 ? {} : { endingSurfaceId: normalizeAppTagEndingSurfaceId(record.endingSurfaceId) }
  };
}
function normalizeAppTagEndingSurfaceId(raw) {
  return typeof raw === "string" ? raw.trim() : "";
}
function normalizeAppTagPluginConfig(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {};
  }
  const config = {};
  for (const [rawPluginId, rawValues] of Object.entries(raw)) {
    const pluginId = rawPluginId.trim();
    if (!pluginId || !rawValues || typeof rawValues !== "object" || Array.isArray(rawValues)) {
      continue;
    }
    const values = {};
    for (const [rawKey, rawValue] of Object.entries(rawValues)) {
      const key = rawKey.trim();
      if (!key || typeof rawValue !== "string" || !rawValue.trim()) {
        continue;
      }
      values[key] = rawValue.trim();
    }
    if (Object.keys(values).length > 0) {
      config[pluginId] = values;
    }
  }
  return config;
}
function hasAppTagPluginConfig(config) {
  return Boolean(config && Object.values(config).some((values) => Object.keys(values).length > 0));
}
function normalizeAppTagAssetAxes(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {};
  }
  const axes = {};
  for (const [rawKey, rawValue] of Object.entries(raw)) {
    const key = rawKey.trim();
    const value = typeof rawValue === "string" ? rawValue.trim() : "";
    if (key && value) {
      axes[key] = migrateAppTagId(value);
    }
  }
  return axes;
}
function hasAppTagAssetAxes(axes) {
  return Boolean(axes && Object.keys(axes).length > 0);
}
function normalizeAppTagReachableScenes(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {};
  }
  const declared = {};
  for (const [rawKey, rawScenes] of Object.entries(raw)) {
    const key = rawKey.trim();
    if (!key || !Array.isArray(rawScenes)) {
      continue;
    }
    const scenes = [];
    const seen = /* @__PURE__ */ new Set();
    for (const entry of rawScenes) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        continue;
      }
      const record = entry;
      const storyId = typeof record.storyId === "string" ? record.storyId.trim() : "";
      const sceneId = typeof record.sceneId === "string" ? record.sceneId.trim() : "";
      const pair = `${storyId}:${sceneId}`;
      if (!storyId || !sceneId || seen.has(pair)) {
        continue;
      }
      seen.add(pair);
      scenes.push({ storyId, sceneId });
    }
    declared[key] = scenes;
  }
  return declared;
}
function hasAppTagReachableScenes(declared) {
  return Boolean(declared && Object.keys(declared).length > 0);
}
function normalizeAppTagOverrides(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {};
  }
  const record = raw;
  const overrides = {};
  for (const key of APP_TAG_OVERRIDE_KEYS) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      overrides[key] = value.trim();
    }
  }
  return overrides;
}
function normalizeProjectAppTags(raw) {
  const source = Array.isArray(raw) ? raw : [];
  const byId2 = /* @__PURE__ */ new Map();
  for (const entry of source) {
    const tag = normalizeProjectAppTag(entry);
    if (tag && !byId2.has(tag.id)) {
      byId2.set(tag.id, tag);
    }
  }
  return [...byId2.values()];
}
function migrateProjectAppTagDocument(raw) {
  const record = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const meta = record.meta && typeof record.meta === "object" && !Array.isArray(record.meta) ? record.meta : void 0;
  const pluginConfig = normalizeAppTagPluginConfig(record.pluginConfig);
  const reachableScenes = normalizeAppTagReachableScenes(record.reachableScenes);
  const assetAxes = normalizeAppTagAssetAxes(record.assetAxes);
  const endingSurfaceId = normalizeAppTagEndingSurfaceId(record.endingSurfaceId);
  return {
    schemaVersion: APP_TAG_SCHEMA_VERSION,
    tags: normalizeProjectAppTags(record.tags),
    ...hasAppTagPluginConfig(pluginConfig) ? { pluginConfig } : {},
    ...hasAppTagReachableScenes(reachableScenes) ? { reachableScenes } : {},
    ...hasAppTagAssetAxes(assetAxes) ? { assetAxes } : {},
    // Omitted when blank, unlike a variant's own key and for the same reason the list above is:
    // this is the record a variant that states nothing reads, so there is nothing for a blank to
    // mean that absence does not already say.
    ...endingSurfaceId ? { endingSurfaceId } : {},
    ...meta ? { meta } : {}
  };
}
function normalizeAppTagDocument(document) {
  document.tags = normalizeProjectAppTags(document.tags);
  const pluginConfig = normalizeAppTagPluginConfig(document.pluginConfig);
  if (hasAppTagPluginConfig(pluginConfig)) {
    document.pluginConfig = pluginConfig;
  } else {
    delete document.pluginConfig;
  }
  const reachableScenes = normalizeAppTagReachableScenes(document.reachableScenes);
  if (hasAppTagReachableScenes(reachableScenes)) {
    document.reachableScenes = reachableScenes;
  } else {
    delete document.reachableScenes;
  }
  const endingSurfaceId = normalizeAppTagEndingSurfaceId(document.endingSurfaceId);
  if (endingSurfaceId) {
    document.endingSurfaceId = endingSurfaceId;
  } else {
    delete document.endingSurfaceId;
  }
}

// ../NarraLeaf-Studio/src/shared/types/assetSet.ts
var ASSET_SET_SCHEMA_VERSION = 1;
var ASSET_AXIS_RESIDENCY_ORDER = Object.freeze({
  build: 0,
  runtime: 1
});
var ASSET_AXIS_RESIDENCIES = Object.freeze(["build", "runtime"]);
var ASSET_SET_AXIS_KINDS = Object.freeze(["locale", "release"]);
function isAssetSetAxisKind(value) {
  return value === "locale" || value === "release";
}
function assetSetAxisKey(kind) {
  return kind;
}
function assetSetAxisResidency(kind) {
  return kind === "locale" ? "runtime" : "build";
}
function makeAssetSetAxis(kind, values, fallback) {
  const list = [...values];
  return {
    kind,
    key: assetSetAxisKey(kind),
    residency: assetSetAxisResidency(kind),
    values: list,
    fallback: fallback && list.includes(fallback) ? fallback : list[0] ?? ""
  };
}
function createEmptyAssetSetDocument() {
  return { version: ASSET_SET_SCHEMA_VERSION, sets: [] };
}
function formatAssetTag(category, value) {
  return `${category.trim()}:${value.trim()}`;
}
function normalizeStringList(raw) {
  if (!Array.isArray(raw)) {
    return [];
  }
  const seen = /* @__PURE__ */ new Set();
  const out = [];
  for (const entry of raw) {
    if (typeof entry !== "string") {
      continue;
    }
    const trimmed = entry.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}
function normalizeAxis(raw) {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return null;
  }
  const record = raw;
  const key = typeof record.key === "string" ? record.key.trim() : "";
  const kind = isAssetSetAxisKind(record.kind) ? record.kind : isAssetSetAxisKind(key) ? key : null;
  if (!kind) {
    return null;
  }
  const fallback = typeof record.fallback === "string" ? record.fallback.trim() : void 0;
  const migrate = (value) => kind === "release" ? migrateAppTagId(value) : value;
  return {
    ...makeAssetSetAxis(
      kind,
      normalizeStringList(record.values).map(migrate),
      fallback === void 0 ? void 0 : migrate(fallback)
    )
  };
}
function normalizeAssetSet(raw) {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return null;
  }
  const record = raw;
  const id = typeof record.id === "string" ? record.id.trim() : "";
  const type = typeof record.type === "string" ? record.type.trim() : "";
  if (!id || !type) {
    return null;
  }
  const legacy = Array.isArray(record.axes) ? record.axes : [];
  const axis = normalizeAxis(record.axis) ?? normalizeAxis(legacy[0]);
  if (!axis) {
    return null;
  }
  const groupId = typeof record.groupId === "string" ? record.groupId.trim() : "";
  return {
    id,
    name: typeof record.name === "string" ? record.name.trim() : "",
    type,
    filter: normalizeStringList(record.filter),
    axis,
    // Omitted rather than stored empty, so "at the top of the section" is one state and not two.
    ...groupId ? { groupId } : {}
  };
}
function splitLegacyAxes(raw, set) {
  if (typeof raw !== "object" || raw === null) {
    return [];
  }
  const record = raw;
  if (!Array.isArray(record.axes) || record.axes.length < 2) {
    return [];
  }
  const axes = record.axes.map(normalizeAxis).filter((axis) => axis !== null);
  const out = [];
  const walk = (parent, depth) => {
    const inner = axes[depth];
    if (!inner) {
      return;
    }
    for (const value of parent.axis.values) {
      const child = {
        id: `${parent.id}:${value}`,
        name: `${parent.name} ${value}`.trim(),
        type: parent.type,
        ...parent.groupId ? { groupId: parent.groupId } : {},
        filter: [...parent.filter, formatAssetTag(parent.axis.key, value)],
        axis: { ...inner, values: [...inner.values] }
      };
      out.push(child);
      walk(child, depth + 1);
    }
  };
  walk(set, 1);
  return out;
}
function normalizeProjectAssetSets(raw) {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return createEmptyAssetSetDocument();
  }
  const record = raw;
  const sets = [];
  const seenIds = /* @__PURE__ */ new Set();
  if (Array.isArray(record.sets)) {
    for (const entry of record.sets) {
      const set = normalizeAssetSet(entry);
      if (!set || seenIds.has(set.id)) {
        continue;
      }
      seenIds.add(set.id);
      sets.push(set);
      for (const child of splitLegacyAxes(entry, set)) {
        if (!seenIds.has(child.id)) {
          seenIds.add(child.id);
          sets.push(child);
        }
      }
    }
  }
  return { version: ASSET_SET_SCHEMA_VERSION, sets };
}
function migrateProjectAssetSetDocument(raw) {
  return normalizeProjectAssetSets(raw);
}

// ../NarraLeaf-Studio/src/shared/types/story/document.ts
var STORY_LIBRARY_INDEX_SCHEMA_VERSION = 2;
var STORY_DOCUMENT_SCHEMA_VERSION = 31;

// ../NarraLeaf-Studio/src/shared/types/story/sceneLayers.ts
var STORY_LAYER_FOLLOW_MAX = 2;
var STORY_LAYER_DISTANCE_MIN = 1 / STORY_LAYER_FOLLOW_MAX;
function clampLayerFollow(value, min = 0, max = STORY_LAYER_FOLLOW_MAX) {
  const share = typeof value === "number" && Number.isFinite(value) ? value : 1;
  return Math.round(Math.min(max, Math.max(min, share)) * 1e4) / 1e4;
}
function sceneLayerFollow(layer) {
  if (layer.kind === "displayable") {
    return 1;
  }
  return clampLayerFollow(layer.follow, 0, layer.kind === "background" ? 1 : STORY_LAYER_FOLLOW_MAX);
}
function normalizeSceneLayerStack(layers) {
  const stack = [];
  const ids = /* @__PURE__ */ new Set();
  let hasDisplayable = false;
  let hasBackground = false;
  for (const raw of layers ?? []) {
    if (!raw || typeof raw !== "object") {
      continue;
    }
    const entry = raw;
    if (entry.kind === "displayable" && !hasDisplayable) {
      hasDisplayable = true;
      stack.push({ kind: "displayable" });
    } else if (entry.kind === "background" && !hasBackground) {
      hasBackground = true;
      stack.push({ kind: "background", follow: entry.follow });
    } else if (entry.kind === "custom") {
      const id = typeof entry.id === "string" ? entry.id.trim() : "";
      if (!id || ids.has(id)) {
        continue;
      }
      ids.add(id);
      stack.push({ kind: "custom", id, name: typeof entry.name === "string" ? entry.name.trim() : "", follow: entry.follow });
    }
  }
  if (!hasDisplayable) {
    const background2 = stack.findIndex((layer) => layer.kind === "background");
    stack.splice(background2 === -1 ? stack.length : background2, 0, { kind: "displayable" });
  }
  if (!hasBackground) {
    stack.push({ kind: "background" });
  }
  const displayable = stack.findIndex((layer) => layer.kind === "displayable");
  const background = stack.findIndex((layer) => layer.kind === "background");
  if (background < displayable) {
    const [moved] = stack.splice(background, 1);
    stack.splice(displayable, 0, moved);
  }
  return withMonotonicFollow(stack);
}
function withMonotonicFollow(stack) {
  const anchor = stack.findIndex((layer) => layer.kind === "displayable");
  const shares = stack.map(sceneLayerFollow);
  for (let index = anchor - 1; index >= 0; index -= 1) {
    shares[index] = Math.max(shares[index], shares[index + 1]);
  }
  for (let index = anchor + 1; index < stack.length; index += 1) {
    shares[index] = Math.min(shares[index], shares[index - 1]);
  }
  return stack.map((layer, index) => withFollow(layer, shares[index]));
}
function withFollow(layer, follow) {
  if (layer.kind === "displayable") {
    return { kind: "displayable" };
  }
  if (layer.kind === "background") {
    return follow === 1 ? { kind: "background" } : { kind: "background", follow };
  }
  const { follow: _follow, ...rest } = layer;
  return follow === 1 ? rest : { ...rest, follow };
}
function isDefaultSceneLayerStack(stack) {
  return stack.length === 2 && stack[0].kind === "displayable" && stack[1].kind === "background" && sceneLayerFollow(stack[1]) === 1;
}
function rebindSceneLayerIds(value, rebind) {
  if (rebind.size === 0 || !value || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    let changed2 = false;
    const next2 = value.map((item) => {
      const mapped = rebindSceneLayerIds(item, rebind);
      changed2 ||= mapped !== item;
      return mapped;
    });
    return changed2 ? next2 : value;
  }
  let changed = false;
  const next = {};
  for (const [key, item] of Object.entries(value)) {
    const mapped = key === "sourceBlockId" && typeof item === "string" && rebind.has(item) ? rebind.get(item) : rebindSceneLayerIds(item, rebind);
    changed ||= mapped !== item;
    next[key] = mapped;
  }
  return changed ? next : value;
}

// ../NarraLeaf-Studio/src/shared/types/story/displayableTarget.ts
function normalizeStageObjectName(value) {
  return value?.trim() || "object";
}

// ../NarraLeaf-Studio/src/shared/types/story/order.ts
function listSceneBlocksInDocumentOrder(scene, options) {
  if (!scene) {
    return [];
  }
  const ordered = [];
  const seen = /* @__PURE__ */ new Set();
  const visit = (blockId) => {
    if (seen.has(blockId)) {
      return;
    }
    seen.add(blockId);
    const block = scene.blocks[blockId];
    if (!block || options?.skipSubtree?.(block)) {
      return;
    }
    ordered.push(block);
    for (const childId of block.childrenIds) {
      visit(childId);
    }
  };
  for (const rootId of scene.rootBlockIds) {
    visit(rootId);
  }
  return ordered;
}
function listSceneIdsInDocumentOrder(document) {
  const ordered = [];
  const seen = /* @__PURE__ */ new Set();
  const take = (sceneId) => {
    if (seen.has(sceneId) || !document.scenes[sceneId]) {
      return;
    }
    seen.add(sceneId);
    ordered.push(sceneId);
  };
  for (const chapter of document.chapters ?? []) {
    for (const sceneId of chapter.sceneIds ?? []) {
      take(sceneId);
    }
  }
  for (const sceneId of document.unassignedSceneIds ?? []) {
    take(sceneId);
  }
  for (const sceneId of Object.keys(document.scenes)) {
    take(sceneId);
  }
  return ordered;
}
function deriveUnassignedSceneIds(document) {
  const claimed = /* @__PURE__ */ new Set();
  for (const chapter of document.chapters ?? []) {
    for (const sceneId of chapter.sceneIds ?? []) {
      claimed.add(sceneId);
    }
  }
  return listSceneIdsInDocumentOrder(document).filter((sceneId) => !claimed.has(sceneId));
}

// ../NarraLeaf-Studio/src/shared/types/story/sceneRuntimeName.ts
function sceneRuntimeName(scene) {
  return scene.runtimeName || scene.name || scene.id;
}

// ../NarraLeaf-Studio/src/shared/utils/error.ts
var RendererError = class extends Error {
  /**
   * `options` is forwarded so a re-throw can keep the original as its `cause`.
   *
   * This class is the renderer's outer wrapper: a service catches whatever a document reader threw
   * and re-throws it with a message a caller can show. Without a cause that is a one-way door -
   * the sentence survives and the value does not, so a caller that wants to *act* on a particular
   * failure has to match on English text. Passing the cause through costs nothing and keeps that
   * option open; nothing is required to look at it.
   */
  constructor(message, options) {
    super(message, options);
    this.name = "RendererError";
  }
};

// ../NarraLeaf-Studio/src/shared/utils/storyId.ts
var STORY_UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function isValidStoryId(value) {
  return typeof value === "string" && STORY_UUID_V4_PATTERN.test(value);
}
function assertValidStoryId(value, label = "Story id") {
  if (!isValidStoryId(value)) {
    throw new Error(`${label} must be a UUID v4 string`);
  }
}

// ../NarraLeaf-Studio/src/shared/utils/storyTime.ts
var MS_PER_SECOND = 1e3;
function storyMsToSeconds(ms) {
  return Math.round(ms) / MS_PER_SECOND;
}
function formatStorySecondsValue(ms) {
  if (ms === void 0 || ms === null || !Number.isFinite(ms)) {
    return "";
  }
  return String(storyMsToSeconds(ms));
}

// ../NarraLeaf-Studio/src/shared/story/migrateStoryDocument.ts
var CANONICAL_STORY_COMMAND_SPELLING = {
  command: (_commandId, token) => token,
  param: (_commandId, param) => param,
  enumValue: (_commandId, _param, value) => value,
  unit: (unit) => unit
};
var STORY_DOCUMENT_MIN_SUPPORTED_VERSION = 21;
var StoryDocumentTooOldError = class extends Error {
  constructor(version, minimumVersion) {
    super(
      `Story document schema v${version} is older than this Studio version can read (v${minimumVersion} is the oldest supported)`
    );
    this.version = version;
    this.minimumVersion = minimumVersion;
    this.name = "StoryDocumentTooOldError";
  }
};
var StoryDocumentTooNewError = class extends Error {
  constructor(version, supportedVersion) {
    super(
      `Story document schema v${version} is newer than this Studio version can read (v${supportedVersion} is the newest supported)`
    );
    this.version = version;
    this.supportedVersion = supportedVersion;
    this.name = "StoryDocumentTooNewError";
  }
};
function findStoryDocumentTooNewError(error) {
  return findInCauseChain(error, (candidate) => candidate instanceof StoryDocumentTooNewError);
}
function findInCauseChain(error, matches) {
  const seen = /* @__PURE__ */ new Set();
  let current = error;
  while (current && typeof current === "object" && !seen.has(current)) {
    if (matches(current)) {
      return current;
    }
    seen.add(current);
    current = current.cause;
  }
  return null;
}
function migrateStoryDocumentToLatest(document, options = {}) {
  const version = typeof document.schemaVersion === "number" ? document.schemaVersion : 1;
  if (version > STORY_DOCUMENT_SCHEMA_VERSION) {
    throw new StoryDocumentTooNewError(version, STORY_DOCUMENT_SCHEMA_VERSION);
  }
  if (version === STORY_DOCUMENT_SCHEMA_VERSION) {
    return document;
  }
  if (version < STORY_DOCUMENT_MIN_SUPPORTED_VERSION) {
    throw new StoryDocumentTooOldError(version, STORY_DOCUMENT_MIN_SUPPORTED_VERSION);
  }
  let migrated = document;
  if (version < 22) {
    migrated = migrateStoryDocumentV21toV22(migrated);
  }
  if (version < 27) {
    migrated = migrateStoryDocumentV26toV27(migrated, options.commandSpelling ?? CANONICAL_STORY_COMMAND_SPELLING);
  }
  if (version < 30) {
    migrated = migrateStoryDocumentV29toV30(migrated);
  }
  return { ...migrated, schemaVersion: STORY_DOCUMENT_SCHEMA_VERSION };
}
function migrateStoryDocumentV21toV22(document) {
  const scenes = {};
  for (const [sceneId, scene] of Object.entries(document.scenes ?? {})) {
    const blocks = {};
    for (const [blockId, block] of Object.entries(scene.blocks ?? {})) {
      blocks[blockId] = migrateTransitionBlock(block);
    }
    scenes[sceneId] = { ...scene, blocks };
  }
  return { ...document, scenes };
}
function migrateStoryDocumentV26toV27(document, spelling) {
  const scenes = {};
  for (const [sceneId, scene] of Object.entries(document.scenes ?? {})) {
    scenes[sceneId] = migrateSceneClips(scene, spelling);
  }
  return { ...document, scenes };
}
function legacyVideoPayload(block) {
  if (!block || block.kind !== "action") {
    return null;
  }
  const payload = block.payload;
  return payload.action === "video" ? payload : null;
}
function clipKey(name) {
  return normalizeStageObjectName(name);
}
function legacyDeclares(payload) {
  if (payload.operation === "create") {
    return true;
  }
  return (payload.operation === "show" || payload.operation === "play") && Boolean(payload.assetId?.trim());
}
function migrateSceneClips(scene, spelling) {
  const ordered = listSceneBlocksInDocumentOrder(scene);
  if (!ordered.some((block) => legacyVideoPayload(block))) {
    return scene;
  }
  const disabled = /* @__PURE__ */ new Set();
  for (const block of ordered) {
    if (block.disabled || block.parentId !== null && disabled.has(block.parentId)) {
      disabled.add(block.id);
    }
  }
  const blocks = { ...scene.blocks };
  const removed = /* @__PURE__ */ new Set();
  const clips = /* @__PURE__ */ new Map();
  const firstPlay = /* @__PURE__ */ new Map();
  const pending = /* @__PURE__ */ new Map();
  for (const block of ordered) {
    const payload = legacyVideoPayload(block);
    if (!payload) {
      continue;
    }
    const live = !disabled.has(block.id);
    let key;
    if (legacyDeclares(payload)) {
      key = clipKey(payload.objectName);
    } else {
      const bound = legacyVideoPayload(payload.target?.sourceBlockId ? scene.blocks[payload.target.sourceBlockId] : void 0);
      key = clipKey(bound?.objectName ?? (payload.target?.name || payload.objectName));
    }
    const ownFile = payload.assetId?.trim();
    if (live && legacyDeclares(payload) && ownFile && !clips.has(key)) {
      clips.set(key, { name: payload.objectName?.trim() || key, assetId: ownFile, ...payload.muted !== void 0 ? { muted: payload.muted } : {} });
    }
    const clip = clips.get(key);
    if (payload.operation === "create" || payload.operation === "show") {
      if (live) {
        pending.set(key, [...pending.get(key) ?? [], block.id]);
      } else {
        blocks[block.id] = noteQuoting(block, payload, spelling);
      }
      continue;
    }
    if (payload.operation === "play") {
      const file = clip ?? (!live && ownFile ? { name: payload.objectName?.trim() || key, assetId: ownFile, muted: payload.muted } : void 0);
      if (!file) {
        blocks[block.id] = noteQuoting(block, payload, spelling);
        continue;
      }
      const { target: _target, assetId: _assetId, muted: _muted, ...rest } = payload;
      const next = {
        ...rest,
        objectName: payload.objectName?.trim() || file.name,
        assetId: file.assetId,
        ...file.muted !== void 0 ? { muted: file.muted } : {}
      };
      blocks[block.id] = { ...block, payload: next };
      if (live) {
        for (const foldedId of pending.get(key) ?? []) {
          removed.add(foldedId);
        }
        pending.delete(key);
        if (!firstPlay.has(key)) {
          firstPlay.set(key, block.id);
        }
      }
      continue;
    }
    const definingPlay = firstPlay.get(key);
    if (!definingPlay) {
      blocks[block.id] = noteQuoting(block, payload, spelling);
      continue;
    }
    const name = legacyVideoPayload(blocks[definingPlay])?.objectName ?? key;
    blocks[block.id] = {
      ...block,
      payload: {
        ...payload,
        objectName: name,
        ...payload.target && !payload.target.builtin ? { target: { ...payload.target, name: clipKey(name), label: name, sourceBlockId: definingPlay } } : {}
      }
    };
  }
  for (const ids of pending.values()) {
    for (const id of ids) {
      const payload = legacyVideoPayload(blocks[id]);
      if (payload) {
        blocks[id] = noteQuoting(blocks[id], payload, spelling);
      }
    }
  }
  if (removed.size === 0) {
    return { ...scene, blocks };
  }
  for (const id of removed) {
    delete blocks[id];
  }
  for (const [id, block] of Object.entries(blocks)) {
    if (block.childrenIds.some((childId) => removed.has(childId))) {
      blocks[id] = { ...block, childrenIds: block.childrenIds.filter((childId) => !removed.has(childId)) };
    }
  }
  return { ...scene, blocks, rootBlockIds: scene.rootBlockIds.filter((id) => !removed.has(id)) };
}
function migrateStoryDocumentV29toV30(document) {
  const scenes = {};
  for (const [sceneId, scene] of Object.entries(document.scenes ?? {})) {
    scenes[sceneId] = migrateSceneLayers(scene);
  }
  return { ...document, scenes };
}
var LEGACY_DEPTH_FOLLOW = { near: 1.4, follow: 1, mid: 0.6, far: 0.3, farthest: 0 };
function legacyDepthFollow(depth) {
  return typeof depth === "string" && Object.prototype.hasOwnProperty.call(LEGACY_DEPTH_FOLLOW, depth) ? LEGACY_DEPTH_FOLLOW[depth] : 1;
}
function legacyLayerPayload(block) {
  if (!block || block.kind !== "action") {
    return null;
  }
  const payload = block.payload;
  return payload.action === "layer" ? payload : null;
}
function legacyPlacement(block) {
  if (block.kind !== "action" || block.payload.action !== "image" && block.payload.action !== "text") {
    return null;
  }
  const layer = block.payload.layer;
  return layer && layer.kind === "custom" ? layer : null;
}
function migrateSceneLayers(scene) {
  const ordered = listSceneBlocksInDocumentOrder(scene);
  const disabled = /* @__PURE__ */ new Set();
  for (const block of ordered) {
    if (block.disabled || block.parentId !== null && disabled.has(block.parentId)) {
      disabled.add(block.id);
    }
  }
  const drafts = [];
  const byKey2 = /* @__PURE__ */ new Map();
  const byId2 = /* @__PURE__ */ new Map();
  const rebind = /* @__PURE__ */ new Map();
  const removed = /* @__PURE__ */ new Set();
  let backgroundFollow = 1;
  for (const block of ordered) {
    const payload = legacyLayerPayload(block);
    if (!payload) {
      continue;
    }
    if (payload.operation === "create") {
      removed.add(block.id);
      const key = normalizeStageObjectName(payload.objectName);
      const existing = byKey2.get(key);
      if (existing) {
        rebind.set(block.id, existing.id);
        continue;
      }
      const draft = {
        id: block.id,
        name: payload.objectName?.trim() || key,
        z: typeof payload.zIndex === "number" && Number.isFinite(payload.zIndex) ? payload.zIndex : 0,
        follow: disabled.has(block.id) ? 1 : legacyDepthFollow(payload.depth),
        order: drafts.length
      };
      drafts.push(draft);
      byKey2.set(key, draft);
      byId2.set(draft.id, draft);
    } else if (payload.operation === "setDepth") {
      removed.add(block.id);
      if (!disabled.has(block.id) && payload.target?.kind === "default" && payload.target.layer === "background") {
        backgroundFollow = legacyDepthFollow(payload.depth);
      }
    }
  }
  for (const block of ordered) {
    const placement = legacyPlacement(block);
    if (!placement) {
      continue;
    }
    const boundId = placement.sourceBlockId ? rebind.get(placement.sourceBlockId) ?? placement.sourceBlockId : void 0;
    if (boundId && byId2.has(boundId)) {
      continue;
    }
    const name = placement.name?.trim();
    if (!name || byKey2.has(normalizeStageObjectName(name))) {
      continue;
    }
    const draft = { id: `${block.id}-layer`, name, z: 0, follow: 1, order: drafts.length };
    drafts.push(draft);
    byKey2.set(normalizeStageObjectName(name), draft);
    byId2.set(draft.id, draft);
  }
  if (removed.size === 0 && drafts.length === 0) {
    return scene;
  }
  const entries = [
    { layer: { kind: "displayable" }, z: 0, rank: -1 },
    { layer: { kind: "background", follow: backgroundFollow }, z: -1, rank: -1 },
    ...drafts.map((draft) => ({
      layer: { kind: "custom", id: draft.id, name: draft.name, follow: draft.follow },
      z: draft.z,
      rank: draft.order
    }))
  ];
  entries.sort((a, b) => b.z - a.z || b.rank - a.rank);
  const stack = normalizeSceneLayerStack(entries.map((entry) => entry.layer));
  const blocks = {};
  for (const [id, block] of Object.entries(scene.blocks)) {
    if (removed.has(id)) {
      continue;
    }
    let next = rebindSceneLayerIds(block, rebind);
    const placement = legacyPlacement(next);
    const boundId = placement?.sourceBlockId ? rebind.get(placement.sourceBlockId) ?? placement.sourceBlockId : void 0;
    if (placement && !(boundId && byId2.has(boundId))) {
      const draft = placement.name?.trim() ? byKey2.get(normalizeStageObjectName(placement.name)) : void 0;
      if (draft) {
        next = { ...next, payload: { ...next.payload, layer: { kind: "custom", sourceBlockId: draft.id, name: draft.name } } };
      }
    }
    if (next.childrenIds.some((childId) => removed.has(childId))) {
      next = { ...next, childrenIds: next.childrenIds.filter((childId) => !removed.has(childId)) };
    }
    blocks[id] = next;
  }
  const { layers: _layers, ...rest } = scene;
  return {
    ...rest,
    ...isDefaultSceneLayerStack(stack) ? {} : { layers: stack },
    blocks,
    rootBlockIds: scene.rootBlockIds.filter((id) => !removed.has(id))
  };
}
function noteQuoting(block, payload, spelling) {
  const word = (value) => {
    const text2 = (value ?? "").trim();
    return /\s/.test(text2) ? `'${text2}'` : text2;
  };
  const name = word(payload.target?.label || payload.objectName || payload.target?.name);
  const verb = (commandId, token = commandId) => `/${spelling.command(commandId, token)}`;
  const key = (commandId, param) => spelling.param(commandId, param);
  const seconds = (ms) => `${formatStorySecondsValue(Math.max(0, ms ?? 0))}${spelling.unit("s")}`;
  let line;
  switch (payload.operation) {
    case "create":
      line = `${verb("play", "video")} ${key("play", "name")}=${name}${payload.muted ? ` ${key("play", "muted")}` : ""}`;
      break;
    case "seek":
      line = `${verb("seek")} ${name} ${seconds(payload.timeMs)}`;
      break;
    case "hide":
      line = typeof payload.durationMs === "number" && payload.durationMs > 0 ? `${verb("hide")} ${name} ${key("hide", "out")}=${spelling.enumValue("hide", "out", "fade")} ${key("hide", "d")}=${seconds(payload.durationMs)}` : `${verb("hide")} ${name}`;
      break;
    default:
      line = `${verb(payload.operation)} ${name}`;
      break;
  }
  return {
    id: block.id,
    kind: "note",
    parentId: block.parentId,
    childrenIds: [],
    payload: { text: { textId: `${block.id}-note`, role: "note", value: line.trim() } },
    ...block.disabled ? { disabled: true } : {}
  };
}
var HOLDING_TRANSITION_KINDS = /* @__PURE__ */ new Set(["throughColor", "exposure"]);
var DEFAULT_TRANSITION_DURATION_MS = 300;
function migrateTransitionBlock(block) {
  const key = transitionRefKey(block);
  if (!key) {
    return block;
  }
  const payload = block.payload;
  const ref = payload[key];
  if (!ref || typeof ref !== "object") {
    return block;
  }
  return { ...block, payload: { ...payload, [key]: migrateTransitionRef(ref) } };
}
function migrateTransitionRef(ref) {
  let next = ref;
  if (next.kind === "maskWipe") {
    const props2 = next.props ?? {};
    next = { ...next, kind: "softWipe", props: { ...props2, feather: 0 } };
  }
  const props = next.props;
  if (props && typeof props.hold === "number" && HOLDING_TRANSITION_KINDS.has(String(next.kind))) {
    const duration = typeof next.durationMs === "number" ? next.durationMs : DEFAULT_TRANSITION_DURATION_MS;
    const share = Math.min(100, Math.max(0, props.hold)) / 100;
    const rest = { ...props };
    delete rest.hold;
    next = {
      ...next,
      holdMs: Math.round(duration * share),
      ...Object.keys(rest).length > 0 ? { props: rest } : {}
    };
    if (Object.keys(rest).length === 0) {
      delete next.props;
    }
  }
  return next;
}
function transitionRefKey(block) {
  if (block.kind === "jump") {
    return "transition";
  }
  if (block.kind !== "action") {
    return null;
  }
  const action = block.payload.action;
  return action === "setBackground" || action === "character" || action === "image" ? "transition" : null;
}

// ../NarraLeaf-Studio/src/shared/story/normalizeStoryDocument.ts
function assertSupportedStoryDocument(document) {
  if (document.schemaVersion > STORY_DOCUMENT_SCHEMA_VERSION) {
    throw new StoryDocumentTooNewError(document.schemaVersion, STORY_DOCUMENT_SCHEMA_VERSION);
  }
  if (document.schemaVersion !== STORY_DOCUMENT_SCHEMA_VERSION) {
    throw new Error("Story document migration is not implemented");
  }
}
function normalizeStoryDocumentContent(document) {
  const migrated = migrateStoryDocumentToLatest(document);
  assertSupportedStoryDocument(migrated);
  return normalizeMigrated(migrated, void 0);
}
function normalizeMigrated(migrated, now) {
  const scenes = {};
  for (const [sceneId, scene] of Object.entries(migrated.scenes ?? {})) {
    scenes[sceneId] = normalizeScene(scene);
  }
  const chapters = (migrated.chapters ?? []).map((chapter) => ({
    ...chapter,
    sceneIds: (chapter.sceneIds ?? []).filter((sceneId) => scenes[sceneId])
  }));
  const entrySceneId = migrated.entrySceneId && scenes[migrated.entrySceneId] ? migrated.entrySceneId : firstSceneId(chapters);
  const normalized = { ...migrated, chapters, scenes };
  if (entrySceneId !== void 0) {
    normalized.entrySceneId = entrySceneId;
  } else {
    delete normalized.entrySceneId;
  }
  const unassignedSceneIds = deriveUnassignedSceneIds(normalized);
  if (unassignedSceneIds.length > 0) {
    normalized.unassignedSceneIds = unassignedSceneIds;
  } else {
    delete normalized.unassignedSceneIds;
  }
  const meta = normalizeMeta(migrated.meta, now);
  if (meta !== void 0) {
    normalized.meta = meta;
  } else {
    delete normalized.meta;
  }
  return normalized;
}
function normalizeMeta(meta, now) {
  const updatedAt = meta?.updatedAt ?? now;
  if (meta === void 0 && updatedAt === void 0) {
    return void 0;
  }
  return { ...meta, ...updatedAt !== void 0 ? { updatedAt } : {} };
}
function normalizeScene(scene) {
  const source = scene.blocks ?? {};
  const blocks = {};
  for (const [id, block] of Object.entries(source)) {
    blocks[id] = {
      ...block,
      id,
      childrenIds: (block.childrenIds ?? []).filter((childId) => source[childId])
    };
  }
  const rootBlockIds = (scene.rootBlockIds ?? []).filter((blockId) => blocks[blockId]);
  for (const block of Object.values(blocks)) {
    if (block.parentId && !blocks[block.parentId]) {
      block.parentId = null;
      if (!rootBlockIds.includes(block.id)) {
        rootBlockIds.push(block.id);
      }
    }
    if (block.kind === "jump") {
      block.childrenIds = [];
    }
  }
  const normalized = {
    ...scene,
    description: typeof scene.description === "string" ? scene.description : "",
    rootBlockIds,
    blocks
  };
  const bgm = normalizeSceneBgm(scene.bgm);
  if (bgm !== void 0) {
    normalized.bgm = bgm;
  } else {
    delete normalized.bgm;
  }
  const defaultBackgroundAssetId = normalizeOptionalString(scene.defaultBackgroundAssetId);
  if (defaultBackgroundAssetId !== void 0) {
    normalized.defaultBackgroundAssetId = defaultBackgroundAssetId;
  } else {
    delete normalized.defaultBackgroundAssetId;
  }
  const layers = normalizeSceneLayerStack(scene.layers);
  if (isDefaultSceneLayerStack(layers)) {
    delete normalized.layers;
  } else {
    normalized.layers = layers;
  }
  return normalized;
}
function normalizeSceneBgm(value) {
  const assetId = normalizeOptionalString(value?.assetId);
  if (!value || !assetId) {
    return void 0;
  }
  const volume = typeof value.volume === "number" && Number.isFinite(value.volume) ? Math.min(1, Math.max(0, value.volume)) : void 0;
  const fadeMs = normalizeOptionalNonNegativeNumber(value.fadeMs);
  const audioTrackId = normalizeOptionalString(value.audioTrackId);
  return {
    assetId,
    // Kept as authored even when no track of that id exists: a reference to a deleted track
    // resolves to its bus's built-in at compile time, and dropping the id here would silently
    // discard the author's choice the moment they deleted a track they meant to re-create.
    ...audioTrackId !== void 0 ? { audioTrackId } : {},
    ...volume !== void 0 ? { volume } : {},
    ...typeof value.loop === "boolean" ? { loop: value.loop } : {},
    ...fadeMs !== void 0 ? { fadeMs } : {}
  };
}
function firstSceneId(chapters) {
  for (const chapter of chapters) {
    if (chapter.sceneIds[0]) {
      return chapter.sceneIds[0];
    }
  }
  return void 0;
}
function normalizeOptionalString(value) {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed || void 0;
}
function normalizeOptionalNonNegativeNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : void 0;
}

// ../NarraLeaf-Studio/src/shared/story/storyModel.ts
function createEmptyStoryLibraryIndex(now) {
  return {
    schemaVersion: STORY_LIBRARY_INDEX_SCHEMA_VERSION,
    stories: [],
    meta: {
      createdAt: now,
      updatedAt: now
    }
  };
}
function storyDocumentRelativePath(storyId) {
  assertValidStoryId(storyId);
  return `editor/story/stories/${storyId}/storydoc.json`;
}
function insertBlockInScene(scene, block, target) {
  if (block.kind === "jump" && block.childrenIds.length > 0) {
    throw new Error("Jump blocks cannot have children");
  }
  if (target.parentId && !canAcceptChildren(scene.blocks[target.parentId])) {
    throw new Error("Target parent cannot accept child blocks");
  }
  if (target.parentId && !scene.blocks[target.parentId]) {
    throw new Error("Target parent block not found");
  }
  if (scene.blocks[block.id]) {
    throw new Error(`Block already exists: ${block.id}`);
  }
  block.parentId = target.parentId;
  block.childrenIds = [];
  scene.blocks[block.id] = block;
  const siblings = target.parentId ? scene.blocks[target.parentId].childrenIds : scene.rootBlockIds;
  insertId(siblings, block.id, target.beforeBlockId ?? null);
}
function updateBlockPayload(scene, blockId, nextPayload) {
  const block = scene.blocks[blockId];
  if (!block) {
    throw new Error(`Block not found: ${blockId}`);
  }
  block.payload = preserveTextIds(block.payload, nextPayload);
}
function deleteBlockFromScene(scene, blockId) {
  const block = scene.blocks[blockId];
  if (!block) {
    return;
  }
  const ids = collectBlockSubtree(scene, blockId);
  const siblings = block.parentId ? scene.blocks[block.parentId]?.childrenIds : scene.rootBlockIds;
  if (siblings) {
    removeId(siblings, blockId);
  }
  for (const id of ids) {
    delete scene.blocks[id];
  }
}
function assertBlockMoveAllowed(scene, blockId, target) {
  if (!scene.blocks[blockId]) {
    throw new Error(`Block not found: ${blockId}`);
  }
  if (target.parentId && !canAcceptChildren(scene.blocks[target.parentId])) {
    throw new Error("Target parent cannot accept child blocks");
  }
  if (target.parentId && collectBlockSubtree(scene, blockId).includes(target.parentId)) {
    throw new Error("Cannot move a block into its own subtree");
  }
}
function moveBlockInScene(scene, blockId, target) {
  assertBlockMoveAllowed(scene, blockId, target);
  const block = scene.blocks[blockId];
  const oldSiblings = block.parentId ? scene.blocks[block.parentId]?.childrenIds : scene.rootBlockIds;
  if (oldSiblings) {
    removeId(oldSiblings, blockId);
  }
  block.parentId = target.parentId;
  const nextSiblings = target.parentId ? scene.blocks[target.parentId].childrenIds : scene.rootBlockIds;
  insertId(nextSiblings, blockId, target.beforeBlockId ?? null);
}
function moveBlocksInScene(scene, moves) {
  for (const move of moves) {
    for (const blockId of move.blockIds) {
      assertBlockMoveAllowed(scene, blockId, move.target);
    }
  }
  for (const move of moves) {
    for (const blockId of move.blockIds) {
      moveBlockInScene(scene, blockId, move.target);
    }
  }
}
function canAcceptChildren(block) {
  if (!block) {
    return false;
  }
  if (block.kind === "control") {
    const { control } = block.payload;
    return control !== "label" && control !== "goto" && control !== "break" && control !== "cut" && control !== "ending" && control !== "quit";
  }
  if (block.kind === "action") {
    return block.payload.action === "nvl";
  }
  if (block.kind === "nodeAction") {
    return block.payload.action === "choice" || block.payload.action === "choiceOption";
  }
  return false;
}
function insertId(ids, id, beforeId) {
  removeId(ids, id);
  if (!beforeId) {
    ids.push(id);
    return;
  }
  const index = ids.indexOf(beforeId);
  if (index === -1) {
    ids.push(id);
    return;
  }
  ids.splice(index, 0, id);
}
function removeId(ids, id) {
  const index = ids.indexOf(id);
  if (index !== -1) {
    ids.splice(index, 1);
  }
}
function collectBlockSubtree(scene, blockId) {
  const ids = [];
  const visit = (id) => {
    if (ids.includes(id)) {
      return;
    }
    ids.push(id);
    scene.blocks[id]?.childrenIds.forEach(visit);
  };
  visit(blockId);
  return ids;
}
function preserveTextIds(previous, next) {
  if (isNodeTextPayload(previous) && isNodeTextPayload(next) && previous.action === next.action) {
    if ("text" in previous && "text" in next && isStoryTextSegment(previous.text) && isStoryTextSegment(next.text)) {
      return {
        ...next,
        text: {
          ...next.text,
          textId: previous.text.textId
        }
      };
    }
    if ("prompt" in previous && "prompt" in next && isStoryTextSegment(previous.prompt) && isStoryTextSegment(next.prompt)) {
      return {
        ...next,
        prompt: {
          ...next.prompt,
          textId: previous.prompt.textId
        }
      };
    }
  }
  if ("text" in previous && "text" in next && isStoryTextSegment(previous.text) && isStoryTextSegment(next.text)) {
    return {
      ...next,
      text: {
        ...next.text,
        textId: previous.text.textId
      }
    };
  }
  return next;
}
function isNodeTextPayload(payload) {
  return "action" in payload;
}
function isStoryTextSegment(value) {
  return Boolean(value && typeof value === "object" && "textId" in value && "value" in value);
}
function bindRowsToCharacter(document, rows, characterId) {
  const edits = [];
  if (!characterId.trim()) {
    return edits;
  }
  for (const row of rows) {
    const block = document.scenes[row.sceneId]?.blocks[row.blockId];
    if (!block || block.kind !== "nodeAction" || block.payload.action !== "dialogue") {
      continue;
    }
    const { speakerName: _dropped, ...rest } = block.payload;
    edits.push({ ...row, payload: { ...rest, characterId } });
  }
  return edits;
}
function collectRowsSpokenBy(document, characterId) {
  const target = characterId.trim();
  const rows = [];
  if (!target) {
    return rows;
  }
  for (const scene of Object.values(document.scenes)) {
    for (const block of Object.values(scene.blocks)) {
      if (block.kind !== "nodeAction" || block.payload.action !== "dialogue") {
        continue;
      }
      if (block.payload.characterId?.trim() !== target) {
        continue;
      }
      rows.push({ sceneId: scene.id, blockId: block.id });
    }
  }
  return rows;
}
function setRowsSpeakerName(document, rows, speakerName) {
  const name = speakerName.trim();
  const edits = [];
  if (!name) {
    return edits;
  }
  for (const row of rows) {
    const block = document.scenes[row.sceneId]?.blocks[row.blockId];
    if (!block || block.kind !== "nodeAction" || block.payload.action !== "dialogue") {
      continue;
    }
    const { characterId: _dropped, ...rest } = block.payload;
    edits.push({ ...row, payload: { ...rest, speakerName: name } });
  }
  return edits;
}

// ../NarraLeaf-Studio/src/shared/story/applyStoryOp.ts
function applyStoryOpToDocument(document, op, context) {
  const { now } = context;
  switch (op.op) {
    case "insert-block":
      insertBlockInScene(sceneOrThrow(document, op.sceneId), op.block, op.target);
      return CHANGED;
    case "insert-blocks": {
      const scene = sceneOrThrow(document, op.sceneId);
      for (const insert of op.inserts) {
        insertBlockInScene(scene, insert.block, insert.target);
      }
      return CHANGED;
    }
    case "update-block":
      updateBlockPayload(sceneOrThrow(document, op.sceneId), op.blockId, op.payload);
      return CHANGED;
    case "update-blocks":
      for (const edit of op.edits) {
        updateBlockPayload(sceneOrThrow(document, edit.sceneId), edit.blockId, edit.payload);
      }
      return CHANGED;
    case "delete-block":
      deleteBlockFromScene(sceneOrThrow(document, op.sceneId), op.blockId);
      return CHANGED;
    case "delete-blocks": {
      const scene = sceneOrThrow(document, op.sceneId);
      for (const blockId of op.blockIds) {
        deleteBlockFromScene(scene, blockId);
      }
      return CHANGED;
    }
    case "move-block":
      moveBlockInScene(sceneOrThrow(document, op.sceneId), op.blockId, op.target);
      return CHANGED;
    case "move-blocks":
      moveBlocksInScene(
        sceneOrThrow(document, op.sceneId),
        op.moves.map((move) => ({ blockIds: [...move.blockIds], target: move.target }))
      );
      return CHANGED;
    case "set-block-disabled": {
      const block = sceneOrThrow(document, op.sceneId).blocks[op.blockId];
      if (!block) {
        return UNCHANGED;
      }
      if (op.disabled) {
        block.disabled = true;
      } else {
        delete block.disabled;
      }
      return CHANGED;
    }
    case "rename-scene": {
      const scene = document.scenes[op.sceneId];
      if (!scene) {
        return UNCHANGED;
      }
      scene.runtimeName = sceneRuntimeName(scene);
      scene.name = op.name;
      scene.meta = { ...scene.meta, updatedAt: now };
      return CHANGED;
    }
    case "set-entry-scene":
      if (op.sceneId && !document.scenes[op.sceneId]) {
        throw new RendererError(`Scene not found: ${op.sceneId}`);
      }
      document.entrySceneId = op.sceneId ?? void 0;
      return CHANGED;
    case "rename-story":
      document.name = op.name;
      return CHANGED;
    case "reorder-chapters": {
      const byId2 = new Map(document.chapters.map((chapter) => [chapter.id, chapter]));
      const ordered = [];
      for (const id of op.chapterIds) {
        const chapter = byId2.get(id);
        if (chapter) {
          ordered.push(chapter);
          byId2.delete(id);
        }
      }
      document.chapters = [...ordered, ...byId2.values()];
      return CHANGED;
    }
    case "create-scene": {
      const scene = op.scene;
      let target = op.chapterId === null ? void 0 : document.chapters.find((item) => item.id === op.chapterId);
      if (!target && op.chapter) {
        target = op.chapter;
        document.chapters.push(target);
      }
      document.scenes[scene.id] = scene;
      if (target) {
        const at = op.beforeSceneId === null ? -1 : target.sceneIds.indexOf(op.beforeSceneId);
        if (at === -1) {
          target.sceneIds.push(scene.id);
        } else {
          target.sceneIds.splice(at, 0, scene.id);
        }
      } else {
        document.unassignedSceneIds = [...document.unassignedSceneIds ?? [], scene.id];
      }
      if (op.entry === true || !document.entrySceneId) {
        document.entrySceneId = scene.id;
      }
      return CHANGED;
    }
    case "delete-scene": {
      if (!document.scenes[op.sceneId]) {
        return UNCHANGED;
      }
      delete document.scenes[op.sceneId];
      for (const chapter of document.chapters) {
        chapter.sceneIds = chapter.sceneIds.filter((id) => id !== op.sceneId);
      }
      if (document.unassignedSceneIds) {
        document.unassignedSceneIds = document.unassignedSceneIds.filter((id) => id !== op.sceneId);
      }
      if (document.entrySceneId === op.sceneId) {
        document.entrySceneId = firstSceneId2(document);
      }
      return CHANGED;
    }
    case "update-scene": {
      const scene = document.scenes[op.sceneId];
      if (!scene) {
        return UNCHANGED;
      }
      const { fields } = op;
      scene.name = fields.name;
      scene.runtimeName = fields.runtimeName;
      if (fields.description === void 0) {
        delete scene.description;
      } else {
        scene.description = fields.description;
      }
      if (fields.defaultBackgroundAssetId === void 0) {
        delete scene.defaultBackgroundAssetId;
      } else {
        scene.defaultBackgroundAssetId = fields.defaultBackgroundAssetId;
      }
      if (fields.bgm === void 0) {
        delete scene.bgm;
      } else {
        scene.bgm = fields.bgm;
      }
      scene.meta = { ...scene.meta, updatedAt: now };
      return CHANGED;
    }
    case "move-scene": {
      const targetChapter = op.chapterId === null ? void 0 : document.chapters.find((chapter) => chapter.id === op.chapterId);
      if (op.chapterId !== null && !targetChapter || !document.scenes[op.sceneId]) {
        return UNCHANGED;
      }
      for (const chapter of document.chapters) {
        chapter.sceneIds = chapter.sceneIds.filter((id) => id !== op.sceneId);
      }
      if (document.unassignedSceneIds) {
        document.unassignedSceneIds = document.unassignedSceneIds.filter((id) => id !== op.sceneId);
      }
      if (!targetChapter) {
        document.unassignedSceneIds = [...document.unassignedSceneIds ?? [], op.sceneId];
        return CHANGED;
      }
      const at = op.beforeSceneId ? targetChapter.sceneIds.indexOf(op.beforeSceneId) : -1;
      if (at === -1) {
        targetChapter.sceneIds.push(op.sceneId);
      } else {
        targetChapter.sceneIds.splice(at, 0, op.sceneId);
      }
      return CHANGED;
    }
    case "set-scene-snapshots": {
      const scene = document.scenes[op.sceneId];
      if (!scene) {
        return UNCHANGED;
      }
      scene.sceneSnapshots = op.snapshots.map((snapshot) => ({ ...snapshot, values: { ...snapshot.values } }));
      return CHANGED;
    }
    case "set-scene-layers": {
      const scene = document.scenes[op.sceneId];
      if (!scene) {
        return UNCHANGED;
      }
      const next = normalizeSceneLayerStack(op.layers);
      if (isDefaultSceneLayerStack(next)) {
        delete scene.layers;
      } else {
        scene.layers = next;
      }
      return CHANGED;
    }
    case "create-chapter": {
      if (!document.chapters.some((item) => item.id === op.chapter.id)) {
        const at = op.beforeChapterId === null ? -1 : document.chapters.findIndex((item) => item.id === op.beforeChapterId);
        if (at === -1) {
          document.chapters.push(op.chapter);
        } else {
          document.chapters.splice(at, 0, op.chapter);
        }
      }
      for (const scene of op.scenes ?? []) {
        document.scenes[scene.id] = scene;
      }
      if (op.entry !== void 0 && document.scenes[op.entry]) {
        document.entrySceneId = op.entry;
      }
      return CHANGED;
    }
    case "rename-chapter": {
      const chapter = document.chapters.find((item) => item.id === op.chapterId);
      if (!chapter) {
        return UNCHANGED;
      }
      chapter.name = op.name;
      chapter.meta = { ...chapter.meta, updatedAt: now };
      return CHANGED;
    }
    case "delete-chapter": {
      const index = document.chapters.findIndex((chapter2) => chapter2.id === op.chapterId);
      if (index === -1) {
        return UNCHANGED;
      }
      const [chapter] = document.chapters.splice(index, 1);
      for (const sceneId of chapter.sceneIds) {
        delete document.scenes[sceneId];
      }
      if (document.entrySceneId && !document.scenes[document.entrySceneId]) {
        document.entrySceneId = firstSceneId2(document);
      }
      return CHANGED;
    }
    default: {
      const unapplied = op;
      throw new Error(`No applier for story operation: ${JSON.stringify(unapplied)}`);
    }
  }
}
var CHANGED = Object.freeze({ changed: true });
var UNCHANGED = Object.freeze({ changed: false });
function storyOpSceneReach(op) {
  switch (op.op) {
    case "insert-block":
    case "insert-blocks":
    case "update-block":
    case "delete-block":
    case "delete-blocks":
    case "move-block":
    case "move-blocks":
    case "set-block-disabled":
      return [op.sceneId];
    case "update-blocks":
      return op.edits.map((edit) => edit.sceneId);
    default:
      return void 0;
  }
}
function firstSceneId2(document) {
  for (const chapter of document.chapters) {
    if (chapter.sceneIds[0]) {
      return chapter.sceneIds[0];
    }
  }
  return void 0;
}
function sceneOrThrow(document, sceneId) {
  const scene = document.scenes[sceneId];
  if (!scene) {
    throw new RendererError(`Scene not found: ${sceneId}`);
  }
  return scene;
}

// ../NarraLeaf-Studio/src/shared/documents/canonicalJson.ts
var CanonicalJsonError = class extends Error {
  /** Where the offending value sits, e.g. `stories[2].updatedAt`. */
  jsonPath;
  constructor(jsonPath, message) {
    super(`${message} (at ${jsonPath})`);
    this.name = "CanonicalJsonError";
    this.jsonPath = jsonPath;
  }
};
var INDENT = "  ";
var IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
function encodeCanonicalJson(value) {
  const out = [];
  writeValue(value, "", [], out, /* @__PURE__ */ new Set());
  out.push("\n");
  return out.join("");
}
function formatJsonPath(segments) {
  if (segments.length === 0) {
    return "(root)";
  }
  let out = "";
  for (const segment of segments) {
    if (typeof segment === "number") {
      out += `[${segment}]`;
    } else if (IDENTIFIER.test(segment)) {
      out += out.length === 0 ? segment : `.${segment}`;
    } else {
      out += `[${JSON.stringify(segment)}]`;
    }
  }
  return out;
}
function fail(path, message) {
  throw new CanonicalJsonError(formatJsonPath(path), message);
}
function writeValue(value, indent, path, out, ancestors) {
  switch (typeof value) {
    case "string":
      out.push(JSON.stringify(value));
      return;
    case "number":
      writeNumber(value, path, out);
      return;
    case "boolean":
      out.push(value ? "true" : "false");
      return;
    case "undefined":
      fail(path, "undefined has no JSON representation; JSON.stringify would drop this property from its object, or write null for it inside an array");
      break;
    case "function":
      fail(path, "a function has no JSON representation; JSON.stringify would drop this property without a word");
      break;
    case "symbol":
      fail(path, "a symbol has no JSON representation; JSON.stringify would drop this property without a word");
      break;
    case "bigint":
      fail(path, "a bigint has no JSON representation; JSON.stringify throws on it. Store it as a string, or as a number if it fits");
      break;
  }
  if (value === null) {
    out.push("null");
    return;
  }
  writeObject(value, indent, path, out, ancestors);
}
function writeNumber(value, path, out) {
  if (!Number.isFinite(value)) {
    fail(path, `${String(value)} has no JSON representation; JSON.stringify would write null, and the value would read back as null on the next open`);
  }
  out.push(Object.is(value, -0) ? "-0" : String(value));
}
function writeObject(value, indent, path, out, ancestors) {
  if (ancestors.has(value)) {
    fail(path, "this value is one of its own ancestors; a cycle has no JSON form. (A value merely referenced twice is fine - only a loop is rejected)");
  }
  const inner = indent + INDENT;
  if (Array.isArray(value)) {
    if (value.length === 0) {
      out.push("[]");
      return;
    }
    ancestors.add(value);
    out.push("[\n");
    for (let index = 0; index < value.length; index += 1) {
      if (index > 0) {
        out.push(",\n");
      }
      out.push(inner);
      path.push(index);
      writeValue(value[index], inner, path, out, ancestors);
      path.pop();
    }
    out.push("\n", indent, "]");
    ancestors.delete(value);
    return;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    if (value instanceof Date) {
      fail(path, "Date is not accepted: it serialises to a string and parses back as a string, so the document stops round-tripping and the asymmetry only shows up as a type error somewhere far away. Store the ISO string");
    }
    fail(path, `${constructorNameOf(value)} is not plain JSON data; JSON.stringify would write {} for a Map or a Set, and an unrelated shape for most other classes. Convert it before saving`);
  }
  const symbolKeys = Object.getOwnPropertySymbols(value).filter((symbol) => Object.prototype.propertyIsEnumerable.call(value, symbol));
  if (symbolKeys.length > 0) {
    fail(path, `symbol-keyed properties (${symbolKeys.map(String).join(", ")}) cannot be written; JSON.stringify would drop them without a word`);
  }
  const keys = Object.keys(value).sort();
  if (keys.length === 0) {
    out.push("{}");
    return;
  }
  ancestors.add(value);
  out.push("{\n");
  for (let index = 0; index < keys.length; index += 1) {
    if (index > 0) {
      out.push(",\n");
    }
    const key = keys[index];
    out.push(inner, JSON.stringify(key), ": ");
    path.push(key);
    writeValue(value[key], inner, path, out, ancestors);
    path.pop();
  }
  out.push("\n", indent, "}");
  ancestors.delete(value);
}
function constructorNameOf(value) {
  try {
    const name = value.constructor?.name;
    return typeof name === "string" && name.length > 0 ? name : "This object";
  } catch {
    return "This object";
  }
}

// ../NarraLeaf-Studio/src/shared/live/uiGraphParts.ts
function applyUIGraphParts(document, parts) {
  const blueprintDocument = document.blueprintDocument;
  if (parts.blueprints) {
    for (const [blueprintId, shell] of Object.entries(parts.blueprints)) {
      if (shell === null) {
        delete blueprintDocument.blueprints[blueprintId];
        continue;
      }
      const previous = blueprintDocument.blueprints[blueprintId];
      blueprintDocument.blueprints[blueprintId] = mergeShell(previous, shell);
    }
  }
  if (parts.graphs) {
    for (const [blueprintId, delta] of Object.entries(parts.graphs)) {
      const blueprint = blueprintDocument.blueprints[blueprintId];
      if (!blueprint) {
        continue;
      }
      applySlots(blueprint.graphs.events, delta.events);
      applySlots(blueprint.graphs.functions, delta.functions);
    }
  }
  if (parts.owners) {
    for (const [ownerKey, record] of Object.entries(parts.owners)) {
      if (record === null) {
        delete blueprintDocument.ownerRecords[ownerKey];
      } else {
        blueprintDocument.ownerRecords[ownerKey] = record;
      }
    }
  }
}
function applySlots(target, delta) {
  if (!delta) {
    return;
  }
  const slots = target;
  for (const [graphId, slotDelta] of Object.entries(delta)) {
    if (slotDelta === null) {
      delete slots[graphId];
      continue;
    }
    const existing = slots[graphId];
    const slot = existing ? { ...existing, ...slotDelta.slot ?? {} } : { ...slotDelta.slot ?? { id: graphId } };
    const ir = { ...existing?.graph ?? {} };
    if (slotDelta.nodes) {
      const nodes = { ...ir.nodes ?? {} };
      for (const [nodeId, node] of Object.entries(slotDelta.nodes)) {
        if (node === null) {
          delete nodes[nodeId];
        } else {
          nodes[nodeId] = node;
        }
      }
      ir.nodes = nodes;
    }
    if (slotDelta.edges) {
      ir.edges = [...slotDelta.edges];
    }
    if (slotDelta.variables) {
      ir.variables = slotDelta.variables;
    }
    if (slotDelta.irMeta) {
      ir.meta = slotDelta.irMeta;
    }
    slot.graph = ir;
    slots[graphId] = slot;
  }
}
function mergeShell(previous, shell) {
  return {
    ...shell,
    graphs: {
      ...shell.graphs,
      events: previous?.graphs?.events ?? {},
      functions: previous?.graphs?.functions ?? {}
    }
  };
}
function uiGraphPartsNodes(parts) {
  const refs = [];
  for (const [blueprintId, delta] of Object.entries(parts.graphs ?? {})) {
    for (const slots of [delta.events, delta.functions]) {
      for (const [graphId, slotDelta] of Object.entries(slots ?? {})) {
        for (const nodeId of Object.keys(slotDelta?.nodes ?? {})) {
          refs.push({ blueprintId, graphId, nodeId });
        }
      }
    }
  }
  return refs;
}

// ../NarraLeaf-Studio/src/shared/live/uiParts.ts
function applyUIParts(document, parts) {
  if (parts.elements) {
    writeRecordMap(document.elements, parts.elements);
  }
  if (parts.components) {
    const existing = indexById(document.components);
    const shells = parts.components;
    const order = parts.componentOrder ?? Object.keys(shells);
    const next = [];
    for (const componentId of order) {
      const shell = Object.prototype.hasOwnProperty.call(shells, componentId) ? shells[componentId] : void 0;
      if (shell === null) {
        continue;
      }
      const previous = existing[componentId];
      if (shell === void 0) {
        if (previous) {
          next.push(previous);
        }
        continue;
      }
      next.push({ ...shell, elements: previous?.elements ?? {} });
    }
    document.components = next;
  }
  if (parts.componentElements) {
    for (const [componentId, delta] of Object.entries(parts.componentElements)) {
      const component = (document.components ?? []).find((entry) => entry.id === componentId);
      if (!component) {
        continue;
      }
      component.elements = component.elements ?? {};
      writeRecordMap(component.elements, delta);
    }
  }
  if (parts.surfaces) {
    const existing = indexById(document.surfaces);
    const records = parts.surfaces;
    const order = parts.surfaceOrder ?? Object.keys(records);
    const next = [];
    for (const surfaceId of order) {
      const record = Object.prototype.hasOwnProperty.call(records, surfaceId) ? records[surfaceId] : void 0;
      if (record === null) {
        continue;
      }
      const resolved = record ?? existing[surfaceId];
      if (resolved) {
        next.push(resolved);
      }
    }
    document.surfaces = next;
  }
  if (parts.structs) {
    document.structs = document.structs ?? {};
    writeRecordMap(document.structs, parts.structs);
  }
  if (parts.actions) {
    document.actions = document.actions ?? {};
    writeRecordMap(document.actions, parts.actions);
  }
  if (parts.name !== void 0) {
    document.name = parts.name;
  }
  if (parts.entrySurfaceId !== void 0) {
    if (parts.entrySurfaceId === null) {
      delete document.entrySurfaceId;
    } else {
      document.entrySurfaceId = parts.entrySurfaceId;
    }
  }
}
function uiPartsElements(parts) {
  const refs = [];
  for (const elementId of Object.keys(parts.elements ?? {})) {
    refs.push({ componentId: null, elementId });
  }
  for (const [componentId, delta] of Object.entries(parts.componentElements ?? {})) {
    for (const elementId of Object.keys(delta)) {
      refs.push({ componentId, elementId });
    }
  }
  return refs;
}
function writeRecordMap(target, delta) {
  for (const [id, record] of Object.entries(delta)) {
    if (record === null) {
      delete target[id];
    } else {
      target[id] = record;
    }
  }
}
function indexById(list) {
  const index = {};
  for (const entry of list ?? []) {
    index[entry.id] = entry;
  }
  return index;
}

// ../NarraLeaf-Studio/src/shared/live/ops.ts
function opBlockIds(op) {
  switch (op.op) {
    case "insert-block":
      return [op.block.id];
    case "update-block":
    case "delete-block":
    case "move-block":
    case "set-block-disabled":
      return [op.blockId];
    case "insert-blocks":
      return op.inserts.map((insert) => insert.block.id);
    case "update-blocks":
      return op.edits.map((edit) => edit.blockId);
    case "delete-blocks":
      return [...op.blockIds];
    case "move-blocks":
      return op.moves.flatMap((move) => [...move.blockIds]);
    case "rename-scene":
    case "set-entry-scene":
    case "rename-story":
    case "reorder-chapters":
    // Empty with the rest of the structural verbs - see {@link opBlockId}. A scene deletion does
    // remove rows, and none of them is named here: the rows are not what the gesture is about,
    // and a claim check over them would refuse a scene because somebody left a caret in it.
    case "create-scene":
    case "delete-scene":
    case "update-scene":
    case "move-scene":
    case "set-scene-snapshots":
    case "set-scene-layers":
    case "create-chapter":
    case "rename-chapter":
    case "delete-chapter":
      return [];
  }
}
function storyRowClaimKey(blockId) {
  return `row:${blockId}`;
}
function characterClaimKey(characterId) {
  return `character:${characterId}`;
}
function translationClaimKey(locale, unitId) {
  return `translation:${locale}:${unitId}`;
}
function assetClaimKey(assetId) {
  return `asset:${assetId}`;
}
function variableClaimKey(variableId) {
  return `variable:${variableId}`;
}
function localizationKeyClaimKey(name) {
  return `named-key:${name}`;
}
function uiElementClaimKey(componentId, elementId) {
  return `${UI_ELEMENT_CLAIM_PREFIX}${componentId ?? ""}:${elementId}`;
}
var UI_ELEMENT_CLAIM_PREFIX = "ui-element:";
function uiNodeClaimKey(blueprintId, graphId, nodeId) {
  return `${UI_NODE_CLAIM_PREFIX}${blueprintId}:${graphId}:${nodeId}`;
}
var UI_NODE_CLAIM_PREFIX = "ui-node:";
function appTagClaimKey(tagId) {
  return `app-tag:${tagId}`;
}
var APP_TAG_DEFAULTS_CLAIM_ID = APP_TAG_ID_RELEASE;
function dlcClaimKey(dlcId) {
  return `dlc:${dlcId}`;
}
function brandColorClaimKey(colorId) {
  return `brand-color:${colorId}`;
}
function opClaimKeys(op) {
  switch (op.op) {
    case "insert-block":
    case "update-block":
    case "delete-block":
    case "move-block":
    case "set-block-disabled":
    case "insert-blocks":
    case "update-blocks":
    case "delete-blocks":
    case "move-blocks":
    case "rename-scene":
    case "set-entry-scene":
    case "rename-story":
    case "reorder-chapters":
    case "create-scene":
    case "delete-scene":
    case "update-scene":
    case "move-scene":
    case "set-scene-snapshots":
    case "set-scene-layers":
    case "create-chapter":
    case "rename-chapter":
    case "delete-chapter":
      return opBlockIds(op).map(storyRowClaimKey);
    case "update-character":
    case "delete-character":
      return [characterClaimKey(op.characterId)];
    case "create-character":
      return [characterClaimKey(op.character.profile.id)];
    case "set-character-group":
    case "delete-character-group":
      return [];
    case "set-translation":
      return [translationClaimKey(op.locale, op.unitId)];
    case "set-translations":
      return op.units.map((entry) => translationClaimKey(op.locale, entry.unitId));
    case "set-take":
    case "set-takes":
      return [];
    case "update-asset":
    case "replace-asset-content":
      return [assetClaimKey(op.assetId)];
    case "delete-assets":
      return op.assetIds.map(assetClaimKey);
    case "move-assets":
      return [];
    case "create-assets":
    case "set-asset-folder":
    case "delete-asset-folder":
    case "restore-asset-folder":
      return [];
    case "update-app-tag":
    case "delete-app-tag":
      return [appTagClaimKey(op.tagId)];
    case "set-app-tag-defaults":
      return [appTagClaimKey(APP_TAG_DEFAULTS_CLAIM_ID)];
    case "update-dlc":
    case "delete-dlc":
      return [dlcClaimKey(op.dlcId)];
    case "update-brand-color":
    case "delete-brand-color":
      return [brandColorClaimKey(op.colorId)];
    case "write-ui":
      return uiPartsElements(op.parts).map((ref) => uiElementClaimKey(ref.componentId, ref.elementId));
    case "write-ui-graphs":
      return uiGraphPartsNodes(op.parts).map((ref) => uiNodeClaimKey(ref.blueprintId, ref.graphId, ref.nodeId));
    case "create-app-tag":
    case "create-dlc":
    case "create-brand-color":
    case "move-brand-color":
    case "set-brand-fonts":
    case "set-dictionary-entry":
    case "set-dictionary-options":
    case "create-audio-track":
    case "update-audio-track":
    case "delete-audio-track":
    case "move-audio-track":
    case "create-asset-sets":
    case "update-asset-set":
    case "delete-asset-sets":
    case "move-asset-sets":
      return [];
    case "update-variable":
    case "delete-variable":
      return [variableClaimKey(op.variableId)];
    case "create-variable":
      return [variableClaimKey(op.entry.id)];
    case "set-key":
      return [localizationKeyClaimKey(op.name)];
    case "remove-key":
      return [localizationKeyClaimKey(op.name)];
  }
}

// ../NarraLeaf-Studio/src/shared/documents/documentPath.ts
var DocumentPathError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "DocumentPathError";
  }
};
var PARAMETER = /^([^<>]*)<([A-Za-z][A-Za-z0-9]*)>([^<>]*)$/;
function normalizeDocumentPath(value) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new DocumentPathError("A document path must be a non-empty project-relative path.");
  }
  if (value.includes("\0")) {
    throw new DocumentPathError(`A document path may not contain a NUL character: ${JSON.stringify(value)}`);
  }
  const normalized = value.replace(/\\/g, "/");
  if (normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized)) {
    throw new DocumentPathError(`A document path must be relative to the project root, got: ${value}`);
  }
  const segments = normalized.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new DocumentPathError(`A document path may not contain empty, "." or ".." segments: ${value}`);
  }
  return segments.join("/");
}
function compileDocumentPathPattern(source) {
  const normalized = normalizeDocumentPath(source);
  return {
    source: normalized,
    segments: normalized.split("/").map((segment) => compileSegment(segment, normalized))
  };
}
function matchDocumentPath(pattern, relativePath) {
  const segments = normalizeDocumentPath(relativePath).split("/");
  if (segments.length !== pattern.segments.length) {
    return null;
  }
  const parameters = {};
  for (let index = 0; index < segments.length; index += 1) {
    const expected = pattern.segments[index];
    const actual = segments[index];
    if (expected.kind === "literal") {
      if (actual !== expected.text) {
        return null;
      }
      continue;
    }
    if (!literalMatchesParameter(actual, expected)) {
      return null;
    }
    parameters[expected.name] = actual.slice(expected.prefix.length, actual.length - expected.suffix.length);
  }
  return parameters;
}
function documentPathParameterNames(pattern) {
  return pattern.segments.filter((segment) => segment.kind === "parameter").map((segment) => segment.name).sort();
}
function formatDocumentPath(pattern, parameters) {
  const path = pattern.segments.map((segment) => {
    if (segment.kind === "literal") {
      return segment.text;
    }
    const value = parameters[segment.name];
    if (typeof value !== "string" || value.length === 0) {
      throw new DocumentPathError(
        `Cannot build "${pattern.source}": <${segment.name}> is missing or empty.`
      );
    }
    return `${segment.prefix}${value}${segment.suffix}`;
  }).join("/");
  const roundTrip = matchDocumentPath(pattern, path);
  if (!roundTrip || documentPathParameterNames(pattern).some((name) => roundTrip[name] !== parameters[name])) {
    throw new DocumentPathError(
      `Cannot build "${pattern.source}" from ${JSON.stringify(parameters)}: the result "${path}" would not read back as the same document.`
    );
  }
  return path;
}
function documentPathPatternsOverlap(a, b) {
  return a.segments.length === b.segments.length && a.segments.every((segment, index) => segmentsOverlap(segment, b.segments[index]));
}
function documentPathPatternSubsumes(a, b) {
  return a.segments.length === b.segments.length && a.segments.every((segment, index) => segmentSubsumes(segment, b.segments[index]));
}
function compileSegment(segment, source) {
  if (!segment.includes("<") && !segment.includes(">")) {
    return { kind: "literal", text: segment };
  }
  const match = PARAMETER.exec(segment);
  if (!match) {
    throw new DocumentPathError(
      `A path segment may hold at most one <parameter>, named with letters and digits: ${source}`
    );
  }
  return { kind: "parameter", name: match[2], prefix: match[1], suffix: match[3] };
}
function segmentsOverlap(a, b) {
  if (a.kind === "literal" && b.kind === "literal") {
    return a.text === b.text;
  }
  if (a.kind === "literal") {
    return literalMatchesParameter(a.text, b);
  }
  if (b.kind === "literal") {
    return literalMatchesParameter(b.text, a);
  }
  return (a.prefix.startsWith(b.prefix) || b.prefix.startsWith(a.prefix)) && (a.suffix.endsWith(b.suffix) || b.suffix.endsWith(a.suffix));
}
function segmentSubsumes(a, b) {
  if (b.kind === "literal") {
    return a.kind === "literal" && a.text === b.text;
  }
  if (a.kind === "literal") {
    return literalMatchesParameter(a.text, b);
  }
  return a.prefix.startsWith(b.prefix) && a.suffix.endsWith(b.suffix);
}
function literalMatchesParameter(text2, parameter) {
  return text2.startsWith(parameter.prefix) && text2.endsWith(parameter.suffix) && text2.length > parameter.prefix.length + parameter.suffix.length;
}

// ../NarraLeaf-Studio/src/shared/documents/registry.ts
var DocumentRegistrationError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "DocumentRegistrationError";
  }
};
var DocumentRegistry = class {
  entries = [];
  /**
   * Two specs claiming one path is a bug in the registration order, and it has to
   * surface here rather than at read time: resolved at read time it would be a
   * document that silently parses with the wrong spec on some machines and not
   * others, depending on module evaluation order.
   *
   * An overlap where one pattern is strictly more specific is allowed, and the more
   * specific one wins - `editor/localization/keys.json` beside
   * `editor/localization/<locale>.json` is a real pair from `ProjectNameConvention`
   * and there is nothing ambiguous about it. Only an overlap where neither pattern
   * contains the other is rejected, because then no rule can decide.
   */
  register(spec) {
    const duplicateKind = this.entries.find((entry) => entry.spec.kind === spec.kind);
    if (duplicateKind) {
      throw new DocumentRegistrationError(
        `Document kind "${spec.kind}" is already registered (paths: ${duplicateKind.spec.paths.join(", ")}).`
      );
    }
    const patterns = spec.paths.map(compileDocumentPathPattern);
    if (patterns.length === 0) {
      throw new DocumentRegistrationError(`Document kind "${spec.kind}" declares no paths, so nothing could ever resolve to it.`);
    }
    for (let index = 0; index < patterns.length; index += 1) {
      for (let other = 0; other < index; other += 1) {
        this.assertUnambiguous(patterns[index], spec.kind, patterns[other], spec.kind);
      }
      for (const entry of this.entries) {
        for (const existing of entry.patterns) {
          this.assertUnambiguous(patterns[index], spec.kind, existing, entry.spec.kind);
        }
      }
    }
    this.entries.push({ spec, patterns });
  }
  get(kind) {
    return this.entries.find((entry) => entry.spec.kind === kind)?.spec;
  }
  list() {
    return this.entries.map((entry) => entry.spec);
  }
  /**
   * The spec owning `relativePath`, or `undefined` if no spec claims it - which is
   * the ordinary answer for the many project files that are not documents.
   *
   * Throws on a path that is not project-relative at all. That is the loud half of
   * the contract on purpose: Lore reports absolute paths, and an absolute path
   * quietly resolving to `undefined` would show up as a version-control feature
   * that produces no semantic diff for anything, with nothing in the logs.
   */
  resolve(relativePath) {
    const path = normalizeDocumentPath(relativePath);
    let best;
    for (const entry of this.entries) {
      for (const pattern of entry.patterns) {
        const parameters = matchDocumentPath(pattern, path);
        if (!parameters) {
          continue;
        }
        if (!best || documentPathPatternSubsumes(pattern, best.pattern)) {
          best = { entry, pattern, parameters };
        }
      }
    }
    return best ? { spec: best.entry.spec, parameters: best.parameters } : void 0;
  }
  assertUnambiguous(pattern, kind, other, otherKind) {
    if (!documentPathPatternsOverlap(pattern, other)) {
      return;
    }
    const subsumesOther = documentPathPatternSubsumes(pattern, other);
    const subsumedByOther = documentPathPatternSubsumes(other, pattern);
    if (subsumesOther !== subsumedByOther) {
      return;
    }
    throw new DocumentRegistrationError(
      subsumesOther ? `Document path "${pattern.source}" is registered twice (${kind} and ${otherKind}).` : `Document paths "${pattern.source}" (${kind}) and "${other.source}" (${otherKind}) match some of the same files, and neither is more specific than the other, so no rule can decide which spec owns them.`
    );
  }
};
function defineDocumentSpec(definition) {
  const patterns = definition.paths.map(compileDocumentPathPattern);
  const decode = definition.decode;
  const serialize = definition.serialize;
  return {
    kind: definition.kind,
    version: definition.version,
    paths: definition.paths,
    matches: (relativePath) => patterns.some((pattern) => matchDocumentPath(pattern, relativePath) !== null),
    pathFor: (parameters) => formatDocumentPath(selectPattern(definition.kind, patterns, parameters ?? {}), parameters ?? {}),
    decode: decode ? (bytes, path) => decode(bytes, path) : (bytes) => decodeJsonDocument(bytes),
    parse: definition.parse,
    serialize: serialize ? (document) => serialize(document) : (document) => encodeCanonicalJson(document),
    summarize: definition.summarize,
    ...definition.diff ? { diff: definition.diff } : {},
    ...definition.merge3 ? { merge3: definition.merge3 } : {}
  };
}
function decodeJsonDocument(bytes) {
  return JSON.parse(new TextDecoder().decode(bytes));
}
function selectPattern(kind, patterns, parameters) {
  const supplied = Object.keys(parameters).sort();
  const candidates = patterns.filter((pattern) => {
    const names = documentPathParameterNames(pattern);
    return names.length === supplied.length && names.every((name, index) => name === supplied[index]);
  });
  if (candidates.length === 1) {
    return candidates[0];
  }
  const described = supplied.length === 0 ? "no parameters" : `parameters (${supplied.join(", ")})`;
  throw new DocumentPathError(
    candidates.length === 0 ? `No path of the "${kind}" document takes ${described}. It declares: ${patterns.map((pattern) => pattern.source).join(", ")}.` : `The "${kind}" document has more than one path taking ${described} (${candidates.map((pattern) => pattern.source).join(", ")}), so it needs to be split into separate kinds.`
  );
}
var defaultRegistry = new DocumentRegistry();

// ../NarraLeaf-Studio/src/shared/documents/specs/parseHelpers.ts
function isJsonObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function requireDocumentObject(raw, context, what) {
  if (!isJsonObject(raw)) {
    return context.corrupt(`expected ${what} object at the document root, got ${describe(raw)}`);
  }
  return raw;
}
function requireOptionalMap(record, key, context) {
  const value = record[key];
  if (value !== void 0 && !isJsonObject(value)) {
    context.corrupt(`"${key}" must be an object keyed by id, got ${describe(value)}`);
  }
}
function rejectNewerSchema(record, context, version) {
  const schemaVersion = record.schemaVersion;
  if (typeof schemaVersion === "number" && schemaVersion > version) {
    context.corrupt(
      `written by a newer version of Studio (schema v${schemaVersion}; this build reads v${version})`,
      { defect: "newerVersion" }
    );
  }
}
function parameterFromPath(pattern, name, context) {
  const parameters = matchDocumentPath(pattern, context.path);
  const value = parameters?.[name];
  if (value === void 0) {
    return context.corrupt(
      `is at "${context.path}", which is not a "${pattern.source}" and so carries no <${name}> (this spec captures ${documentPathParameterNames(pattern).join(", ") || "nothing"})`
    );
  }
  return value;
}
function describe(value) {
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return "an array";
  }
  return `a ${typeof value}`;
}

// ../NarraLeaf-Studio/src/shared/documents/diff.ts
function countDocumentChanges(changes) {
  let count = 0;
  for (const change2 of changes) {
    count += (change2.children?.length ?? 1) + (change2.truncated ?? 0);
  }
  return count;
}
function materializedChanges(changes) {
  let count = 0;
  for (const change2 of changes) {
    count += change2.children?.length ?? 1;
  }
  return count;
}
function buildDocumentDiff(changes, options) {
  const total = options.total ?? countDocumentChanges(changes);
  const kept = [];
  let budget = Math.max(0, options.limit);
  for (const change2 of changes) {
    if (budget <= 0) {
      break;
    }
    const leaves = change2.children?.length ?? 1;
    if (leaves <= budget) {
      kept.push(change2);
      budget -= leaves;
      continue;
    }
    if (change2.children) {
      kept.push({
        ...change2,
        children: change2.children.slice(0, budget),
        truncated: (change2.truncated ?? 0) + (change2.children.length - budget)
      });
    }
    budget = 0;
  }
  return {
    changes: kept,
    // Against what is really on the list, not against what it stands for: a group
    // holding three of its five children reports five, and reading THAT would call a
    // truncated diff complete.
    complete: materializedChanges(kept) >= total,
    total,
    tier: options.tier
  };
}

// ../NarraLeaf-Studio/src/shared/documents/specs/diffHelpers.ts
function sameJsonValue(a, b) {
  if (Object.is(a, b)) {
    return true;
  }
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) {
    return false;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
      return false;
    }
    return a.every((element, index) => sameJsonValue(element, b[index]));
  }
  const left = a;
  const right = b;
  const keys = Object.keys(left);
  if (keys.length !== Object.keys(right).length) {
    return false;
  }
  return keys.every((key) => Object.prototype.hasOwnProperty.call(right, key) && sameJsonValue(left[key], right[key]));
}
function diffKeyed(base, head) {
  const left = base ?? {};
  const right = head ?? {};
  const keys = [.../* @__PURE__ */ new Set([...Object.keys(left), ...Object.keys(right)])].sort();
  const entries = [];
  for (const key of keys) {
    const inBase = Object.prototype.hasOwnProperty.call(left, key);
    const inHead = Object.prototype.hasOwnProperty.call(right, key);
    if (inBase && inHead) {
      if (!sameJsonValue(left[key], right[key])) {
        entries.push({ key, base: left[key], head: right[key], kind: "changed" });
      }
      continue;
    }
    entries.push({
      key,
      base: inBase ? left[key] : void 0,
      head: inHead ? right[key] : void 0,
      kind: inBase ? "removed" : "added"
    });
  }
  return entries;
}
function byId(list) {
  const record = {};
  for (const element of list ?? []) {
    const id = element?.id;
    if (typeof id === "string" && id.length > 0 && !Object.prototype.hasOwnProperty.call(record, id)) {
      record[id] = element;
    }
  }
  return record;
}
var DIFF_VALUE_PREVIEW_CHARS = 80;
function previewValue(value) {
  if (value === void 0 || typeof value === "object" && value !== null) {
    return void 0;
  }
  const text2 = typeof value === "string" ? value : String(value);
  const flat = text2.replace(/\s+/g, " ").trim();
  if (flat.length === 0) {
    return void 0;
  }
  return flat.length > DIFF_VALUE_PREVIEW_CHARS ? `${flat.slice(0, DIFF_VALUE_PREVIEW_CHARS)}\u2026` : flat;
}
function fromToParams(base, head) {
  const from = previewValue(base);
  const to = previewValue(head);
  return {
    ...from === void 0 ? {} : { from },
    ...to === void 0 ? {} : { to }
  };
}
function authoredName(value) {
  if (typeof value !== "string") {
    return void 0;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : void 0;
}
function change(path, kind, key, options = {}) {
  const params = options.params && Object.keys(options.params).length > 0 ? options.params : void 0;
  return {
    path,
    kind,
    label: { key, ...params ? { params } : {} },
    ...options.subject ? { subject: options.subject } : {},
    ...options.children && options.children.length > 0 ? { children: options.children } : {}
  };
}

// ../NarraLeaf-Studio/src/shared/documents/specs/storyDiff.ts
var LABEL = {
  renamed: "documentDiff.story.renamed",
  documentField: "documentDiff.story.documentField",
  chapterAdded: "documentDiff.story.chapterAdded",
  chapterRemoved: "documentDiff.story.chapterRemoved",
  chapterRenamed: "documentDiff.story.chapterRenamed",
  chapterScenes: "documentDiff.story.chapterScenes",
  chapterOrder: "documentDiff.story.chapterOrder",
  sceneAdded: "documentDiff.story.sceneAdded",
  sceneRemoved: "documentDiff.story.sceneRemoved",
  sceneChanged: "documentDiff.story.sceneChanged",
  sceneRenamed: "documentDiff.story.sceneRenamed",
  sceneField: "documentDiff.story.sceneField",
  blockAdded: "documentDiff.story.blockAdded",
  blockRemoved: "documentDiff.story.blockRemoved",
  blockChanged: "documentDiff.story.blockChanged",
  blockMoved: "documentDiff.story.blockMoved",
  blockKind: "documentDiff.story.blockKind",
  blockDisabled: "documentDiff.story.blockDisabled",
  blockEnabled: "documentDiff.story.blockEnabled",
  blockField: "documentDiff.story.blockField",
  blockOrder: "documentDiff.story.blockOrder"
};
var DOCUMENT_FIELDS = ["entrySceneId", "unassignedSceneIds"];
var SCENE_FIELDS = [
  "runtimeName",
  "description",
  "defaultBackgroundAssetId",
  "bgm",
  "layers",
  "sceneSnapshots"
];
function diffStoryDocument(base, head, options) {
  const rows = [];
  if (!sameJsonValue(base.name, head.name)) {
    rows.push(change(["name"], "changed", LABEL.renamed, {
      params: fromToParams(base.name, head.name),
      subject: authoredName(head.name)
    }));
  }
  for (const field of DOCUMENT_FIELDS) {
    const left = base[field];
    const right = head[field];
    if (!sameJsonValue(left, right)) {
      rows.push(change([field], "changed", LABEL.documentField, { params: { field } }));
    }
  }
  rows.push(...chapterRows(base, head));
  rows.push(...sceneRows(base, head));
  return buildDocumentDiff(rows, { tier: "semantic", limit: options.limit });
}
function chapterRows(base, head) {
  const rows = [];
  const baseChapters = byId(base.chapters);
  const headChapters = byId(head.chapters);
  const shared = sharedSceneIds(base, head);
  for (const entry of diffKeyed(baseChapters, headChapters)) {
    const path = ["chapters", entry.key];
    if (!entry.base || !entry.head) {
      const present = entry.head ?? entry.base;
      rows.push(change(path, entry.kind, entry.head ? LABEL.chapterAdded : LABEL.chapterRemoved, {
        subject: authoredName(present?.name)
      }));
      continue;
    }
    const name = authoredName(entry.head.name);
    if (!sameJsonValue(entry.base.name, entry.head.name)) {
      rows.push(change([...path, "name"], "changed", LABEL.chapterRenamed, {
        params: fromToParams(entry.base.name, entry.head.name),
        subject: name
      }));
    }
    const wasScenes = (entry.base.sceneIds ?? []).filter((sceneId) => shared.has(sceneId));
    const nowScenes = (entry.head.sceneIds ?? []).filter((sceneId) => shared.has(sceneId));
    if (!sameJsonValue(wasScenes, nowScenes)) {
      rows.push(change([...path, "sceneIds"], "changed", LABEL.chapterScenes, {
        params: {
          from: (entry.base.sceneIds ?? []).length,
          to: (entry.head.sceneIds ?? []).length
        },
        subject: name
      }));
    }
    if (!sameJsonValue(entry.base.meta, entry.head.meta)) {
      rows.push(change([...path, "meta"], "changed", LABEL.documentField, {
        params: { field: "meta" },
        subject: name
      }));
    }
  }
  if (orderChanged(base.chapters, head.chapters)) {
    rows.push(change(["chapters"], "moved", LABEL.chapterOrder));
  }
  return rows;
}
function sharedSceneIds(base, head) {
  const baseScenes = base.scenes ?? {};
  const headScenes = head.scenes ?? {};
  return new Set(Object.keys(headScenes).filter((id) => Object.prototype.hasOwnProperty.call(baseScenes, id)));
}
function sceneRows(base, head) {
  const baseScenes = base.scenes ?? {};
  const headScenes = head.scenes ?? {};
  const rank = /* @__PURE__ */ new Map();
  for (const sceneId of orderedSceneIds(head)) {
    if (!rank.has(sceneId)) rank.set(sceneId, rank.size);
  }
  for (const sceneId of orderedSceneIds(base)) {
    if (!rank.has(sceneId)) rank.set(sceneId, rank.size);
  }
  const rows = [];
  for (const entry of diffKeyed(baseScenes, headScenes)) {
    const path = ["scenes", entry.key];
    const at = rank.get(entry.key) ?? Number.MAX_SAFE_INTEGER;
    if (!entry.base || !entry.head) {
      const present = entry.head ?? entry.base;
      rows.push({
        rank: at,
        row: change(path, entry.kind, entry.head ? LABEL.sceneAdded : LABEL.sceneRemoved, {
          subject: authoredName(present?.name),
          // One row for a whole new scene, with the size of it in the label rather than a
          // leaf per row it contains: the change the author made is "I wrote a scene".
          params: { blocks: Object.keys(present?.blocks ?? {}).length }
        })
      });
      continue;
    }
    rows.push({
      rank: at,
      row: change(path, "changed", LABEL.sceneChanged, {
        subject: authoredName(entry.head.name),
        children: sceneLeaves(path, entry.base, entry.head)
      })
    });
  }
  rows.sort((a, b) => a.rank - b.rank);
  return rows.map((entry) => entry.row);
}
function orderedSceneIds(document) {
  if (!document.scenes || typeof document.scenes !== "object") {
    return [];
  }
  try {
    return listSceneIdsInDocumentOrder(document);
  } catch {
    return [];
  }
}
function sceneLeaves(path, base, head) {
  const leaves = [];
  if (!sameJsonValue(base.name, head.name)) {
    leaves.push(change([...path, "name"], "changed", LABEL.sceneRenamed, {
      params: fromToParams(base.name, head.name),
      subject: authoredName(head.name)
    }));
  }
  for (const field of SCENE_FIELDS) {
    const left = base[field];
    const right = head[field];
    if (!sameJsonValue(left, right)) {
      leaves.push(change([...path, field], presence(left, right), LABEL.sceneField, {
        params: { field, ...fromToParams(left, right) }
      }));
    }
  }
  if (!sameJsonValue(base.rootBlockIds, head.rootBlockIds)) {
    leaves.push(change([...path, "rootBlockIds"], "moved", LABEL.blockOrder));
  }
  leaves.push(...blockLeaves(path, base, head));
  return leaves;
}
function blockLeaves(path, base, head) {
  const rank = /* @__PURE__ */ new Map();
  for (const block of listSceneBlocksInDocumentOrder(head)) {
    if (!rank.has(block.id)) rank.set(block.id, rank.size);
  }
  for (const block of listSceneBlocksInDocumentOrder(base)) {
    if (!rank.has(block.id)) rank.set(block.id, rank.size);
  }
  const leaves = [];
  let built = 0;
  const push = (leaf, blockId) => {
    leaves.push({ leaf, rank: rank.get(blockId) ?? Number.MAX_SAFE_INTEGER, order: built });
    built += 1;
  };
  for (const entry of diffKeyed(base.blocks ?? {}, head.blocks ?? {})) {
    const blockPath = [...path, "blocks", entry.key];
    if (!entry.base || !entry.head) {
      const present = entry.head ?? entry.base;
      push(change(blockPath, entry.kind, entry.head ? LABEL.blockAdded : LABEL.blockRemoved, {
        subject: blockSubject(present)
      }), entry.key);
      continue;
    }
    const subject = blockSubject(entry.head) ?? blockSubject(entry.base);
    if (entry.base.kind !== entry.head.kind) {
      push(change([...blockPath, "kind"], "changed", LABEL.blockKind, {
        params: { from: String(entry.base.kind), to: String(entry.head.kind) },
        subject
      }), entry.key);
    }
    if (!sameJsonValue(entry.base.payload, entry.head.payload)) {
      push(change([...blockPath, "payload"], "changed", LABEL.blockChanged, { subject }), entry.key);
    }
    if (!sameJsonValue(entry.base.parentId, entry.head.parentId)) {
      push(change([...blockPath, "parentId"], "moved", LABEL.blockMoved, { subject }), entry.key);
    }
    if (!sameJsonValue(entry.base.childrenIds, entry.head.childrenIds)) {
      push(change([...blockPath, "childrenIds"], "moved", LABEL.blockOrder, { subject }), entry.key);
    }
    if (!sameJsonValue(entry.base.disabled, entry.head.disabled)) {
      push(change(
        [...blockPath, "disabled"],
        "changed",
        entry.head.disabled ? LABEL.blockDisabled : LABEL.blockEnabled,
        { subject }
      ), entry.key);
    }
    if (!sameJsonValue(entry.base.diagnosticsMeta, entry.head.diagnosticsMeta)) {
      push(change([...blockPath, "diagnosticsMeta"], "changed", LABEL.blockField, {
        params: { field: "diagnosticsMeta" },
        subject
      }), entry.key);
    }
  }
  leaves.sort((a, b) => a.rank - b.rank || a.order - b.order);
  return leaves.map((entry) => entry.leaf);
}
function blockSubject(block) {
  const payload = block?.payload;
  if (!payload || typeof payload !== "object") {
    return void 0;
  }
  const text2 = payload.text;
  return authoredName(previewValue(text2?.value)) ?? authoredName(previewValue(payload.source)) ?? authoredName(payload.name);
}
function orderChanged(base, head) {
  const left = Object.keys(byId(base));
  const right = Object.keys(byId(head));
  if (left.length !== right.length) {
    return false;
  }
  const inBase = new Set(left);
  return right.every((id) => inBase.has(id)) && (base ?? []).some((element, index) => element?.id !== head?.[index]?.id);
}
function presence(base, head) {
  if (base === void 0) {
    return "added";
  }
  return head === void 0 ? "removed" : "changed";
}

// ../NarraLeaf-Studio/src/shared/utils/isRecord.ts
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ../NarraLeaf-Studio/src/shared/documents/specs/mergeHelpers.ts
function side(present, value) {
  return present ? { present: true, value } : { present: false };
}
function has(record, key) {
  return record !== void 0 && Object.prototype.hasOwnProperty.call(record, key);
}
function mergeKeyed(base, mine, theirs) {
  const ordered = [];
  const seen = /* @__PURE__ */ new Set();
  for (const key of [...Object.keys(mine), ...Object.keys(theirs), ...Object.keys(base ?? {})]) {
    if (seen.has(key)) continue;
    seen.add(key);
    ordered.push(key);
  }
  const merged = {};
  const rows = [];
  for (const key of ordered) {
    const inBase = has(base, key);
    const inMine = has(mine, key);
    const inTheirs = has(theirs, key);
    const baseValue = inBase ? base[key] : void 0;
    const mineValue = inMine ? mine[key] : void 0;
    const theirsValue = inTheirs ? theirs[key] : void 0;
    if (inMine === inTheirs && (!inMine || sameJsonValue(mineValue, theirsValue))) {
      if (inMine) merged[key] = mineValue;
      continue;
    }
    const mineSide = side(inMine, mineValue);
    const theirsSide = side(inTheirs, theirsValue);
    const baseSide = side(inBase, baseValue);
    const mineUntouched = base !== void 0 && inBase === inMine && (!inMine || sameJsonValue(baseValue, mineValue));
    const theirsUntouched = base !== void 0 && inBase === inTheirs && (!inTheirs || sameJsonValue(baseValue, theirsValue));
    if (mineUntouched) {
      if (inTheirs) merged[key] = theirsValue;
      rows.push({ key, outcome: "auto-theirs", mine: mineSide, theirs: theirsSide, base: baseSide, merged: theirsValue });
      continue;
    }
    if (theirsUntouched) {
      if (inMine) merged[key] = mineValue;
      rows.push({ key, outcome: "auto-mine", mine: mineSide, theirs: theirsSide, base: baseSide, merged: mineValue });
      continue;
    }
    let held;
    if (inBase) {
      held = baseValue;
      merged[key] = held;
    } else if (inMine) {
      held = mineValue;
      merged[key] = held;
    }
    rows.push({ key, outcome: "conflict", mine: mineSide, theirs: theirsSide, base: baseSide, merged: held });
  }
  return { merged, rows };
}
function keyedRowLabel(row, labels) {
  if (row.mine.present && row.theirs.present && row.base.present) {
    return labels.changed;
  }
  return row.base.present ? labels.removed : labels.added;
}
function decision(path, row, options = {}) {
  return {
    path,
    outcome: row.outcome,
    ...options.label ? { label: typeof options.label === "string" ? { key: options.label } : options.label } : {},
    ...options.subject ? { subject: options.subject } : {},
    mine: row.mine,
    theirs: row.theirs
  };
}
function labelled(key, params) {
  return params && Object.keys(params).length > 0 ? { key, params } : { key };
}
function byKey(rows) {
  return [...rows].sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
}
function stripFields(record, skip) {
  const out = {};
  if (!record || typeof record !== "object") {
    return out;
  }
  for (const [key, value] of Object.entries(record)) {
    if (skip.has(key) || value === void 0) {
      continue;
    }
    out[key] = value;
  }
  return out;
}
function countConflicts(decisions) {
  return decisions.reduce((count, entry) => count + (entry.outcome === "conflict" ? 1 : 0), 0);
}
var RECORD_STAMP_KEYS = /* @__PURE__ */ new Set(["createdAt", "updatedAt"]);
function pickStamp(values, which) {
  let chosen;
  let chosenAt = Number.NaN;
  for (const value of values) {
    if (typeof value !== "string" || value.length === 0) {
      continue;
    }
    const at = Date.parse(value);
    if (chosen === void 0) {
      chosen = value;
      chosenAt = at;
      continue;
    }
    if (Number.isNaN(at)) {
      continue;
    }
    if (Number.isNaN(chosenAt) || (which === "latest" ? at > chosenAt : at < chosenAt)) {
      chosen = value;
      chosenAt = at;
    }
  }
  return chosen;
}
function mergeMeta(at, base, mine, theirs, hasBase, label) {
  const fields = mergeKeyed(
    hasBase ? stripFields(base, RECORD_STAMP_KEYS) : void 0,
    stripFields(mine, RECORD_STAMP_KEYS),
    stripFields(theirs, RECORD_STAMP_KEYS)
  );
  const decisions = byKey(fields.rows).map((row) => decision([...at, "meta", row.key], row, { label: label(row.key) }));
  const merged = { ...fields.merged };
  const createdAt = pickStamp([stampOf(mine, "createdAt"), stampOf(theirs, "createdAt")], "earliest");
  const updatedAt = pickStamp([stampOf(mine, "updatedAt"), stampOf(theirs, "updatedAt")], "latest");
  if (createdAt !== void 0) merged.createdAt = createdAt;
  if (updatedAt !== void 0) merged.updatedAt = updatedAt;
  const held = isRecord(mine) || isRecord(theirs) || Object.keys(merged).length > 0;
  return { merged: held ? merged : void 0, decisions };
}
function stampOf(record, key) {
  return isRecord(record) ? record[key] : void 0;
}

// ../NarraLeaf-Studio/src/shared/documents/specs/storyMerge3.ts
var LABEL2 = {
  renamed: "documentDiff.story.renamed",
  documentField: "documentDiff.story.documentField",
  chapterOrder: "documentDiff.story.chapterOrder",
  sceneAdded: "documentDiff.story.sceneAdded",
  sceneRemoved: "documentDiff.story.sceneRemoved",
  sceneChanged: "documentDiff.story.sceneChanged",
  sceneRenamed: "documentDiff.story.sceneRenamed",
  sceneField: "documentDiff.story.sceneField",
  blockAdded: "documentDiff.story.blockAdded",
  blockRemoved: "documentDiff.story.blockRemoved",
  blockChanged: "documentDiff.story.blockChanged",
  blockKind: "documentDiff.story.blockKind",
  blockField: "documentDiff.story.blockField"
};
var DOCUMENT_SKIP = /* @__PURE__ */ new Set(["scenes", "schemaVersion", "id", "meta"]);
var SCENE_SKIP = /* @__PURE__ */ new Set(["blocks", "rootBlockIds", "id", "meta"]);
var BLOCK_SKIP = /* @__PURE__ */ new Set(["id", "parentId", "childrenIds"]);
function merge3Story(base, mine, theirs) {
  if (isVersion(mine.schemaVersion) && isVersion(theirs.schemaVersion) && mine.schemaVersion !== theirs.schemaVersion) {
    return refuse("schema-version-split", base, mine, theirs);
  }
  const decisions = [];
  const fields = mergeKeyed(
    // `undefined` rather than `{}` when there is no base, and the two are NOT the same argument:
    // an empty base makes a field only one side holds look like a field the other side deleted
    // and nobody touched, which `mergeKeyed` then takes automatically. That is the add/add
    // failure its own note is about, one level up from the collection it was written for.
    base ? stripFields(base, DOCUMENT_SKIP) : void 0,
    stripFields(mine, DOCUMENT_SKIP),
    stripFields(theirs, DOCUMENT_SKIP)
  );
  for (const row of byKey(fields.rows)) {
    decisions.push(build([row.key], row, documentFieldLabel(row)));
  }
  const meta = mergeMeta(
    [],
    base?.meta,
    mine.meta,
    theirs.meta,
    base !== void 0,
    (key) => labelled(LABEL2.documentField, { field: `meta.${key}` })
  );
  decisions.push(...meta.decisions);
  const baseScenes = scenesOf(base);
  const mineScenes = scenesOf(mine);
  const theirsScenes = scenesOf(theirs);
  const scenesMerge = mergeKeyed(base ? baseScenes : void 0, mineScenes, theirsScenes);
  const scenes = { ...scenesMerge.merged };
  const rank = sceneRank(mine, theirs, base);
  const grouped = [];
  for (const row of scenesMerge.rows) {
    const scenePath = ["scenes", row.key];
    const at = rank.get(row.key) ?? Number.MAX_SAFE_INTEGER;
    const inBase = base ? baseScenes[row.key] : void 0;
    const inMine = mineScenes[row.key];
    const inTheirs = theirsScenes[row.key];
    if (row.outcome === "conflict" && inBase && inMine && inTheirs) {
      const merged = mergeScene(row.key, inBase, inMine, inTheirs);
      if ("refused" in merged) {
        return refuse(merged.refused, base, mine, theirs, scenePath, authoredName(inMine.name));
      }
      scenes[row.key] = merged.scene;
      grouped.push({ rank: at, rows: merged.decisions });
      continue;
    }
    grouped.push({ rank: at, rows: [build(scenePath, row, sceneLabel(row), sceneSubject(row))] });
  }
  grouped.sort((a, b) => a.rank - b.rank);
  for (const entry of grouped) {
    decisions.push(...entry.rows);
  }
  const document = {
    ...fields.merged,
    ...meta.merged === void 0 ? {} : { meta: meta.merged },
    ...mine.schemaVersion === void 0 ? {} : { schemaVersion: mine.schemaVersion },
    ...mine.id === void 0 ? {} : { id: mine.id },
    scenes
  };
  return { document, decisions, conflicts: countConflicts(decisions) };
}
function refuse(reason, base, mine, theirs, path, subject) {
  return {
    // Base, on the same terms as any other unsettled conflict; mine when there is none.
    document: base ?? mine,
    // One decision, addressed at the document itself. A consumer that never reads `refusal`
    // still cannot merge this by accident - it is handed exactly tier one's "take one side
    // whole", which is the designed fallback rather than a degraded one.
    decisions: [{
      path: [],
      outcome: "conflict",
      // No label on purpose: there is no `documentDiff.*` key for "this cannot be merged", and
      // emitting one that is in neither catalogue would draw the dotted path itself at the
      // author. The reason below is what the surface renders, in its own words.
      ...subject ? { subject } : {},
      mine: { present: true, value: mine },
      theirs: { present: true, value: theirs }
    }],
    conflicts: 1,
    refusal: { reason, ...path ? { path } : {}, ...subject ? { subject } : {} }
  };
}
function structureOf(scene) {
  const blocks = blocksOf(scene);
  const children = {};
  const parents = {};
  for (const id of Object.keys(blocks).sort()) {
    const block = blocks[id];
    children[id] = Array.isArray(block?.childrenIds) ? block?.childrenIds : [];
    parents[id] = block?.parentId ?? null;
  }
  return { roots: Array.isArray(scene?.rootBlockIds) ? scene?.rootBlockIds ?? [] : [], children, parents };
}
function mergeScene(sceneId, base, mine, theirs) {
  const baseShape = structureOf(base);
  const mineShape = structureOf(mine);
  const theirsShape = structureOf(theirs);
  let shape = mine;
  if (!sameJsonValue(mineShape, theirsShape)) {
    const mineMoved = !sameJsonValue(mineShape, baseShape);
    const theirsMoved = !sameJsonValue(theirsShape, baseShape);
    if (mineMoved && theirsMoved) {
      return { refused: "scene-restructured" };
    }
    shape = mineMoved ? mine : theirs;
    const other = mineMoved ? theirs : mine;
    const baseBlocks = blocksOf(base);
    const shapeBlocks2 = blocksOf(shape);
    const otherBlocks = blocksOf(other);
    for (const id of Object.keys(baseBlocks)) {
      if (Object.prototype.hasOwnProperty.call(shapeBlocks2, id)) {
        continue;
      }
      if (!sameJsonValue(baseBlocks[id], otherBlocks[id])) {
        return { refused: "row-deleted-and-edited" };
      }
    }
  }
  const decisions = [];
  const fields = mergeKeyed(
    stripFields(base, SCENE_SKIP),
    stripFields(mine, SCENE_SKIP),
    stripFields(theirs, SCENE_SKIP)
  );
  for (const row of byKey(fields.rows)) {
    decisions.push(build(["scenes", sceneId, row.key], row, sceneFieldLabel(row)));
  }
  const meta = mergeMeta(
    ["scenes", sceneId],
    base.meta,
    mine.meta,
    theirs.meta,
    true,
    (key) => labelled(LABEL2.sceneField, { field: `meta.${key}` })
  );
  decisions.push(...meta.decisions);
  const blocks = mergeKeyed(blocksOf(base), blocksOf(mine), blocksOf(theirs));
  const settled = { ...blocks.merged };
  for (const row of blocks.rows) {
    const path = ["scenes", sceneId, "blocks", row.key];
    const refined = refineBlock(path, blocksOf(base)[row.key], blocksOf(mine)[row.key], blocksOf(theirs)[row.key]);
    if (refined) {
      settled[row.key] = refined.block;
      decisions.push(...refined.decisions);
      continue;
    }
    decisions.push(build(path, row, blockLabel(row), rowSubject(row.mine, row.theirs, row.base)));
  }
  const shapeBlocks = blocksOf(shape);
  const merged = {};
  for (const id of Object.keys(structureOf(shape).children)) {
    const chosen = settled[id] ?? shapeBlocks[id];
    if (chosen) {
      merged[id] = withShape(chosen, shapeBlocks[id]);
    }
  }
  const scene = {
    ...fields.merged,
    ...meta.merged === void 0 ? {} : { meta: meta.merged },
    ...sceneId === void 0 ? {} : { id: sceneId },
    rootBlockIds: Array.isArray(shape.rootBlockIds) ? shape.rootBlockIds : [],
    blocks: merged
  };
  return { scene, decisions };
}
function withShape(block, shape) {
  if (!shape) {
    return block;
  }
  const next = { ...block };
  for (const field of ["parentId", "childrenIds"]) {
    if (Object.prototype.hasOwnProperty.call(shape, field)) {
      next[field] = shape[field];
    } else {
      delete next[field];
    }
  }
  return next;
}
function refineBlock(path, base, mine, theirs) {
  if (!base || !mine || !theirs) {
    return void 0;
  }
  if (!sameJsonValue(base.kind, mine.kind) || !sameJsonValue(base.kind, theirs.kind)) {
    return void 0;
  }
  const fields = mergeKeyed(
    stripFields(base, BLOCK_SKIP),
    stripFields(mine, BLOCK_SKIP),
    stripFields(theirs, BLOCK_SKIP)
  );
  const subject = blockSubject(mine) ?? blockSubject(theirs) ?? blockSubject(base);
  const decisions = byKey(fields.rows).map((row) => build([...path, row.key], row, blockFieldLabel(row), subject));
  const block = {
    ...fields.merged,
    ...base.id === void 0 ? {} : { id: base.id }
  };
  return { block, decisions };
}
function documentFieldLabel(row) {
  if (row.key === "name") {
    return labelled(LABEL2.renamed);
  }
  if (row.key === "chapters" && sameIds(row.mine.value, row.theirs.value)) {
    return labelled(LABEL2.chapterOrder);
  }
  return labelled(LABEL2.documentField, { field: row.key });
}
function sceneFieldLabel(row) {
  return row.key === "name" ? labelled(LABEL2.sceneRenamed) : labelled(LABEL2.sceneField, { field: row.key });
}
function blockFieldLabel(row) {
  return row.key === "payload" ? labelled(LABEL2.blockChanged) : labelled(LABEL2.blockField, { field: row.key });
}
function sceneLabel(row) {
  if (!row.base.present) {
    return labelled(LABEL2.sceneAdded, { blocks: blockCount(row) });
  }
  if (!row.mine.present || !row.theirs.present) {
    return labelled(LABEL2.sceneRemoved, { blocks: blockCount(row) });
  }
  return labelled(LABEL2.sceneChanged);
}
function blockLabel(row) {
  if (!row.base.present) {
    return labelled(LABEL2.blockAdded);
  }
  if (!row.mine.present || !row.theirs.present) {
    return labelled(LABEL2.blockRemoved);
  }
  const mineKind = row.mine.value?.kind;
  const theirsKind = row.theirs.value?.kind;
  return sameJsonValue(mineKind, theirsKind) ? labelled(LABEL2.blockChanged) : labelled(LABEL2.blockKind);
}
function sceneSubject(row) {
  const present = (row.mine.present ? row.mine.value : void 0) ?? row.theirs.value ?? row.base.value;
  return authoredName(present?.name);
}
function rowSubject(...sides) {
  for (const one of sides) {
    const subject = one.present ? blockSubject(one.value) : void 0;
    if (subject) {
      return subject;
    }
  }
  return void 0;
}
function blockCount(row) {
  const present = (row.mine.present ? row.mine.value : void 0) ?? row.theirs.value ?? row.base.value;
  const blocks = present?.blocks;
  return blocks && typeof blocks === "object" ? Object.keys(blocks).length : 0;
}
function build(path, row, labelled2, subject) {
  return {
    path,
    outcome: row.outcome,
    label: labelled2,
    ...subject ? { subject } : {},
    mine: row.mine,
    theirs: row.theirs
  };
}
function scenesOf(document) {
  const scenes = document?.scenes;
  return scenes && typeof scenes === "object" ? scenes : {};
}
function blocksOf(scene) {
  const blocks = scene?.blocks;
  return blocks && typeof blocks === "object" ? blocks : {};
}
function isVersion(value) {
  return typeof value === "number" && Number.isFinite(value);
}
function sameIds(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
    return false;
  }
  const ids = (list) => list.map((one) => String(one?.id ?? "")).sort();
  return sameJsonValue(ids(left), ids(right));
}
function sceneRank(mine, theirs, base) {
  const rank = /* @__PURE__ */ new Map();
  for (const document of [mine, theirs, ...base ? [base] : []]) {
    for (const sceneId of orderedSceneIds2(document)) {
      if (!rank.has(sceneId)) {
        rank.set(sceneId, rank.size);
      }
    }
  }
  return rank;
}
function orderedSceneIds2(document) {
  if (!document.scenes || typeof document.scenes !== "object") {
    return [];
  }
  try {
    return listSceneIdsInDocumentOrder(document);
  } catch {
    return [];
  }
}

// ../NarraLeaf-Studio/src/shared/documents/specs/story.ts
var STORY_DOCUMENT_PATH = "editor/story/stories/<storyId>/storydoc.json";
var STORY_DOCUMENT_PATTERN = compileDocumentPathPattern(STORY_DOCUMENT_PATH);
var storyDocumentSpec = defineDocumentSpec({
  kind: "story",
  version: STORY_DOCUMENT_SCHEMA_VERSION,
  paths: [STORY_DOCUMENT_PATH],
  parse: (raw, context) => {
    const storyId = parameterFromPath(STORY_DOCUMENT_PATTERN, "storyId", context);
    const record = requireDocumentObject(raw, context, "a story document");
    if (record.schemaVersion !== void 0 && typeof record.schemaVersion !== "number") {
      return context.corrupt(
        `"schemaVersion" must be a number, got ${describe2(record.schemaVersion)}`
      );
    }
    rejectNewerSchema(record, context, STORY_DOCUMENT_SCHEMA_VERSION);
    requireOptionalMap(record, "scenes", context);
    if (record.chapters !== void 0 && !Array.isArray(record.chapters)) {
      return context.corrupt(`"chapters" must be an array, got ${describe2(record.chapters)}`);
    }
    requireStructuralScenes(record, context);
    let document;
    try {
      document = normalizeStoryDocumentContent({ ...record, id: storyId });
    } catch (error) {
      return context.corrupt(messageOf(error), {
        cause: error,
        defect: findStoryDocumentTooNewError(error) ? "newerVersion" : "damaged"
      });
    }
    if (document.schemaVersion !== STORY_DOCUMENT_SCHEMA_VERSION) {
      return context.corrupt(
        `did not migrate to the current schema (ended at v${String(document.schemaVersion)}, this build writes v${STORY_DOCUMENT_SCHEMA_VERSION})`
      );
    }
    return document;
  },
  /**
   * Canonical bytes, and nothing else.
   *
   * A pure encoder rather than a second normalize pass, which is what
   * {@link import("../types").DocumentSpec.serialize} asks for and what the per-change conflict
   * resolver needs: `applyMergeDecisions` composes a document out of the author's answers, and a
   * serializer that quietly rewrote it would be settling changes the author was never shown.
   *
   * The encoder is the strict half - it throws on a key holding `undefined`, naming its JSON
   * path, where `JSON.stringify` drops it in silence. That strictness is left in place rather
   * than papered over with a strip pass: the only way an `undefined` reaches here is a defect in
   * `parse` or in the merge, and a defect that names its own path is worth more than a document
   * that silently loses a field.
   */
  serialize: (document) => encodeCanonicalJson(document),
  summarize: (document) => ({
    title: typeof document.name === "string" ? document.name : "",
    counts: [
      { key: "storyScenes", value: isJsonObject(document.scenes) ? Object.keys(document.scenes).length : 0 },
      { key: "storyChapters", value: Array.isArray(document.chapters) ? document.chapters.length : 0 },
      { key: "storyBlocks", value: countBlocks(document) }
    ]
  }),
  diff: diffStoryDocument,
  merge3: merge3Story
});
function requireStructuralScenes(record, context) {
  const scenes = record.scenes;
  if (!isJsonObject(scenes)) {
    return;
  }
  for (const [sceneId, scene] of Object.entries(scenes)) {
    if (!isJsonObject(scene)) {
      context.corrupt(`scene "${sceneId}" must be an object, got ${describe2(scene)}`);
    }
    const blocks = scene.blocks;
    if (blocks !== void 0 && !isJsonObject(blocks)) {
      context.corrupt(`scene "${sceneId}" has "blocks" that is not keyed by id, got ${describe2(blocks)}`);
    }
    const rootBlockIds = scene.rootBlockIds;
    if (rootBlockIds !== void 0 && !Array.isArray(rootBlockIds)) {
      context.corrupt(`scene "${sceneId}" has "rootBlockIds" that is not an array, got ${describe2(rootBlockIds)}`);
    }
  }
}
function countBlocks(document) {
  if (!isJsonObject(document.scenes)) {
    return 0;
  }
  let total = 0;
  for (const scene of Object.values(document.scenes)) {
    const blocks = scene?.blocks;
    if (isJsonObject(blocks)) {
      total += Object.keys(blocks).length;
    }
  }
  return total;
}
function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}
function describe2(value) {
  if (value === null) {
    return "null";
  }
  return Array.isArray(value) ? "an array" : `a ${typeof value}`;
}

// ../NarraLeaf-Studio/src/shared/documents/specs/storyIndex.ts
var STORY_INDEX_DOCUMENT_PATH = "editor/story/index.json";
var storyIndexSpec = defineDocumentSpec({
  kind: "story-index",
  version: STORY_LIBRARY_INDEX_SCHEMA_VERSION,
  paths: [STORY_INDEX_DOCUMENT_PATH],
  parse: (raw, context) => {
    const record = requireDocumentObject(raw, context, "a story library index");
    rejectNewerSchema(record, context, STORY_LIBRARY_INDEX_SCHEMA_VERSION);
    requireStoryEntries(record, context);
    return record;
  },
  // No authored name: there is one library per project and the history UI labels it by kind.
  summarize: (document) => ({
    title: "",
    counts: [{ key: "stories", value: Array.isArray(document.stories) ? document.stories.length : 0 }]
  }),
  merge3: merge3StoryIndex
});
function requireStoryEntries(record, context) {
  const stories = record.stories;
  if (stories === void 0) {
    return;
  }
  if (!Array.isArray(stories)) {
    context.corrupt(`"stories" must be an array, got ${describe3(stories)}`);
    return;
  }
  for (const [at, entry] of stories.entries()) {
    if (!isJsonObject(entry)) {
      context.corrupt(`story ${at} must be an object, got ${describe3(entry)}`);
      continue;
    }
    if (typeof entry.id !== "string" || entry.id.length === 0) {
      context.corrupt(`story ${at} has no "id", which is what every other copy matches it by`);
    }
  }
}
var LABEL3 = {
  added: "documentDiff.storyIndex.added",
  removed: "documentDiff.storyIndex.removed",
  changed: "documentDiff.storyIndex.changed",
  renamed: "documentDiff.storyIndex.renamed",
  entryField: "documentDiff.storyIndex.entryField",
  defaultStory: "documentDiff.storyIndex.defaultStory",
  documentField: "documentDiff.storyIndex.documentField"
};
var DOCUMENT_SKIP2 = /* @__PURE__ */ new Set(["stories", "schemaVersion", "meta"]);
var ENTRY_SKIP = /* @__PURE__ */ new Set(["id", "updatedAt"]);
function merge3StoryIndex(base, mine, theirs) {
  const decisions = [];
  const fields = mergeKeyed(
    base ? stripFields(base, DOCUMENT_SKIP2) : void 0,
    stripFields(mine, DOCUMENT_SKIP2),
    stripFields(theirs, DOCUMENT_SKIP2)
  );
  for (const row of byKey(fields.rows)) {
    decisions.push(decision([row.key], row, { label: documentFieldLabel2(row) }));
  }
  const baseStories = byStoryId(base?.stories);
  const mineStories = byStoryId(mine.stories);
  const theirsStories = byStoryId(theirs.stories);
  const merged = mergeKeyed(base ? baseStories : void 0, mineStories, theirsStories);
  const stories = { ...merged.merged };
  for (const row of merged.rows) {
    const path = ["stories", row.key];
    const inBase = baseStories[row.key];
    const inMine = mineStories[row.key];
    const inTheirs = theirsStories[row.key];
    if (row.outcome === "conflict" && base && inBase && inMine && inTheirs) {
      const entry = mergeEntry(row.key, inBase, inMine, inTheirs);
      stories[row.key] = entry.entry;
      decisions.push(...entry.decisions);
      continue;
    }
    decisions.push(decision(path, row, {
      label: keyedRowLabel(row, LABEL3),
      subject: entrySubject(row)
    }));
  }
  const meta = mergeMeta(
    [],
    base?.meta,
    mine.meta,
    theirs.meta,
    base !== void 0,
    (key) => labelled(LABEL3.documentField, { field: `meta.${key}` })
  );
  decisions.push(...meta.decisions);
  const document = {
    ...fields.merged,
    schemaVersion: mine.schemaVersion,
    stories: Object.values(stories),
    ...meta.merged === void 0 ? {} : { meta: meta.merged }
  };
  return { document, decisions, conflicts: countConflicts(decisions) };
}
function mergeEntry(storyId, base, mine, theirs) {
  const fields = mergeKeyed(
    stripFields(base, ENTRY_SKIP),
    stripFields(mine, ENTRY_SKIP),
    stripFields(theirs, ENTRY_SKIP)
  );
  const subject = authoredName(mine.name) ?? authoredName(theirs.name) ?? authoredName(base.name);
  const decisions = byKey(fields.rows).map((row) => decision(["stories", storyId, row.key], row, {
    label: entryFieldLabel(row),
    ...subject ? { subject } : {}
  }));
  const updatedAt = pickStamp([mine.updatedAt, theirs.updatedAt], "latest");
  return {
    entry: {
      ...fields.merged,
      id: storyId,
      ...updatedAt === void 0 ? {} : { updatedAt }
    },
    decisions
  };
}
function byStoryId(stories) {
  const out = {};
  for (const entry of Array.isArray(stories) ? stories : []) {
    if (entry && typeof entry.id === "string" && entry.id.length > 0) {
      out[entry.id] = entry;
    }
  }
  return out;
}
function entrySubject(row) {
  const present = (row.mine.present ? row.mine.value : void 0) ?? row.theirs.value ?? row.base.value;
  return authoredName(present?.name);
}
function documentFieldLabel2(row) {
  return row.key === "defaultStoryId" ? labelled(LABEL3.defaultStory) : labelled(LABEL3.documentField, { field: row.key });
}
function entryFieldLabel(row) {
  return row.key === "name" ? labelled(LABEL3.renamed) : labelled(LABEL3.entryField, { field: row.key });
}
function describe3(value) {
  if (value === null) {
    return "null";
  }
  return Array.isArray(value) ? "an array" : `a ${typeof value}`;
}

// ../NarraLeaf-Studio/src/shared/documents/types.ts
var DocumentCorruptError = class extends Error {
  kind;
  path;
  reason;
  text;
  defect;
  constructor(init) {
    super(`${init.kind} document at ${init.path} could not be read: ${init.reason}`, { cause: init.cause });
    this.name = "DocumentCorruptError";
    this.kind = init.kind;
    this.path = init.path;
    this.reason = init.reason;
    this.text = init.text;
    this.defect = init.defect ?? "damaged";
  }
};

// ../NarraLeaf-Studio/src/shared/authority/storyFiles.ts
var STORY_LIBRARY_PATH = STORY_INDEX_DOCUMENT_PATH;
function storyDocumentPath(storyId) {
  return storyDocumentRelativePath(storyId);
}
function parseStoryLibrary(text2) {
  return storyIndexSpec.parse(jsonOf(text2, "story-index", STORY_LIBRARY_PATH), contextFor("story-index", STORY_LIBRARY_PATH, text2));
}
function parseStoryDocument(storyId, text2) {
  const path = storyDocumentPath(storyId);
  return storyDocumentSpec.parse(jsonOf(text2, "story", path), contextFor("story", path, text2));
}
function serializeStoryFile(value) {
  return JSON.stringify(value, null, 2);
}
function applyStoryOpToLibrary(library, storyId, op, context) {
  if (op.op !== "rename-story") {
    return false;
  }
  const entry = library.stories.find((story) => story.id === storyId);
  if (!entry) {
    return false;
  }
  entry.name = op.name;
  entry.updatedAt = context.now;
  library.meta = { ...library.meta, updatedAt: context.now };
  return true;
}
function contextFor(kind, path, text2) {
  return {
    path,
    corrupt(reason, options) {
      throw new DocumentCorruptError({ kind, path, reason, text: text2, ...options });
    }
  };
}
function jsonOf(text2, kind, path) {
  try {
    return JSON.parse(text2);
  } catch (error) {
    throw new DocumentCorruptError({
      kind,
      path,
      reason: `not JSON: ${error instanceof Error ? error.message : String(error)}`,
      text: text2,
      cause: error
    });
  }
}

// ../NarraLeaf-Studio/src/shared/live/config.ts
function insertLiveRecordBefore(list, entry, beforeId) {
  const index = beforeId === void 0 ? -1 : list.findIndex((item) => item.id === beforeId);
  if (index < 0) {
    return [...list, entry];
  }
  const next = [...list];
  next.splice(index, 0, entry);
  return next;
}

// ../NarraLeaf-Studio/src/shared/documents/specs/appTags.ts
var APP_TAGS_DOCUMENT_PATH = "editor/app-tags.json";
var appTagsSpec = defineDocumentSpec({
  kind: "app-tags",
  version: APP_TAG_SCHEMA_VERSION,
  paths: [APP_TAGS_DOCUMENT_PATH],
  parse: (raw, context) => {
    const record = requireDocumentObject(raw, context, "an app tag list");
    rejectNewerSchema(record, context, APP_TAG_SCHEMA_VERSION);
    if (record.tags !== void 0 && !Array.isArray(record.tags)) {
      context.corrupt(`"tags" must be an array, got ${typeof record.tags}`);
    }
    if (record.pluginConfig !== void 0 && (typeof record.pluginConfig !== "object" || record.pluginConfig === null || Array.isArray(record.pluginConfig))) {
      context.corrupt(`"pluginConfig" must be an object, got ${typeof record.pluginConfig}`);
    }
    if (record.assetAxes !== void 0 && (typeof record.assetAxes !== "object" || record.assetAxes === null || Array.isArray(record.assetAxes))) {
      context.corrupt(`"assetAxes" must be an object, got ${typeof record.assetAxes}`);
    }
    return migrateProjectAppTagDocument(record);
  },
  // No authored name: there is one of these per project and the history UI labels it by kind.
  summarize: (document) => ({
    title: "",
    counts: [{ key: "appTags", value: document.tags.length }]
  }),
  diff: diffAppTags
});
var LABEL4 = {
  added: "documentDiff.appTags.added",
  removed: "documentDiff.appTags.removed",
  renamed: "documentDiff.appTags.renamed",
  displayName: "documentDiff.appTags.displayName",
  identifier: "documentDiff.appTags.identifier",
  version: "documentDiff.appTags.version",
  plugins: "documentDiff.appTags.plugins",
  assetAxes: "documentDiff.appTags.assetAxes",
  scenes: "documentDiff.appTags.scenes",
  ending: "documentDiff.appTags.ending",
  order: "documentDiff.appTags.order"
};
var OVERRIDE_LABELS = [
  ["displayName", LABEL4.displayName],
  ["identifier", LABEL4.identifier],
  ["version", LABEL4.version]
];
function diffAppTags(base, head, options) {
  const rows = [];
  for (const entry of diffKeyed(byId(base.tags), byId(head.tags))) {
    const path = ["tags", entry.key];
    const subject = authoredName(entry.head?.name) ?? authoredName(entry.base?.name);
    if (!entry.base || !entry.head) {
      rows.push(change(path, entry.kind, entry.head ? LABEL4.added : LABEL4.removed, { subject }));
      continue;
    }
    if (!sameJsonValue(entry.base.name, entry.head.name)) {
      rows.push(change([...path, "name"], "changed", LABEL4.renamed, {
        params: fromToParams(entry.base.name, entry.head.name),
        subject
      }));
    }
    for (const [key, label] of OVERRIDE_LABELS) {
      if (!sameJsonValue(entry.base.overrides?.[key], entry.head.overrides?.[key])) {
        rows.push(change([...path, key], presence2(entry.base.overrides?.[key], entry.head.overrides?.[key]), label, {
          params: fromToParams(entry.base.overrides?.[key], entry.head.overrides?.[key]),
          subject
        }));
      }
    }
    for (const [key, label] of [
      ["pluginConfig", LABEL4.plugins],
      ["assetAxes", LABEL4.assetAxes],
      ["reachableScenes", LABEL4.scenes],
      ["endingSurfaceId", LABEL4.ending]
    ]) {
      if (!sameJsonValue(entry.base[key], entry.head[key])) {
        rows.push(change([...path, key], presence2(entry.base[key], entry.head[key]), label, { subject }));
      }
    }
  }
  for (const [key, label] of [
    ["pluginConfig", LABEL4.plugins],
    ["assetAxes", LABEL4.assetAxes],
    ["reachableScenes", LABEL4.scenes]
  ]) {
    if (!sameJsonValue(base[key], head[key])) {
      rows.push(change([key], presence2(base[key], head[key]), label));
    }
  }
  if (!sameJsonValue(sharedOrder(base, head), sharedOrder(head, base))) {
    rows.push(change(["tags"], "moved", LABEL4.order));
  }
  return buildDocumentDiff(rows, { tier: "semantic", limit: options.limit });
}
function sharedOrder(source, other) {
  const known = new Set(other.tags.map((tag) => tag.id));
  return source.tags.map((tag) => tag.id).filter((id) => known.has(id));
}
function presence2(base, head) {
  if (base === void 0) {
    return "added";
  }
  return head === void 0 ? "removed" : "changed";
}

// ../NarraLeaf-Studio/src/shared/documents/specs/assetGroups.ts
var ASSET_GROUPS_DOCUMENT_PATH = "assets/assets.groups.<category>.json";
var ASSET_GROUPS_PATTERN = compileDocumentPathPattern(ASSET_GROUPS_DOCUMENT_PATH);
var assetGroupsSpec = defineDocumentSpec({
  kind: "assets-groups",
  // The shard has never carried a version field - it is a bare map - so there is no schema to
  // reject a future one by. Stated as 1 because the interface requires a number, and `parse`
  // accordingly gates on shape alone.
  version: 1,
  paths: [ASSET_GROUPS_DOCUMENT_PATH],
  parse: (raw, context) => {
    const category = parameterFromPath(ASSET_GROUPS_PATTERN, "category", context);
    const record = requireDocumentObject(raw, context, "an asset folder shard");
    const folders = {};
    for (const [id, entry] of Object.entries(record)) {
      if (isJsonObject(entry)) {
        folders[id] = entry;
      }
    }
    return { category, folders };
  },
  /** Refused; see the note at the top of this module for what has to land before it can write. */
  serialize: () => {
    throw new Error(
      "The assets-groups spec is read-only in this build: GroupAssetsManager owns writing the shard, and it assigns `undefined` where the canonical encoder requires the key to be absent. Adopting it is the assets service's own migration."
    );
  },
  summarize: (shard) => ({
    // No authored title: the shard is named by its section, which is Studio's vocabulary and
    // belongs in a translated label rather than in a field printed verbatim.
    title: "",
    counts: [{ key: "folders", value: Object.keys(shard.folders).length }]
  })
});

// ../NarraLeaf-Studio/src/shared/documents/specs/assetSets.ts
var ASSET_SETS_DOCUMENT_PATH = "editor/asset-sets.json";
var assetSetsSpec = defineDocumentSpec({
  kind: "asset-sets",
  version: ASSET_SET_SCHEMA_VERSION,
  paths: [ASSET_SETS_DOCUMENT_PATH],
  parse: (raw, context) => {
    const record = requireDocumentObject(raw, context, "an asset set list");
    rejectNewerSchema(record, context, ASSET_SET_SCHEMA_VERSION);
    if (record.sets !== void 0 && !Array.isArray(record.sets)) {
      context.corrupt(`"sets" must be an array, got ${typeof record.sets}`);
    }
    return migrateProjectAssetSetDocument(record);
  },
  // No authored name: there is one of these per project and the history UI labels it by kind.
  summarize: (document) => ({
    title: "",
    counts: [{ key: "assetSets", value: document.sets.length }]
  })
});

// ../NarraLeaf-Studio/src/shared/documents/specs/assetsMetadata.ts
var ASSETS_METADATA_DOCUMENT_PATH = "assets/assets.metadata.<type>.json";
var ASSETS_METADATA_PATTERN = compileDocumentPathPattern(ASSETS_METADATA_DOCUMENT_PATH);
var LABEL5 = {
  added: "documentDiff.assets.added",
  removed: "documentDiff.assets.removed",
  changed: "documentDiff.assets.changed",
  renamed: "documentDiff.assets.renamed",
  content: "documentDiff.assets.content",
  field: "documentDiff.assets.field"
};
var ASSET_FIELDS = ["tags", "description", "groupId", "ext", "source", "meta", "extras", "type"];
var assetsMetadataSpec = defineDocumentSpec({
  kind: "assets-metadata",
  // The shard has never carried a version field of its own - it is a bare map - so there is no
  // schema to reject a future one by. Stated as 1 because the interface requires a number, and
  // `parse` accordingly gates on shape alone.
  version: 1,
  paths: [ASSETS_METADATA_DOCUMENT_PATH],
  parse: (raw, context) => {
    const type = parameterFromPath(ASSETS_METADATA_PATTERN, "type", context);
    const record = requireDocumentObject(raw, context, "an asset metadata shard");
    const assets = {};
    for (const [id, entry] of Object.entries(record)) {
      if (isJsonObject(entry)) {
        assets[id] = entry;
      }
    }
    return { type, assets };
  },
  /** Refused; see the note at the top of this module for what has to land before it can write. */
  serialize: () => {
    throw new Error(
      "The assets-metadata spec is read-only in this build: AssetsService owns writing the shard, and the asset services still assign `undefined` where the canonical encoder requires the key to be absent. Adopting it is the assets service's own migration."
    );
  },
  summarize: (shard) => ({
    // No authored title: the shard is named by its asset type, which is Studio's vocabulary and
    // belongs in a translated label rather than in a field printed verbatim.
    title: "",
    counts: [{ key: "assets", value: Object.keys(shard.assets).length }]
  }),
  diff: diffAssetsMetadata,
  merge3: merge3AssetsMetadata
});
function merge3AssetsMetadata(base, mine, theirs) {
  const assets = mergeKeyed(base?.assets, mine.assets, theirs.assets);
  const decisions = assets.rows.map((row) => {
    const present = row.mine.value ?? row.theirs.value ?? row.base.value;
    return decision(["assets", row.key], row, {
      // Decided by the base rather than by which side is empty - see `keyedRowLabel`.
      label: keyedRowLabel(row, LABEL5),
      subject: authoredName(present?.name)
    });
  });
  return {
    // From mine because it is read off the file name, so all three sides carry the same one -
    // `parse` takes it from the path, not from a field, and the three sides are three versions
    // of one path.
    document: { type: mine.type, assets: assets.merged },
    decisions,
    conflicts: countConflicts(decisions)
  };
}
function diffAssetsMetadata(base, head, options) {
  const rows = [];
  for (const entry of diffKeyed(base.assets, head.assets)) {
    const path = ["assets", entry.key];
    if (!entry.base || !entry.head) {
      const present = entry.head ?? entry.base;
      rows.push(change(path, entry.kind, entry.head ? LABEL5.added : LABEL5.removed, {
        subject: authoredName(present?.name)
      }));
      continue;
    }
    const subject = authoredName(entry.head.name) ?? authoredName(entry.base.name);
    const children = [];
    if (!sameJsonValue(entry.base.name, entry.head.name)) {
      children.push(change([...path, "name"], "changed", LABEL5.renamed, {
        params: fromToParams(entry.base.name, entry.head.name),
        subject
      }));
    }
    if (!sameJsonValue(entry.base.hash, entry.head.hash)) {
      children.push(change([...path, "hash"], "changed", LABEL5.content, { subject }));
    }
    for (const field of ASSET_FIELDS) {
      if (!sameJsonValue(entry.base[field], entry.head[field])) {
        children.push(change([...path, field], presence3(entry.base[field], entry.head[field]), LABEL5.field, {
          params: { field, ...fromToParams(entry.base[field], entry.head[field]) },
          subject
        }));
      }
    }
    rows.push(change(path, "changed", LABEL5.changed, { subject, children }));
  }
  rows.sort(byNameThenPath);
  return buildDocumentDiff(rows, { tier: "semantic", limit: options.limit });
}
function presence3(base, head) {
  if (base === void 0) {
    return "added";
  }
  return head === void 0 ? "removed" : "changed";
}
function byNameThenPath(a, b) {
  const left = a.subject ?? "";
  const right = b.subject ?? "";
  if (left !== right) {
    if (left === "") return 1;
    if (right === "") return -1;
    return left < right ? -1 : 1;
  }
  const leftPath = a.path.join("/");
  const rightPath = b.path.join("/");
  return leftPath < rightPath ? -1 : leftPath > rightPath ? 1 : 0;
}

// ../NarraLeaf-Studio/src/shared/types/audioTrack.ts
var AUDIO_TRACK_SCHEMA_VERSION = 2;
var AUDIO_TRACK_ID_BGM = "bgm";
var AUDIO_TRACK_ID_SOUND = "sound";
var AUDIO_TRACK_ID_VOICE = "voice";
var AUDIO_TRACK_VOLUME_MIN = 0;
var AUDIO_TRACK_VOLUME_MAX = 1;
var AUDIO_TRACK_MAX_DEPTH = 8;
var BUILTIN_AUDIO_TRACKS = Object.freeze([
  Object.freeze({
    id: AUDIO_TRACK_ID_BGM,
    name: "Music",
    parentId: null,
    volume: 1,
    loop: true,
    builtin: true
  }),
  Object.freeze({
    id: AUDIO_TRACK_ID_SOUND,
    name: "SFX",
    parentId: null,
    volume: 1,
    loop: false,
    builtin: true
  }),
  Object.freeze({
    id: AUDIO_TRACK_ID_VOICE,
    name: "Voice",
    parentId: null,
    volume: 1,
    loop: false,
    builtin: true
  })
]);
var DEFAULT_AUDIO_TRACK_ID = Object.freeze({
  bgm: AUDIO_TRACK_ID_BGM,
  sound: AUDIO_TRACK_ID_SOUND,
  voice: AUDIO_TRACK_ID_VOICE
});
var LEGACY_AUDIO_TRACK_ID_ALIASES = Object.freeze({
  music: AUDIO_TRACK_ID_BGM,
  sfx: AUDIO_TRACK_ID_SOUND
});
function builtinAudioTrack(id) {
  return BUILTIN_AUDIO_TRACKS.find((track) => track.id === id);
}
var BUILTIN_AUDIO_TRACK_NAME_KEYS = {
  [AUDIO_TRACK_ID_BGM]: "project.audio.builtinName.bgm",
  [AUDIO_TRACK_ID_SOUND]: "project.audio.builtinName.sound",
  [AUDIO_TRACK_ID_VOICE]: "project.audio.builtinName.voice"
};
function finiteOr(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
function normalizeAudioTrackVolume(value, fallback = 1) {
  return clamp(finiteOr(value, fallback), AUDIO_TRACK_VOLUME_MIN, AUDIO_TRACK_VOLUME_MAX);
}
function normalizeProjectAudioTrack(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const record = raw;
  const id = typeof record.id === "string" ? record.id.trim() : "";
  if (!id) {
    return null;
  }
  const builtin = builtinAudioTrack(id);
  const name = typeof record.name === "string" && record.name.trim() ? record.name.trim() : builtin?.name ?? id;
  const parentRaw = typeof record.parentId === "string" ? record.parentId.trim() : "";
  return {
    id,
    name,
    parentId: parentRaw && parentRaw !== id ? parentRaw : null,
    volume: normalizeAudioTrackVolume(record.volume, builtin?.volume ?? 1),
    loop: typeof record.loop === "boolean" ? record.loop : builtin?.loop ?? false,
    // Derived from the id and re-derived on every load, so a hand-written `builtin: true` on a
    // custom track cannot make it undeletable and a stripped one cannot make Music deletable.
    ...builtin ? { builtin: true } : {}
  };
}
function normalizeProjectAudioTracks(raw) {
  const source = Array.isArray(raw) ? raw : [];
  const byId2 = /* @__PURE__ */ new Map();
  const order = [];
  for (const entry of source) {
    const track = normalizeProjectAudioTrack(entry);
    if (!track || byId2.has(track.id)) {
      continue;
    }
    byId2.set(track.id, track);
    order.push(track.id);
  }
  const missing = BUILTIN_AUDIO_TRACKS.filter((seed) => !byId2.has(seed.id));
  for (const seed of missing) {
    byId2.set(seed.id, { ...seed });
  }
  const ids = [...missing.map((seed) => seed.id), ...order];
  for (const id of ids) {
    const track = byId2.get(id);
    if (track.parentId !== null && !byId2.has(track.parentId)) {
      track.parentId = null;
    }
  }
  const settled = /* @__PURE__ */ new Set();
  for (const id of ids) {
    if (settled.has(id)) {
      continue;
    }
    const path = [];
    const onPath = /* @__PURE__ */ new Set();
    let cursor = id;
    while (cursor !== null && !settled.has(cursor)) {
      if (onPath.has(cursor)) {
        byId2.get(cursor).parentId = null;
        break;
      }
      onPath.add(cursor);
      path.push(cursor);
      cursor = byId2.get(cursor).parentId;
    }
    for (const member of path) {
      settled.add(member);
    }
  }
  for (const id of ids) {
    if (audioTrackDepth(byId2, id) > AUDIO_TRACK_MAX_DEPTH) {
      byId2.get(id).parentId = null;
    }
  }
  return ids.map((entry) => byId2.get(entry));
}
function audioTrackDepth(byId2, id) {
  let depth = 0;
  let cursor = byId2.get(id)?.parentId ?? null;
  while (cursor !== null && depth <= AUDIO_TRACK_MAX_DEPTH + 1) {
    depth += 1;
    cursor = byId2.get(cursor)?.parentId ?? null;
  }
  return depth;
}
function migrateProjectAudioTrackDocument(raw) {
  const record = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const meta = record.meta && typeof record.meta === "object" && !Array.isArray(record.meta) ? record.meta : void 0;
  const version = typeof record.schemaVersion === "number" ? record.schemaVersion : 1;
  const tracks = version < 2 ? migrateV1Tracks(record.tracks) : record.tracks;
  return {
    schemaVersion: AUDIO_TRACK_SCHEMA_VERSION,
    tracks: normalizeProjectAudioTracks(tracks),
    ...meta ? { meta } : {}
  };
}
function migrateV1Tracks(raw) {
  const source = Array.isArray(raw) ? raw : [];
  const presentIds = new Set(
    source.map((entry) => entry && typeof entry === "object" && !Array.isArray(entry) ? entry.id : null).filter((id) => typeof id === "string" && id.trim().length > 0).map((id) => id.trim())
  );
  return source.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return entry;
    }
    const track = entry;
    const id = typeof track.id === "string" ? track.id.trim() : "";
    const alias = LEGACY_AUDIO_TRACK_ID_ALIASES[id];
    const renamed = alias && !presentIds.has(alias) ? alias : null;
    const channel = typeof track.channel === "string" ? track.channel.trim() : "";
    const parentId = renamed ? null : channel || null;
    return {
      id: renamed ?? id,
      name: track.name,
      parentId,
      volume: normalizeAudioTrackVolume(track.gain, 1),
      loop: track.loop
    };
  });
}
var CHANNEL_PREFERENCE_KEY = Object.freeze({
  bgm: "bgmVolume",
  sound: "soundVolume",
  voice: "voiceVolume"
});

// ../NarraLeaf-Studio/src/shared/documents/specs/audioTracks.ts
var AUDIO_TRACKS_DOCUMENT_PATH = "editor/audio-tracks.json";
var audioTracksSpec = defineDocumentSpec({
  kind: "audio-tracks",
  version: AUDIO_TRACK_SCHEMA_VERSION,
  paths: [AUDIO_TRACKS_DOCUMENT_PATH],
  parse: (raw, context) => {
    const record = requireDocumentObject(raw, context, "an audio track list");
    rejectNewerSchema(record, context, AUDIO_TRACK_SCHEMA_VERSION);
    if (record.tracks !== void 0 && !Array.isArray(record.tracks)) {
      context.corrupt(`"tracks" must be an array, got ${typeof record.tracks}`);
    }
    return migrateProjectAudioTrackDocument(record);
  },
  // No authored name: there is one of these per project and the history UI labels it by kind.
  summarize: (document) => ({
    title: "",
    counts: [{ key: "audioTracks", value: document.tracks.length }]
  }),
  diff: diffAudioTracks,
  merge3: merge3AudioTracks
});
var LABEL6 = {
  added: "documentDiff.audioTracks.added",
  removed: "documentDiff.audioTracks.removed",
  changed: "documentDiff.audioTracks.changed",
  renamed: "documentDiff.audioTracks.renamed",
  rerouted: "documentDiff.audioTracks.rerouted",
  reroutedToMaster: "documentDiff.audioTracks.reroutedToMaster",
  volume: "documentDiff.audioTracks.volume",
  loopOn: "documentDiff.audioTracks.loopOn",
  loopOff: "documentDiff.audioTracks.loopOff",
  order: "documentDiff.audioTracks.order"
};
function merge3AudioTracks(base, mine, theirs) {
  const tracks = mergeKeyed(
    base === void 0 ? void 0 : byId(base.tracks),
    byId(mine.tracks),
    byId(theirs.tracks)
  );
  const decisions = tracks.rows.map((row) => {
    const present = row.mine.value ?? row.theirs.value ?? row.base.value;
    return decision(["tracks", row.key], row, {
      label: keyedRowLabel(row, LABEL6),
      subject: authoredName(present?.name)
    });
  });
  return {
    document: {
      schemaVersion: mine.schemaVersion,
      tracks: normalizeProjectAudioTracks(Object.values(tracks.merged)),
      ...mine.meta === void 0 ? {} : { meta: mine.meta }
    },
    decisions,
    conflicts: countConflicts(decisions)
  };
}
function diffAudioTracks(base, head, options) {
  const rows = [];
  for (const entry of diffKeyed(byId(base.tracks), byId(head.tracks))) {
    const path = ["tracks", entry.key];
    const subject = authoredName(entry.head?.name) ?? authoredName(entry.base?.name);
    if (!entry.base || !entry.head) {
      rows.push(change(path, entry.kind, entry.head ? LABEL6.added : LABEL6.removed, { subject }));
      continue;
    }
    if (!sameJsonValue(entry.base.name, entry.head.name)) {
      rows.push(change([...path, "name"], "changed", LABEL6.renamed, {
        params: fromToParams(entry.base.name, entry.head.name),
        subject
      }));
    }
    if (!sameJsonValue(entry.base.parentId, entry.head.parentId)) {
      const from = busName(base.tracks, entry.base.parentId);
      const to = busName(head.tracks, entry.head.parentId);
      rows.push(change([...path, "parentId"], "moved", to === void 0 ? LABEL6.reroutedToMaster : LABEL6.rerouted, {
        params: { ...from === void 0 ? {} : { from }, ...to === void 0 ? {} : { to } },
        subject
      }));
    }
    if (!sameJsonValue(entry.base.volume, entry.head.volume)) {
      rows.push(change([...path, "volume"], "changed", LABEL6.volume, {
        params: fromToParams(percent(entry.base.volume), percent(entry.head.volume)),
        subject
      }));
    }
    if (!sameJsonValue(entry.base.loop, entry.head.loop)) {
      rows.push(change([...path, "loop"], "changed", entry.head.loop ? LABEL6.loopOn : LABEL6.loopOff, { subject }));
    }
  }
  if (!sameJsonValue(sharedOrder2(base, head), sharedOrder2(head, base))) {
    rows.push(change(["tracks"], "moved", LABEL6.order));
  }
  return buildDocumentDiff(rows, { tier: "semantic", limit: options.limit });
}
function busName(tracks, parentId) {
  if (parentId === null) {
    return void 0;
  }
  return authoredName(tracks.find((track) => track.id === parentId)?.name);
}
function percent(volume) {
  return typeof volume === "number" && Number.isFinite(volume) ? Math.round(volume * 100) : void 0;
}
function sharedOrder2(source, other) {
  const known = new Set(other.tracks.map((track) => track.id));
  return source.tracks.map((track) => track.id).filter((id) => known.has(id));
}

// ../NarraLeaf-Studio/src/shared/types/localization.ts
var LOCALIZATION_DOCUMENT_SCHEMA_VERSION = 1;
var LOCALE_CODE_PATTERN = /^[A-Za-z0-9-]{1,35}$/;
function isValidLocaleCode(code) {
  return typeof code === "string" && LOCALE_CODE_PATTERN.test(code);
}
function createEmptyLocalizationDocument(locale) {
  return {
    schemaVersion: LOCALIZATION_DOCUMENT_SCHEMA_VERSION,
    locale,
    units: {}
  };
}
function normalizeLocalizationDocument(value, locale) {
  const document = createEmptyLocalizationDocument(locale);
  if (!value || typeof value !== "object") {
    return document;
  }
  const record = value;
  if (!record.units || typeof record.units !== "object") {
    return document;
  }
  for (const [unitId, raw] of Object.entries(record.units)) {
    if (!unitId || !raw || typeof raw !== "object") {
      continue;
    }
    const unit = raw;
    if (typeof unit.target !== "string") {
      continue;
    }
    document.units[unitId] = {
      target: unit.target,
      sourceHash: typeof unit.sourceHash === "string" ? unit.sourceHash : "",
      status: unit.status === "machine" || unit.status === "translated" || unit.status === "reviewed" ? unit.status : "untranslated",
      ...typeof unit.note === "string" && unit.note ? { note: unit.note } : {}
    };
  }
  return document;
}
var LOCALIZATION_KEYS_SCHEMA_VERSION = 1;
var LOCALIZATION_KEY_NAME_PATTERN = /^[A-Za-z0-9]+([._-][A-Za-z0-9]+)*$/;
function isValidLocalizationKeyName(name) {
  return typeof name === "string" && name.length <= 120 && LOCALIZATION_KEY_NAME_PATTERN.test(name);
}
function createEmptyLocalizationKeysDocument() {
  return { schemaVersion: LOCALIZATION_KEYS_SCHEMA_VERSION, keys: {} };
}
function normalizeLocalizationKeysDocument(value) {
  const document = createEmptyLocalizationKeysDocument();
  if (!value || typeof value !== "object") {
    return document;
  }
  const record = value;
  if (!record.keys || typeof record.keys !== "object") {
    return document;
  }
  for (const [name, raw] of Object.entries(record.keys)) {
    if (!isValidLocalizationKeyName(name) || !raw || typeof raw !== "object") {
      continue;
    }
    const entry = raw;
    if (typeof entry.sourceText !== "string") {
      continue;
    }
    document.keys[name] = {
      sourceText: entry.sourceText,
      ...typeof entry.note === "string" && entry.note ? { note: entry.note } : {}
    };
  }
  return document;
}

// ../NarraLeaf-Studio/src/shared/types/typography.ts
var PROJECT_FONT_STACK_MAX = 16;
function normalizeProjectFontStack(raw) {
  const source = Array.isArray(raw) ? raw : [];
  const seen = /* @__PURE__ */ new Set();
  const entries = [];
  for (const item of source) {
    if (entries.length >= PROJECT_FONT_STACK_MAX) {
      break;
    }
    const assetId = readAssetId(item);
    if (!assetId || seen.has(assetId)) {
      continue;
    }
    seen.add(assetId);
    const locales = readLocales(item);
    entries.push(locales.length > 0 ? { assetId, locales } : { assetId });
  }
  return entries;
}
function readAssetId(raw) {
  if (typeof raw === "string") {
    return raw.trim();
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return "";
  }
  const value = raw.assetId;
  return typeof value === "string" ? value.trim() : "";
}
function readLocales(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return [];
  }
  const value = raw.locales;
  if (!Array.isArray(value)) {
    return [];
  }
  const seen = /* @__PURE__ */ new Set();
  const locales = [];
  for (const item of value) {
    const code = typeof item === "string" ? item.trim() : "";
    if (!isValidLocaleCode(code) || seen.has(code)) {
      continue;
    }
    seen.add(code);
    locales.push(code);
  }
  return locales;
}

// ../NarraLeaf-Studio/src/shared/types/brand.ts
var BRAND_SCHEMA_VERSION = 3;
function seedColor(id, value) {
  return Object.freeze({ id, value, builtin: true });
}
var BUILTIN_BRAND_COLORS = Object.freeze([
  seedColor("primary", "#40A8C4"),
  seedColor("secondary", "#2E6E80"),
  seedColor("background", "#101317"),
  seedColor("foreground", "#F2F4F7"),
  seedColor("button.primary", "nlbrand:primary"),
  seedColor("button.secondary", "nlbrand:secondary"),
  seedColor("button.border", "nlbrand:secondary"),
  seedColor("button.text", "nlbrand:foreground"),
  seedColor("button.shadow", "rgba(0, 0, 0, 0.35)"),
  seedColor("container.background", "nlbrand:background"),
  seedColor("container.border", "nlbrand:secondary"),
  seedColor("container.shadow", "rgba(0, 0, 0, 0.35)"),
  seedColor("text.primary", "nlbrand:foreground"),
  seedColor("text.muted", "#9AA3AE"),
  seedColor("textInput.background", "nlbrand:background"),
  seedColor("textInput.border", "nlbrand:secondary"),
  seedColor("textInput.text", "nlbrand:foreground")
]);
function deriveControlGroups(colors) {
  const groups = [];
  for (const color of colors) {
    const dot = color.id.indexOf(".");
    if (dot <= 0) {
      continue;
    }
    const groupId = color.id.slice(0, dot);
    const existing = groups.find((group) => group.id === groupId);
    if (existing) {
      existing.slotIds.push(color.id);
    } else {
      groups.push({ id: groupId, slotIds: [color.id] });
    }
  }
  return Object.freeze(groups.map((group) => Object.freeze({
    id: group.id,
    slotIds: Object.freeze([...group.slotIds])
  })));
}
var BRAND_CONTROL_GROUPS = deriveControlGroups(BUILTIN_BRAND_COLORS);
var BRAND_CONTROL_SLOT_IDS = new Set(BRAND_CONTROL_GROUPS.flatMap((group) => group.slotIds));
function builtinBrandColor(id) {
  return BUILTIN_BRAND_COLORS.find((color) => color.id === id);
}
function normalizeProjectBrandColor(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const record = raw;
  const id = typeof record.id === "string" ? record.id.trim() : "";
  if (!id) {
    return null;
  }
  const seeded = builtinBrandColor(id);
  const value = (typeof record.value === "string" ? record.value.trim() : "") || seeded?.value || "";
  if (!value) {
    return null;
  }
  const name = typeof record.name === "string" ? record.name.trim() : "";
  return {
    id,
    // Absent rather than empty. The panel falls back to a translated default for a nameless
    // entry, and `""` would draw an empty row instead of that default.
    ...name ? { name } : {},
    value,
    // Derived from the id and re-derived on every load, so a hand-written `builtin: true` on an
    // author's own colour cannot make it undeletable, and a stripped one cannot make `primary`
    // deletable.
    ...seeded ? { builtin: true } : {}
  };
}
function normalizeProjectBrandColors(raw) {
  const source = Array.isArray(raw) ? raw : [];
  const byId2 = /* @__PURE__ */ new Map();
  const order = [];
  for (const entry of source) {
    const color = normalizeProjectBrandColor(entry);
    if (!color || byId2.has(color.id)) {
      continue;
    }
    byId2.set(color.id, color);
    order.push(color.id);
  }
  const missing = BUILTIN_BRAND_COLORS.filter((seed) => !byId2.has(seed.id));
  for (const seed of missing) {
    byId2.set(seed.id, { ...seed });
  }
  return [...missing.map((seed) => seed.id), ...order].map((id) => byId2.get(id));
}
function migrateProjectBrandDocument(raw) {
  const record = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const version = record.schemaVersion;
  if (typeof version === "number" && Number.isFinite(version) && version > BRAND_SCHEMA_VERSION) {
    throw new Error(
      `Brand document schema v${version} is newer than this Studio version can read (v${BRAND_SCHEMA_VERSION} is the newest supported)`
    );
  }
  return {
    schemaVersion: BRAND_SCHEMA_VERSION,
    colors: normalizeProjectBrandColors(record.colors),
    // Absent on every v1 file, and on every project that has never chosen one. Both read as an
    // empty stack, which is the state text rendered in before this field existed.
    fonts: normalizeProjectFontStack(record.fonts)
  };
}

// ../NarraLeaf-Studio/src/shared/documents/specs/brand.ts
var BRAND_DOCUMENT_PATH = "editor/brand.json";
var brandSpec = defineDocumentSpec({
  kind: "brand",
  version: BRAND_SCHEMA_VERSION,
  paths: [BRAND_DOCUMENT_PATH],
  parse: (raw, context) => {
    const record = requireDocumentObject(raw, context, "a brand palette");
    rejectNewerSchema(record, context, BRAND_SCHEMA_VERSION);
    if (record.colors !== void 0 && !Array.isArray(record.colors)) {
      context.corrupt(`"colors" must be an array, got ${typeof record.colors}`);
    }
    if (record.fonts !== void 0 && !Array.isArray(record.fonts)) {
      context.corrupt(`"fonts" must be an array, got ${typeof record.fonts}`);
    }
    return migrateProjectBrandDocument(record);
  },
  // No authored name: there is one of these per project and the history UI labels it by kind.
  summarize: (document) => ({
    title: "",
    // The author's own colours, not the total. The seeds are always present and always the same
    // number, so counting them reports a change of 17 -> 17 for every edit that is not an add or
    // a delete - a row in the history that carries no information at all.
    counts: [
      { key: "brandColors", value: document.colors.filter((color) => !color.builtin).length },
      // Counted whole, unlike the colours: every rung of the stack is one the author put
      // there, so there is no seeded floor to subtract and 0 -> 1 is the row that matters.
      { key: "brandFonts", value: document.fonts.length }
    ]
  }),
  diff: diffBrand
});
var LABEL7 = {
  added: "documentDiff.brand.added",
  removed: "documentDiff.brand.removed",
  renamed: "documentDiff.brand.renamed",
  value: "documentDiff.brand.value",
  fonts: "documentDiff.brand.fonts"
};
function diffBrand(base, head, options) {
  const rows = [];
  for (const entry of diffKeyed(byId(base.colors), byId(head.colors))) {
    const path = ["colors", entry.key];
    const subject = authoredName(entry.head?.name) ?? authoredName(entry.base?.name);
    if (!entry.base || !entry.head) {
      rows.push(change(path, entry.kind, entry.head ? LABEL7.added : LABEL7.removed, {
        params: fromToParams(entry.base?.value, entry.head?.value),
        subject
      }));
      continue;
    }
    if (!sameJsonValue(entry.base.name, entry.head.name)) {
      rows.push(change([...path, "name"], "changed", LABEL7.renamed, {
        params: fromToParams(entry.base.name, entry.head.name),
        subject
      }));
    }
    if (!sameJsonValue(entry.base.value, entry.head.value)) {
      rows.push(change([...path, "value"], "changed", LABEL7.value, {
        params: fromToParams(entry.base.value, entry.head.value),
        subject
      }));
    }
  }
  if (!sameJsonValue(base.fonts, head.fonts)) {
    rows.push(change(["fonts"], "changed", LABEL7.fonts));
  }
  return buildDocumentDiff(rows, { tier: "semantic", limit: options.limit });
}

// ../NarraLeaf-Studio/src/shared/utils/characterAppearanceKinds.ts
var PUPPET_APPEARANCE_KINDS = ["puppet", "live2d", "spine"];
var CHARACTER_APPEARANCE_KINDS = [
  "preset",
  "layered",
  ...PUPPET_APPEARANCE_KINDS
];
function isCharacterAppearanceKind(value) {
  return CHARACTER_APPEARANCE_KINDS.includes(value);
}
function isPuppetAppearanceKind(value) {
  return PUPPET_APPEARANCE_KINDS.includes(value);
}

// ../NarraLeaf-Studio/src/shared/types/character/model.ts
function isPuppetAppearance(appearance) {
  return isPuppetAppearanceKind(appearance?.kind);
}

// ../NarraLeaf-Studio/src/shared/characters/characterStoreModel.ts
var CHARACTER_STORE_VERSION = 2;
function isNewerCharacterStore(version) {
  return typeof version === "number" && Number.isFinite(version) && version > CHARACTER_STORE_VERSION;
}
function findUnreadableCharacterAppearance(characters) {
  for (const entry of characters) {
    const profile = entry?.profile;
    if (!profile) {
      continue;
    }
    if (isCharacterAppearanceKind(profile.appearance?.kind)) {
      continue;
    }
    return typeof profile.name === "string" && profile.name.trim() ? profile.name.trim() : "(unnamed)";
  }
  return null;
}

// ../NarraLeaf-Studio/src/shared/documents/specs/charactersDiff.ts
var LABEL8 = {
  castOrder: "documentDiff.characters.castOrder",
  added: "documentDiff.characters.added",
  removed: "documentDiff.characters.removed",
  changed: "documentDiff.characters.changed",
  renamed: "documentDiff.characters.renamed",
  profileField: "documentDiff.characters.profileField",
  kindChanged: "documentDiff.characters.kindChanged",
  poseAdded: "documentDiff.characters.poseAdded",
  poseRemoved: "documentDiff.characters.poseRemoved",
  poseRenamed: "documentDiff.characters.poseRenamed",
  poseAsset: "documentDiff.characters.poseAsset",
  poseChanged: "documentDiff.characters.poseChanged",
  poseOrder: "documentDiff.characters.poseOrder",
  defaultPose: "documentDiff.characters.defaultPose",
  axisAdded: "documentDiff.characters.axisAdded",
  axisRemoved: "documentDiff.characters.axisRemoved",
  axisChanged: "documentDiff.characters.axisChanged",
  layerAdded: "documentDiff.characters.layerAdded",
  layerRemoved: "documentDiff.characters.layerRemoved",
  layerChanged: "documentDiff.characters.layerChanged",
  layerAsset: "documentDiff.characters.layerAsset",
  layerOptionAsset: "documentDiff.characters.layerOptionAsset",
  layerOrder: "documentDiff.characters.layerOrder",
  appearanceField: "documentDiff.characters.appearanceField",
  avatarChanged: "documentDiff.characters.avatarChanged",
  groupAdded: "documentDiff.characters.groupAdded",
  groupRemoved: "documentDiff.characters.groupRemoved",
  groupRenamed: "documentDiff.characters.groupRenamed"
};
var PROFILE_FIELDS = [
  "description",
  "tags",
  "nicknames",
  "attributes",
  "groupId",
  "color",
  "thumbnail",
  "portrait",
  "defaultAvatarAssetId",
  "voiceTrackId",
  "entranceTransform"
];
var PUPPET_FIELDS = ["assetId", "backend", "entry", "size", "options", "defaultState"];
var LAYERED_FIELDS = ["canvas", "avatarAxisIds", "psd"];
function diffCharacterStore(base, head, options) {
  const rows = [];
  const baseCharacters = charactersById(base);
  const headCharacters = charactersById(head);
  const baseOrder = Object.keys(baseCharacters);
  const headOrder = Object.keys(headCharacters);
  if (baseOrder.length === headOrder.length && baseOrder.some((id, index) => id !== headOrder[index]) && baseOrder.every((id) => Object.prototype.hasOwnProperty.call(headCharacters, id))) {
    rows.push(change(["characters"], "moved", LABEL8.castOrder, { params: { count: headOrder.length } }));
  }
  const characterRows = [];
  for (const entry of diffKeyed(baseCharacters, headCharacters)) {
    const row = characterRow(entry.key, entry.base, entry.head);
    if (row) {
      characterRows.push(row);
    }
  }
  characterRows.sort(byNameThenPath2);
  rows.push(...characterRows);
  const groupRows = [];
  for (const entry of diffKeyed(base.groups, head.groups)) {
    const row = groupRow(entry.key, entry.base, entry.head);
    if (row) groupRows.push(row);
  }
  groupRows.sort(byNameThenPath2);
  rows.push(...groupRows);
  return buildDocumentDiff(rows, { tier: "semantic", limit: options.limit });
}
function charactersById(store) {
  const record = {};
  for (const character of Array.isArray(store.characters) ? store.characters : []) {
    const id = character?.profile?.id;
    if (typeof id === "string" && id.length > 0 && !Object.prototype.hasOwnProperty.call(record, id)) {
      record[id] = character;
    }
  }
  return record;
}
function characterRow(id, base, head) {
  const path = ["characters", id];
  if (!base || !head) {
    const present = head ?? base;
    return change(path, head ? "added" : "removed", head ? LABEL8.added : LABEL8.removed, {
      subject: authoredName(present?.profile?.name)
    });
  }
  const children = characterLeaves(path, base, head);
  if (children.length === 0) {
    return change(path, "changed", LABEL8.changed, { subject: authoredName(head.profile?.name) });
  }
  return change(path, "changed", LABEL8.changed, {
    subject: authoredName(head.profile?.name),
    children
  });
}
function characterLeaves(path, base, head) {
  const leaves = [];
  const baseProfile = base.profile ?? {};
  const headProfile = head.profile ?? {};
  if (!sameJsonValue(baseProfile.name, headProfile.name)) {
    leaves.push(change([...path, "name"], "changed", LABEL8.renamed, {
      params: fromToParams(baseProfile.name, headProfile.name),
      subject: authoredName(headProfile.name)
    }));
  }
  for (const field of PROFILE_FIELDS) {
    if (!sameJsonValue(baseProfile[field], headProfile[field])) {
      leaves.push(change([...path, field], presence4(baseProfile[field], headProfile[field]), LABEL8.profileField, {
        params: { field, ...fromToParams(baseProfile[field], headProfile[field]) }
      }));
    }
  }
  leaves.push(...appearanceLeaves(
    [...path, "appearance"],
    baseProfile.appearance,
    headProfile.appearance
  ));
  return leaves;
}
function appearanceLeaves(path, base, head) {
  if (!base || !head) {
    return sameJsonValue(base, head) ? [] : [change([...path], presence4(base, head), LABEL8.appearanceField, { params: { field: "appearance" } })];
  }
  if (base.kind !== head.kind) {
    return [change([...path, "kind"], "changed", LABEL8.kindChanged, {
      params: { from: String(base.kind), to: String(head.kind) }
    })];
  }
  if (isPuppetAppearance(head) && isPuppetAppearance(base)) {
    return puppetLeaves(path, base, head);
  }
  if (head.kind === "layered" && base.kind === "layered") {
    return layeredLeaves(path, base, head);
  }
  if (head.kind === "preset" && base.kind === "preset") {
    return presetLeaves(path, base, head);
  }
  return [];
}
function presetLeaves(path, base, head) {
  const leaves = [];
  const basePoses = byId(base.poses);
  const headPoses = byId(head.poses);
  for (const entry of diffKeyed(basePoses, headPoses)) {
    const posePath = [...path, "poses", entry.key];
    if (!entry.base || !entry.head) {
      const present = entry.head ?? entry.base;
      leaves.push(change(posePath, entry.kind, entry.head ? LABEL8.poseAdded : LABEL8.poseRemoved, {
        subject: authoredName(present?.name)
      }));
      continue;
    }
    if (!sameJsonValue(entry.base.assetId, entry.head.assetId)) {
      leaves.push(change([...posePath, "assetId"], "changed", LABEL8.poseAsset, {
        subject: authoredName(entry.head.name)
      }));
    }
    if (!sameJsonValue(entry.base.name, entry.head.name)) {
      leaves.push(change([...posePath, "name"], "changed", LABEL8.poseRenamed, {
        params: fromToParams(entry.base.name, entry.head.name),
        subject: authoredName(entry.head.name)
      }));
    }
    if (!sameJsonValue(entry.base.folder, entry.head.folder) || !sameJsonValue(entry.base.portrait, entry.head.portrait)) {
      leaves.push(change(posePath, "changed", LABEL8.poseChanged, {
        subject: authoredName(entry.head.name)
      }));
    }
  }
  if (orderChanged2(base.poses, head.poses)) {
    leaves.push(change([...path, "poses"], "moved", LABEL8.poseOrder));
  }
  if (!sameJsonValue(base.defaultPoseId, head.defaultPoseId)) {
    leaves.push(change([...path, "defaultPoseId"], "changed", LABEL8.defaultPose, {
      subject: authoredName(headPoses[String(head.defaultPoseId)]?.name)
    }));
  }
  leaves.push(...avatarLeaves(path, base.avatars, head.avatars));
  return leaves;
}
function layeredLeaves(path, base, head) {
  const leaves = [];
  const headTagNames = tagNames(head.axes);
  const baseTagNames = tagNames(base.axes);
  for (const entry of diffKeyed(byId(base.axes), byId(head.axes))) {
    const axisPath = [...path, "axes", entry.key];
    const present = entry.head ?? entry.base;
    if (!entry.base || !entry.head) {
      leaves.push(change(axisPath, entry.kind, entry.head ? LABEL8.axisAdded : LABEL8.axisRemoved, {
        subject: authoredName(present?.name)
      }));
      continue;
    }
    leaves.push(change(axisPath, "changed", LABEL8.axisChanged, { subject: authoredName(entry.head.name) }));
  }
  for (const entry of diffKeyed(byId(base.layers), byId(head.layers))) {
    const layerPath = [...path, "layers", entry.key];
    if (!entry.base || !entry.head) {
      const present = entry.head ?? entry.base;
      leaves.push(change(layerPath, entry.kind, entry.head ? LABEL8.layerAdded : LABEL8.layerRemoved, {
        subject: authoredName(present?.name)
      }));
      continue;
    }
    const layerName = authoredName(entry.head.name);
    if (!sameJsonValue(entry.base.assetId, entry.head.assetId)) {
      leaves.push(change([...layerPath, "assetId"], "changed", LABEL8.layerAsset, { subject: layerName }));
    }
    for (const option of diffKeyed(entry.base.options, entry.head.options)) {
      const tag = headTagNames[option.key] ?? baseTagNames[option.key];
      leaves.push(change([...layerPath, "options", option.key], option.kind, LABEL8.layerOptionAsset, {
        params: { ...layerName ? { layer: layerName } : {}, ...tag ? { tag } : {} },
        subject: tag ?? layerName
      }));
    }
    if (!sameJsonValue(entry.base.name, entry.head.name) || !sameJsonValue(entry.base.axisId, entry.head.axisId)) {
      leaves.push(change(layerPath, "changed", LABEL8.layerChanged, {
        params: fromToParams(entry.base.name, entry.head.name),
        subject: layerName
      }));
    }
  }
  if (orderChanged2(base.layers, head.layers)) {
    leaves.push(change([...path, "layers"], "moved", LABEL8.layerOrder));
  }
  for (const field of LAYERED_FIELDS) {
    if (!sameJsonValue(base[field], head[field])) {
      leaves.push(change([...path, field], presence4(base[field], head[field]), LABEL8.appearanceField, {
        params: { field }
      }));
    }
  }
  if (!sameJsonValue(base.snapshots, head.snapshots)) {
    leaves.push(change([...path, "snapshots"], "changed", LABEL8.appearanceField, { params: { field: "snapshots" } }));
  }
  leaves.push(...avatarLeaves(path, base.avatars, head.avatars));
  return leaves;
}
function puppetLeaves(path, base, head) {
  const leaves = [];
  for (const field of PUPPET_FIELDS) {
    if (!sameJsonValue(base[field], head[field])) {
      leaves.push(change([...path, field], presence4(base[field], head[field]), LABEL8.appearanceField, {
        params: { field, ...fromToParams(base[field], head[field]) }
      }));
    }
  }
  return leaves;
}
function avatarLeaves(path, base, head) {
  return diffKeyed(base, head).map((entry) => change(
    [...path, "avatars", entry.key],
    entry.kind,
    LABEL8.avatarChanged,
    { params: { key: entry.key } }
  ));
}
function groupRow(id, base, head) {
  const path = ["groups", id];
  if (!base || !head) {
    const present = head ?? base;
    return change(path, head ? "added" : "removed", head ? LABEL8.groupAdded : LABEL8.groupRemoved, {
      subject: authoredName(present?.name)
    });
  }
  if (base.name === head.name) return void 0;
  return change(path, "changed", LABEL8.groupRenamed, {
    params: fromToParams(base.name, head.name),
    subject: authoredName(head.name)
  });
}
function orderChanged2(base, head) {
  const left = Object.keys(byId(base));
  const right = Object.keys(byId(head));
  if (left.length !== right.length) {
    return false;
  }
  const inBase = new Set(left);
  return right.every((id) => inBase.has(id)) && (base ?? []).some((element, index) => element?.id !== head?.[index]?.id);
}
function tagNames(axes) {
  const names = {};
  for (const axis of axes ?? []) {
    for (const tag of axis?.tags ?? []) {
      const name = authoredName(tag?.name);
      if (typeof tag?.id === "string" && name && !names[tag.id]) {
        names[tag.id] = name;
      }
    }
  }
  return names;
}
function presence4(base, head) {
  if (base === void 0) {
    return "added";
  }
  return head === void 0 ? "removed" : "changed";
}
function byNameThenPath2(a, b) {
  const left = a.subject ?? "";
  const right = b.subject ?? "";
  if (left !== right) {
    if (left === "") return 1;
    if (right === "") return -1;
    return left < right ? -1 : 1;
  }
  const leftPath = a.path.join("/");
  const rightPath = b.path.join("/");
  return leftPath < rightPath ? -1 : leftPath > rightPath ? 1 : 0;
}

// ../NarraLeaf-Studio/src/shared/documents/specs/characters.ts
var CHARACTER_STORE_DOCUMENT_PATH = "editor/services/character.json";
var charactersSpec = defineDocumentSpec({
  kind: "characters",
  version: CHARACTER_STORE_VERSION,
  paths: [CHARACTER_STORE_DOCUMENT_PATH],
  parse: (raw, context) => {
    const record = requireDocumentObject(raw, context, "a character store");
    if (isNewerCharacterStore(record.version)) {
      return context.corrupt(
        `written by a newer version of Studio (store version ${String(record.version)}; this build reads ${CHARACTER_STORE_VERSION})`,
        { defect: "newerVersion" }
      );
    }
    const characters = record.characters;
    if (characters !== void 0 && !Array.isArray(characters)) {
      return context.corrupt(`"characters" must be an array, got ${describe4(characters)}`);
    }
    requireOptionalMap(record, "groups", context);
    const entries = characters ?? [];
    const unreadable = findUnreadableCharacterAppearance(entries);
    if (unreadable !== null) {
      return context.corrupt(`character "${unreadable}" has an appearance this build cannot read`);
    }
    const { version: _version, characters: _characters, groups: _groups, ...rest } = record;
    return {
      ...rest,
      version: CHARACTER_STORE_VERSION,
      characters: entries,
      ...record.groups === void 0 ? {} : { groups: record.groups }
    };
  },
  // No authored title: a project has one cast and the history UI labels it by kind. The two counts
  // are what the author would check a revision against - how many characters, how many groups.
  summarize: (store) => ({
    title: "",
    counts: [
      { key: "characters", value: Array.isArray(store.characters) ? store.characters.length : 0 },
      { key: "characterGroups", value: isJsonObject(store.groups) ? Object.keys(store.groups).length : 0 }
    ]
  }),
  diff: diffCharacterStore
});
function describe4(value) {
  if (value === null) {
    return "null";
  }
  return Array.isArray(value) ? "an array" : `a ${typeof value}`;
}

// ../NarraLeaf-Studio/src/shared/types/dictionary.ts
var PROJECT_DICTIONARY_SCHEMA_VERSION = 2;
var DEFAULT_DICTIONARY_OPTIONS = {
  suggestReadings: true,
  checkVariants: true
};
function normalizeDictionaryWord(raw) {
  if (typeof raw !== "string") {
    return null;
  }
  const word = raw.trim().replace(/\s+/g, " ");
  return word ? word : null;
}
function byCodeUnit(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}
function normalizeDictionaryVariants(raw, term) {
  const source = Array.isArray(raw) ? raw : [];
  const folded = term.toLowerCase();
  const seen = /* @__PURE__ */ new Map();
  for (const entry of source) {
    const variant = normalizeDictionaryWord(entry);
    if (!variant) {
      continue;
    }
    const key = variant.toLowerCase();
    if (key === folded || seen.has(key)) {
      continue;
    }
    seen.set(key, variant);
  }
  return [...seen.values()].sort(byCodeUnit);
}
function normalizeDictionaryEntry(raw) {
  if (typeof raw === "string") {
    const term2 = normalizeDictionaryWord(raw);
    return term2 ? { term: term2 } : null;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const record = raw;
  const term = normalizeDictionaryWord(record.term);
  if (!term) {
    return null;
  }
  const entry = { term };
  const reading = normalizeDictionaryWord(record.reading);
  if (reading) {
    entry.reading = reading;
  }
  const variants = normalizeDictionaryVariants(record.variants, term);
  if (variants.length > 0) {
    entry.variants = variants;
  }
  const note = typeof record.note === "string" ? record.note.trim() : "";
  if (note) {
    entry.note = note;
  }
  return entry;
}
function normalizeDictionaryEntries(raw) {
  const source = Array.isArray(raw) ? raw : [];
  const byTerm2 = /* @__PURE__ */ new Map();
  for (const item of source) {
    const entry = normalizeDictionaryEntry(item);
    if (!entry) {
      continue;
    }
    const existing = byTerm2.get(entry.term);
    byTerm2.set(entry.term, existing ? mergeEntries(existing, entry) : entry);
  }
  return [...byTerm2.values()].sort((left, right) => byCodeUnit(left.term, right.term));
}
function mergeEntries(earlier, later) {
  const merged = { term: earlier.term };
  const reading = earlier.reading ?? later.reading;
  if (reading) {
    merged.reading = reading;
  }
  const variants = normalizeDictionaryVariants(
    [...earlier.variants ?? [], ...later.variants ?? []],
    earlier.term
  );
  if (variants.length > 0) {
    merged.variants = variants;
  }
  const note = earlier.note ?? later.note;
  if (note) {
    merged.note = note;
  }
  return merged;
}
function normalizeDictionaryOptions(raw) {
  const record = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  return {
    suggestReadings: typeof record.suggestReadings === "boolean" ? record.suggestReadings : DEFAULT_DICTIONARY_OPTIONS.suggestReadings,
    checkVariants: typeof record.checkVariants === "boolean" ? record.checkVariants : DEFAULT_DICTIONARY_OPTIONS.checkVariants
  };
}
function migrateProjectDictionaryDocument(raw) {
  const record = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const source = [
    ...Array.isArray(record.entries) ? record.entries : [],
    ...Array.isArray(record.words) ? record.words : []
  ];
  return {
    schemaVersion: PROJECT_DICTIONARY_SCHEMA_VERSION,
    entries: normalizeDictionaryEntries(source),
    options: normalizeDictionaryOptions(record.options)
  };
}

// ../NarraLeaf-Studio/src/shared/documents/specs/dictionary.ts
var DICTIONARY_DOCUMENT_PATH = "editor/dictionary.json";
var dictionarySpec = defineDocumentSpec({
  kind: "dictionary",
  version: PROJECT_DICTIONARY_SCHEMA_VERSION,
  paths: [DICTIONARY_DOCUMENT_PATH],
  parse: (raw, context) => {
    const record = requireDocumentObject(raw, context, "a project dictionary");
    rejectNewerSchema(record, context, PROJECT_DICTIONARY_SCHEMA_VERSION);
    if (record.entries !== void 0 && !Array.isArray(record.entries)) {
      context.corrupt(`"entries" must be an array, got ${typeof record.entries}`);
    }
    if (record.words !== void 0 && !Array.isArray(record.words)) {
      context.corrupt(`"words" must be an array, got ${typeof record.words}`);
    }
    return migrateProjectDictionaryDocument(record);
  },
  // No authored name: there is one of these per project and the history UI labels it by kind.
  summarize: (document) => ({
    title: "",
    counts: [{ key: "dictionaryTerms", value: document.entries.length }]
  }),
  diff: diffDictionary
});
var LABEL9 = {
  added: "documentDiff.dictionary.added",
  removed: "documentDiff.dictionary.removed",
  reading: "documentDiff.dictionary.reading",
  variants: "documentDiff.dictionary.variants",
  note: "documentDiff.dictionary.note",
  readingsOn: "documentDiff.dictionary.readingsOn",
  readingsOff: "documentDiff.dictionary.readingsOff",
  variantsOn: "documentDiff.dictionary.variantsOn",
  variantsOff: "documentDiff.dictionary.variantsOff"
};
function diffDictionary(base, head, options) {
  const rows = [];
  for (const entry of diffKeyed(byTerm(base.entries), byTerm(head.entries))) {
    const path = ["entries", entry.key];
    const subject = authoredName(entry.key);
    if (!entry.base || !entry.head) {
      rows.push(change(path, entry.kind, entry.head ? LABEL9.added : LABEL9.removed, { subject }));
      continue;
    }
    if (!sameJsonValue(entry.base.reading, entry.head.reading)) {
      rows.push(change([...path, "reading"], presence5(entry.base.reading, entry.head.reading), LABEL9.reading, {
        params: fromToParams(entry.base.reading, entry.head.reading),
        subject
      }));
    }
    if (!sameJsonValue(entry.base.variants, entry.head.variants)) {
      rows.push(change([...path, "variants"], presence5(entry.base.variants, entry.head.variants), LABEL9.variants, {
        subject
      }));
    }
    if (!sameJsonValue(entry.base.note, entry.head.note)) {
      rows.push(change([...path, "note"], presence5(entry.base.note, entry.head.note), LABEL9.note, {
        params: fromToParams(entry.base.note, entry.head.note),
        subject
      }));
    }
  }
  if (base.options.suggestReadings !== head.options.suggestReadings) {
    rows.push(change(["options", "suggestReadings"], "changed", head.options.suggestReadings ? LABEL9.readingsOn : LABEL9.readingsOff));
  }
  if (base.options.checkVariants !== head.options.checkVariants) {
    rows.push(change(["options", "checkVariants"], "changed", head.options.checkVariants ? LABEL9.variantsOn : LABEL9.variantsOff));
  }
  return buildDocumentDiff(rows, { tier: "semantic", limit: options.limit });
}
function byTerm(entries) {
  const record = {};
  for (const entry of entries) {
    if (typeof entry?.term === "string" && entry.term.length > 0 && !Object.prototype.hasOwnProperty.call(record, entry.term)) {
      record[entry.term] = entry;
    }
  }
  return record;
}
function presence5(base, head) {
  if (base === void 0) {
    return "added";
  }
  return head === void 0 ? "removed" : "changed";
}

// ../NarraLeaf-Studio/src/shared/types/dlc.ts
var DLC_SCHEMA_VERSION = 1;
var DLC_ID_MAX_LENGTH = 48;
var DLC_ID_PATTERN = /^[a-z][a-z0-9_-]*$/;
function isValidDlcId(raw) {
  return typeof raw === "string" && raw.length > 0 && raw.length <= DLC_ID_MAX_LENGTH && DLC_ID_PATTERN.test(raw);
}
function normalizeDlcId(raw) {
  if (typeof raw !== "string") {
    return "";
  }
  const folded = raw.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "_").replace(/^[_-]+/, "").replace(/[_-]+$/, "").slice(0, DLC_ID_MAX_LENGTH);
  const trimmed = folded.replace(/[_-]+$/, "");
  return isValidDlcId(trimmed) ? trimmed : "";
}
function normalizeProjectDlc(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const record = raw;
  const id = normalizeDlcId(record.id);
  if (!id) {
    return null;
  }
  const name = typeof record.name === "string" ? record.name.trim() : "";
  const attachTo = typeof record.attachTo === "string" ? record.attachTo.trim() : "";
  return {
    id,
    // The id is a legal name and the only thing left to call it, so a blank one is shown rather
    // than leaving a row in the list with nothing in it.
    name: name || id,
    attachTo: attachTo ? migrateAppTagId(attachTo) : APP_TAG_ID_RELEASE
  };
}
function normalizeProjectDlcs(raw) {
  const source = Array.isArray(raw) ? raw : [];
  const byId2 = /* @__PURE__ */ new Map();
  for (const entry of source) {
    const dlc = normalizeProjectDlc(entry);
    if (dlc && !byId2.has(dlc.id)) {
      byId2.set(dlc.id, dlc);
    }
  }
  return [...byId2.values()];
}
function migrateProjectDlcDocument(raw) {
  const record = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const meta = record.meta && typeof record.meta === "object" && !Array.isArray(record.meta) ? record.meta : void 0;
  return {
    schemaVersion: DLC_SCHEMA_VERSION,
    dlcs: normalizeProjectDlcs(record.dlcs),
    ...meta ? { meta } : {}
  };
}

// ../NarraLeaf-Studio/src/shared/documents/specs/dlc.ts
var DLC_DOCUMENT_PATH = "editor/dlc.json";
var dlcSpec = defineDocumentSpec({
  kind: "dlc",
  version: DLC_SCHEMA_VERSION,
  paths: [DLC_DOCUMENT_PATH],
  parse: (raw, context) => {
    const record = requireDocumentObject(raw, context, "a DLC list");
    rejectNewerSchema(record, context, DLC_SCHEMA_VERSION);
    if (record.dlcs !== void 0 && !Array.isArray(record.dlcs)) {
      context.corrupt(`"dlcs" must be an array, got ${typeof record.dlcs}`);
    }
    return migrateProjectDlcDocument(record);
  },
  // No authored name: there is one of these per project and the history UI labels it by kind.
  summarize: (document) => ({
    title: "",
    counts: [{ key: "dlc", value: document.dlcs.length }]
  })
});

// ../NarraLeaf-Studio/src/shared/documents/specs/localization.ts
var LOCALIZATION_DOCUMENT_PATH = "editor/localization/<locale>.json";
var LOCALIZATION_DOCUMENT_PATTERN = compileDocumentPathPattern(LOCALIZATION_DOCUMENT_PATH);
var LABEL10 = {
  added: "documentDiff.localization.added",
  removed: "documentDiff.localization.removed",
  changed: "documentDiff.localization.changed",
  note: "documentDiff.localization.note",
  source: "documentDiff.localization.source"
};
var STATUS_LABEL = {
  untranslated: "documentDiff.localization.statusUntranslated",
  machine: "documentDiff.localization.statusMachine",
  translated: "documentDiff.localization.statusTranslated",
  reviewed: "documentDiff.localization.statusReviewed"
};
var localizationDocumentSpec = defineDocumentSpec({
  kind: "localization",
  version: LOCALIZATION_DOCUMENT_SCHEMA_VERSION,
  paths: [LOCALIZATION_DOCUMENT_PATH],
  parse: (raw, context) => {
    const locale = parameterFromPath(LOCALIZATION_DOCUMENT_PATTERN, "locale", context);
    const record = requireDocumentObject(raw, context, "a translation library");
    rejectNewerSchema(record, context, LOCALIZATION_DOCUMENT_SCHEMA_VERSION);
    requireOptionalMap(record, "units", context);
    return normalizeLocalizationDocument(record, locale);
  },
  summarize: (document) => ({
    title: document.locale,
    counts: [{ key: "translationUnits", value: Object.keys(document.units).length }]
  }),
  diff: diffLocalization,
  merge3: merge3Localization
});
function merge3Localization(base, mine, theirs) {
  const units = mergeKeyed(base?.units, mine.units, theirs.units);
  const decisions = units.rows.map((row) => (
    // Labelled but with no `subject`, and the omission is the deliberate half: the unit id is a
    // story text id or a `key:`/`char:` handle, none of which the author typed, and `subject` is
    // defined as the author's own word. What they recognise a row by is the two translations
    // beside it, which is what {@link DocumentMergeSide.value} carries.
    decision(["units", row.key], row, { label: keyedRowLabel(row, LABEL10) })
  ));
  return {
    document: {
      schemaVersion: mine.schemaVersion,
      locale: mine.locale,
      units: units.merged
    },
    decisions,
    conflicts: countConflicts(decisions)
  };
}
function diffLocalization(base, head, options) {
  const rows = [];
  for (const entry of diffKeyed(base.units, head.units)) {
    const path = ["units", entry.key];
    const subject = previewValue(entry.head?.target) ?? previewValue(entry.base?.target);
    if (!entry.base || !entry.head) {
      const present = entry.head ?? entry.base;
      rows.push(change(path, entry.kind, entry.head ? LABEL10.added : LABEL10.removed, {
        params: entry.head ? { to: quoted(present.target) } : { from: quoted(present.target) },
        subject
      }));
      continue;
    }
    const retranslated = entry.base.target !== entry.head.target;
    if (retranslated) {
      rows.push(change(path, "changed", LABEL10.changed, {
        params: { from: quoted(entry.base.target), to: quoted(entry.head.target) },
        subject
      }));
    }
    const statusLabel = STATUS_LABEL[entry.head.status];
    if (statusLabel && entry.base.status !== entry.head.status) {
      rows.push(change([...path, "status"], "changed", statusLabel, { subject }));
    }
    if (!sameJsonValue(entry.base.note, entry.head.note)) {
      rows.push(change([...path, "note"], presence6(entry.base.note, entry.head.note), LABEL10.note, {
        params: fromToParams(entry.base.note, entry.head.note),
        subject
      }));
    }
    if (!retranslated && entry.base.sourceHash !== entry.head.sourceHash) {
      rows.push(change([...path, "source"], "changed", LABEL10.source, { subject }));
    }
  }
  return buildDocumentDiff(rows, { tier: "semantic", limit: options.limit });
}
function quoted(target) {
  return previewValue(target) ?? "";
}
function presence6(base, head) {
  if (base === void 0) {
    return "added";
  }
  return head === void 0 ? "removed" : "changed";
}

// ../NarraLeaf-Studio/src/shared/documents/specs/localizationKeys.ts
var LOCALIZATION_KEYS_DOCUMENT_PATH = "editor/localization/keys.json";
var localizationKeysSpec = defineDocumentSpec({
  kind: "localization-keys",
  version: LOCALIZATION_KEYS_SCHEMA_VERSION,
  paths: [LOCALIZATION_KEYS_DOCUMENT_PATH],
  parse: (raw, context) => {
    const record = requireDocumentObject(raw, context, "a localization key registry");
    rejectNewerSchema(record, context, LOCALIZATION_KEYS_SCHEMA_VERSION);
    requireOptionalMap(record, "keys", context);
    return normalizeLocalizationKeysDocument(record);
  },
  summarize: (document) => ({
    title: "",
    counts: [{ key: "localizationKeys", value: Object.keys(document.keys).length }]
  }),
  merge3: merge3LocalizationKeys
});
var LABEL11 = {
  added: "documentDiff.localizationKeys.added",
  removed: "documentDiff.localizationKeys.removed",
  changed: "documentDiff.localizationKeys.changed"
};
function merge3LocalizationKeys(base, mine, theirs) {
  const keys = mergeKeyed(base?.keys, mine.keys, theirs.keys);
  const decisions = keys.rows.map((row) => decision(["keys", row.key], row, {
    label: keyedRowLabel(row, LABEL11),
    // The key itself, which is the rare case where the map's key IS the author's word for
    // the row: `menu.start` was typed by whoever declared it.
    subject: row.key
  }));
  return {
    document: { schemaVersion: mine.schemaVersion, keys: keys.merged },
    decisions,
    conflicts: countConflicts(decisions)
  };
}

// ../NarraLeaf-Studio/src/shared/types/ui-editor/widgetInheritance.ts
var WIDGET_TYPE_PARENTS = {
  "nl.dialog.sentence": "nl.text",
  "nl.nvl.texts": "nl.text",
  "nl.notification.list": "nl.list",
  "nl.choice.list": "nl.list",
  "nl.nvl.list": "nl.list"
};
function walkWidgetTypeChain(parents, type) {
  if (!type) {
    return [];
  }
  const chain = [];
  const seen = /* @__PURE__ */ new Set();
  let current = type;
  while (current && !seen.has(current)) {
    seen.add(current);
    chain.push(current);
    current = parents[current];
  }
  return chain;
}
function getWidgetTypeChain(type) {
  return walkWidgetTypeChain(WIDGET_TYPE_PARENTS, type);
}
function isWidgetTypeOf(type, base) {
  return getWidgetTypeChain(type).includes(base);
}
function listWidgetTypesOf(base) {
  const types = [base];
  for (const [child] of Object.entries(WIDGET_TYPE_PARENTS)) {
    if (child !== base && isWidgetTypeOf(child, base)) {
      types.push(child);
    }
  }
  return types;
}

// ../NarraLeaf-Studio/src/shared/types/ui-editor/list.ts
var UI_LIST_LIKE_WIDGET_TYPES = listWidgetTypesOf("nl.list");
var UI_LIST_SCROLL_METRICS_AT_REST = Object.freeze({ offset: 0, maxOffset: 0, progress: 1 });

// ../NarraLeaf-Studio/src/shared/types/ui-editor/document.ts
var UI_DOCUMENT_SCHEMA_VERSION = 14;
var UI_PARENT_CAPABLE_ELEMENT_TYPES = /* @__PURE__ */ new Set(["nl.root", "nl.container", "nl.button", "nl.slider", "nl.switch", ...UI_LIST_LIKE_WIDGET_TYPES]);
var UI_USER_CHILD_PARENT_ELEMENT_TYPES = /* @__PURE__ */ new Set(["nl.root", "nl.container", "nl.button", ...UI_LIST_LIKE_WIDGET_TYPES]);

// ../NarraLeaf-Studio/src/shared/constants/ui-editor.ts
var MAIN_APP_SURFACE_ID = "narraleaf-studio:main-surface";

// ../NarraLeaf-Studio/src/shared/types/ui-editor/entrySurface.ts
function resolveEntrySurface(document) {
  const pages = (document?.surfaces ?? []).filter(isAppSurface);
  const named = typeof document?.entrySurfaceId === "string" && document.entrySurfaceId ? pages.find((surface) => surface.id === document.entrySurfaceId) : void 0;
  return named ?? pages.find((surface) => surface.id === MAIN_APP_SURFACE_ID) ?? pages[0];
}
function isAppSurface(surface) {
  return surface.kind === "appSurface";
}

// ../NarraLeaf-Studio/src/shared/documents/specs/uiDocumentDiff.ts
var LABEL12 = {
  renamed: "documentDiff.uiDocument.renamed",
  entryPage: "documentDiff.uiDocument.entryPage",
  surfaceAdded: "documentDiff.uiDocument.surfaceAdded",
  surfaceRemoved: "documentDiff.uiDocument.surfaceRemoved",
  surfaceChanged: "documentDiff.uiDocument.surfaceChanged",
  surfaceRenamed: "documentDiff.uiDocument.surfaceRenamed",
  surfaceDesignSize: "documentDiff.uiDocument.surfaceDesignSize",
  surfaceSettings: "documentDiff.uiDocument.surfaceSettings",
  surfaceRoot: "documentDiff.uiDocument.surfaceRoot",
  surfaceField: "documentDiff.uiDocument.surfaceField",
  componentAdded: "documentDiff.uiDocument.componentAdded",
  componentRemoved: "documentDiff.uiDocument.componentRemoved",
  componentChanged: "documentDiff.uiDocument.componentChanged",
  componentRenamed: "documentDiff.uiDocument.componentRenamed",
  componentField: "documentDiff.uiDocument.componentField",
  elementAdded: "documentDiff.uiDocument.elementAdded",
  elementRemoved: "documentDiff.uiDocument.elementRemoved",
  elementChanged: "documentDiff.uiDocument.elementChanged",
  elementRenamed: "documentDiff.uiDocument.elementRenamed",
  elementType: "documentDiff.uiDocument.elementType",
  elementMoved: "documentDiff.uiDocument.elementMoved",
  elementOrder: "documentDiff.uiDocument.elementOrder",
  elementLayout: "documentDiff.uiDocument.elementLayout",
  elementStyle: "documentDiff.uiDocument.elementStyle",
  elementProps: "documentDiff.uiDocument.elementProps",
  elementBinding: "documentDiff.uiDocument.elementBinding",
  elementAnimation: "documentDiff.uiDocument.elementAnimation",
  elementField: "documentDiff.uiDocument.elementField"
};
var SURFACE_FIELDS = ["host", "kind", "mount", "slots"];
var ELEMENT_PROPERTIES = [
  { key: "layout", label: LABEL12.elementLayout },
  { key: "style", label: LABEL12.elementStyle },
  { key: "props", label: LABEL12.elementProps },
  { key: "valueBindings", label: LABEL12.elementBinding },
  { key: "animation", label: LABEL12.elementAnimation }
];
var ELEMENT_FIELDS = ["extra"];
var COMPONENT_FIELDS = ["rootElementId", "params", "previewMeta"];
function diffUIDocument(base, head, options) {
  const left = indexDocument(base);
  const right = indexDocument(head);
  const order = readingOrder(left, right);
  const rows = new RankedRows(order);
  if (!sameJsonValue(base?.name, head?.name)) {
    rows.push(DOCUMENT_SLOT, change(["name"], "changed", LABEL12.renamed, {
      params: fromToParams(base?.name, head?.name),
      subject: authoredName(head?.name)
    }));
  }
  if (!sameJsonValue(base?.entrySurfaceId ?? null, head?.entrySurfaceId ?? null)) {
    const from = readEntrySurface(base);
    const to = readEntrySurface(head);
    rows.push(DOCUMENT_SLOT, change(["entrySurfaceId"], "changed", LABEL12.entryPage, {
      params: fromToParams(authoredName(from?.name), authoredName(to?.name)),
      subject: authoredName(to?.name)
    }));
  }
  const gone = surfaceRows(left, right, rows);
  componentRows(left, right, rows);
  elementRows(left, right, rows, gone);
  return buildDocumentDiff(rows.sorted(), { tier: "semantic", limit: options.limit });
}
function surfaceRows(left, right, rows) {
  const added = /* @__PURE__ */ new Set();
  const removed = /* @__PURE__ */ new Set();
  for (const entry of diffKeyed(left.surfaces, right.surfaces)) {
    const path = ["surfaces", entry.key];
    const slot = surfaceSlot(entry.key);
    if (!entry.base || !entry.head) {
      const present = entry.head ?? entry.base;
      const side2 = entry.head ? right : left;
      (entry.head ? added : removed).add(entry.key);
      rows.push(slot, change(path, entry.kind, entry.head ? LABEL12.surfaceAdded : LABEL12.surfaceRemoved, {
        subject: authoredName(present?.name),
        params: { elements: (side2.treeOf.get(entry.key) ?? []).length }
      }));
      continue;
    }
    const subject = authoredName(entry.head.name) ?? authoredName(entry.base.name);
    const children = surfaceLeaves(path, entry.base, entry.head, subject);
    rows.push(slot, change(path, "changed", LABEL12.surfaceChanged, { subject, children }));
  }
  return { added, removed };
}
function surfaceLeaves(path, base, head, subject) {
  const leaves = [];
  if (!sameJsonValue(base.name, head.name)) {
    leaves.push(change([...path, "name"], "changed", LABEL12.surfaceRenamed, {
      params: fromToParams(base.name, head.name),
      subject: authoredName(head.name) ?? subject
    }));
  }
  if (!sameJsonValue(base.designSize, head.designSize)) {
    const size = designSizeParams(base.designSize, head.designSize);
    leaves.push(size ? change([...path, "designSize"], "changed", LABEL12.surfaceDesignSize, { params: size, subject }) : change([...path, "designSize"], "changed", LABEL12.surfaceField, { params: { field: "designSize" }, subject }));
  }
  if (!sameJsonValue(base.rootElementId, head.rootElementId)) {
    leaves.push(change([...path, "rootElementId"], "changed", LABEL12.surfaceRoot, { subject }));
  }
  if (!sameJsonValue(base.settings, head.settings)) {
    leaves.push(change([...path, "settings"], "changed", LABEL12.surfaceSettings, { subject }));
  }
  for (const field of SURFACE_FIELDS) {
    const was = base[field];
    const now = head[field];
    if (!sameJsonValue(was, now)) {
      leaves.push(change([...path, field], "changed", LABEL12.surfaceField, { params: { field }, subject }));
    }
  }
  return leaves;
}
function componentRows(left, right, rows) {
  for (const entry of diffKeyed(left.components, right.components)) {
    const path = ["components", entry.key];
    const slot = componentSlot(entry.key);
    if (!entry.base || !entry.head) {
      const present = entry.head ?? entry.base;
      rows.push(slot, change(path, entry.kind, entry.head ? LABEL12.componentAdded : LABEL12.componentRemoved, {
        subject: authoredName(present?.name),
        params: { elements: Object.keys(elementsOf(present)).length }
      }));
      continue;
    }
    const subject = authoredName(entry.head.name) ?? authoredName(entry.base.name);
    const children = [];
    if (!sameJsonValue(entry.base.name, entry.head.name)) {
      children.push(change([...path, "name"], "changed", LABEL12.componentRenamed, {
        params: fromToParams(entry.base.name, entry.head.name),
        subject: authoredName(entry.head.name) ?? subject
      }));
    }
    for (const field of COMPONENT_FIELDS) {
      const was = entry.base[field];
      const now = entry.head[field];
      if (!sameJsonValue(was, now)) {
        children.push(change([...path, field], "changed", LABEL12.componentField, { params: { field }, subject }));
      }
    }
    if (children.length > 0) {
      rows.push(slot, change(path, "changed", LABEL12.componentChanged, { subject, children }));
    }
    const shared = sharedKeys(elementsOf(entry.base), elementsOf(entry.head));
    for (const element of diffKeyed(elementsOf(entry.base), elementsOf(entry.head))) {
      rows.push(
        componentElementSlot(entry.key, element.key),
        elementRow(["components", entry.key, "elements", element.key], element.base, element.head, shared)
      );
    }
  }
}
function elementRows(left, right, rows, gone) {
  const shared = sharedKeys(left.elements, right.elements);
  for (const entry of diffKeyed(left.elements, right.elements)) {
    const owner = right.surfaceOf.get(entry.key) ?? left.surfaceOf.get(entry.key);
    if (entry.head && !entry.base && owner !== void 0 && gone.added.has(owner)) {
      continue;
    }
    if (entry.base && !entry.head && owner !== void 0 && gone.removed.has(owner)) {
      continue;
    }
    const path = owner === void 0 ? ["elements", entry.key] : ["surfaces", owner, "elements", entry.key];
    rows.push(elementSlot(entry.key), elementRow(path, entry.base, entry.head, shared));
  }
}
function elementRow(path, base, head, shared) {
  if (!base || !head) {
    const present = head ?? base;
    return change(path, head ? "added" : "removed", head ? LABEL12.elementAdded : LABEL12.elementRemoved, {
      subject: authoredName(present?.name)
    });
  }
  const subject = authoredName(head.name) ?? authoredName(base.name);
  return change(path, "changed", LABEL12.elementChanged, {
    subject,
    children: elementLeaves(path, base, head, subject, shared)
  });
}
function elementLeaves(path, base, head, subject, shared) {
  const leaves = [];
  if (!sameJsonValue(base.name, head.name)) {
    leaves.push(change([...path, "name"], "changed", LABEL12.elementRenamed, {
      params: fromToParams(base.name, head.name),
      subject: authoredName(head.name) ?? subject
    }));
  }
  if (!sameJsonValue(base.type, head.type)) {
    leaves.push(change([...path, "type"], "changed", LABEL12.elementType, {
      params: fromToParams(base.type, head.type),
      subject
    }));
  }
  if (!sameJsonValue(base.parentId, head.parentId)) {
    leaves.push(change([...path, "parentId"], "moved", LABEL12.elementMoved, { subject }));
  }
  const wasChildren = childIdsIn(base, shared);
  const nowChildren = childIdsIn(head, shared);
  if (!sameJsonValue(wasChildren, nowChildren)) {
    leaves.push(change([...path, "childrenIds"], "moved", LABEL12.elementOrder, { subject }));
  }
  for (const property of ELEMENT_PROPERTIES) {
    const was = base[property.key];
    const now = head[property.key];
    if (!sameJsonValue(was, now)) {
      leaves.push(change([...path, property.key], "changed", property.label, { subject }));
    }
  }
  for (const field of ELEMENT_FIELDS) {
    const was = base[field];
    const now = head[field];
    if (!sameJsonValue(was, now)) {
      leaves.push(change([...path, field], "changed", LABEL12.elementField, { params: { field }, subject }));
    }
  }
  return leaves;
}
function indexDocument(document) {
  const surfaceList = Array.isArray(document?.surfaces) ? document?.surfaces : [];
  const componentList = Array.isArray(document?.components) ? document?.components : [];
  const surfaces = byId(surfaceList);
  const components = byId(componentList);
  const elements = isJsonObject(document?.elements) ? document?.elements : {};
  const surfaceOf = /* @__PURE__ */ new Map();
  const treeOf = /* @__PURE__ */ new Map();
  const surfaceOrder = surfaceList.map((surface) => surface?.id).filter((id) => typeof id === "string" && Object.prototype.hasOwnProperty.call(surfaces, id));
  for (const surfaceId of surfaceOrder) {
    const tree = walkTree(elements, surfaces[surfaceId]?.rootElementId, surfaceOf.has.bind(surfaceOf));
    treeOf.set(surfaceId, tree);
    for (const elementId of tree) {
      surfaceOf.set(elementId, surfaceId);
    }
  }
  const componentTreeOf = /* @__PURE__ */ new Map();
  const componentOrder = componentList.map((component) => component?.id).filter((id) => typeof id === "string" && Object.prototype.hasOwnProperty.call(components, id));
  for (const componentId of componentOrder) {
    const own = elementsOf(components[componentId]);
    componentTreeOf.set(componentId, walkTree(own, components[componentId]?.rootElementId, () => false));
  }
  const orphans = Object.keys(elements).filter((id) => !surfaceOf.has(id)).sort();
  return { surfaces, surfaceOrder, components, componentOrder, elements, surfaceOf, treeOf, componentTreeOf, orphans };
}
function walkTree(elements, rootId, claimed) {
  if (typeof rootId !== "string" || rootId.length === 0) {
    return [];
  }
  const out = [];
  const seen = /* @__PURE__ */ new Set();
  const stack = [rootId];
  while (stack.length > 0) {
    const id = stack.pop();
    if (seen.has(id) || claimed(id) || !Object.prototype.hasOwnProperty.call(elements, id)) {
      continue;
    }
    seen.add(id);
    out.push(id);
    const children = elements[id]?.childrenIds;
    if (Array.isArray(children)) {
      for (let index = children.length - 1; index >= 0; index -= 1) {
        const child = children[index];
        if (typeof child === "string") {
          stack.push(child);
        }
      }
    }
  }
  return out;
}
function readEntrySurface(document) {
  const surfaces = Array.isArray(document?.surfaces) ? document.surfaces.filter(isJsonObject) : [];
  const stored = document?.entrySurfaceId;
  return resolveEntrySurface({ surfaces, entrySurfaceId: typeof stored === "string" ? stored : void 0 });
}
function elementsOf(component) {
  const elements = component?.elements;
  return isJsonObject(elements) ? elements : {};
}
function childIdsIn(element, shared) {
  const children = element?.childrenIds;
  return Array.isArray(children) ? children.filter((id) => typeof id === "string" && shared.has(id)) : [];
}
function sharedKeys(base, head) {
  return new Set(Object.keys(head).filter((key) => Object.prototype.hasOwnProperty.call(base, key)));
}
function designSizeParams(base, head) {
  const was = base;
  const now = head;
  const numbers = [was?.width, was?.height, now?.width, now?.height];
  if (!numbers.every((value) => typeof value === "number" && Number.isFinite(value))) {
    return void 0;
  }
  const [fromWidth, fromHeight, toWidth, toHeight] = numbers;
  return { fromWidth, fromHeight, toWidth, toHeight };
}
var SLOT_SEPARATOR = String.fromCharCode(1);
var DOCUMENT_SLOT = "";
var surfaceSlot = (surfaceId) => `s${SLOT_SEPARATOR}${surfaceId}`;
var elementSlot = (elementId) => `e${SLOT_SEPARATOR}${elementId}`;
var componentSlot = (componentId) => `c${SLOT_SEPARATOR}${componentId}`;
var componentElementSlot = (componentId, elementId) => `x${SLOT_SEPARATOR}${componentId}${SLOT_SEPARATOR}${elementId}`;
function readingOrder(left, right) {
  const order = /* @__PURE__ */ new Map();
  const at = (slot) => {
    if (!order.has(slot)) {
      order.set(slot, order.size);
    }
  };
  at(DOCUMENT_SLOT);
  for (const side2 of [right, left]) {
    for (const surfaceId of side2.surfaceOrder) {
      at(surfaceSlot(surfaceId));
      for (const elementId of side2.treeOf.get(surfaceId) ?? []) {
        at(elementSlot(elementId));
      }
    }
    for (const componentId of side2.componentOrder) {
      at(componentSlot(componentId));
      for (const elementId of side2.componentTreeOf.get(componentId) ?? []) {
        at(componentElementSlot(componentId, elementId));
      }
      for (const elementId of Object.keys(elementsOf(side2.components[componentId])).sort()) {
        at(componentElementSlot(componentId, elementId));
      }
    }
    for (const elementId of side2.orphans) {
      at(elementSlot(elementId));
    }
  }
  return order;
}
var RankedRows = class {
  constructor(order) {
    this.order = order;
  }
  entries = [];
  push(slot, row) {
    this.entries.push({
      row,
      rank: this.order.get(slot) ?? Number.MAX_SAFE_INTEGER,
      built: this.entries.length
    });
  }
  /** Build order is the tie-break, so rows sharing a slot keep the order they were produced in. */
  sorted() {
    return [...this.entries].sort((a, b) => a.rank - b.rank || a.built - b.built).map((entry) => entry.row);
  }
};

// ../NarraLeaf-Studio/src/shared/documents/specs/uiDocument.ts
var UI_DOCUMENT_PATH = "editor/ui/uidoc.json";
var uiDocumentSpec = defineDocumentSpec({
  kind: "ui-document",
  version: UI_DOCUMENT_SCHEMA_VERSION,
  paths: [UI_DOCUMENT_PATH],
  parse: (raw, context) => {
    const record = requireDocumentObject(raw, context, "an interface document");
    rejectNewerSchema(record, context, UI_DOCUMENT_SCHEMA_VERSION);
    if (record.surfaces !== void 0 && !Array.isArray(record.surfaces)) {
      return context.corrupt(`"surfaces" must be an array, got ${describe5(record.surfaces)}`);
    }
    if (record.components !== void 0 && !Array.isArray(record.components)) {
      return context.corrupt(`"components" must be an array, got ${describe5(record.components)}`);
    }
    requireOptionalMap(record, "elements", context);
    return record;
  },
  /** Refused; see the note at the top of this module for what has to land before it can write. */
  serialize: () => {
    throw new Error(
      "The ui-document spec is read-only in this build: `parse` does not run the interface migration (it lives in the renderer's UIDocumentService), so serializing would write back a document that was never migrated. Use UIDocumentService to save the interface."
    );
  },
  summarize: (document) => ({
    title: typeof document.name === "string" ? document.name : "",
    counts: [
      { key: "uiSurfaces", value: Array.isArray(document.surfaces) ? document.surfaces.length : 0 },
      { key: "uiComponents", value: Array.isArray(document.components) ? document.components.length : 0 },
      { key: "uiElements", value: countElements(document) }
    ]
  }),
  diff: diffUIDocument
  // No `merge3`. See the note at the foot of `uiDocumentDiff.ts` for why refusing is the answer
  // rather than a gap: two authors who both rearranged one Surface's tree cannot be merged into a
  // layout either of them wrote, and the first tier - take one side's whole file - is honest.
});
function countElements(document) {
  let total = isJsonObject(document.elements) ? Object.keys(document.elements).length : 0;
  for (const component of Array.isArray(document.components) ? document.components : []) {
    const elements = component?.elements;
    if (isJsonObject(elements)) {
      total += Object.keys(elements).length;
    }
  }
  return total;
}
function describe5(value) {
  if (value === null) {
    return "null";
  }
  return Array.isArray(value) ? "an array" : `a ${typeof value}`;
}

// ../NarraLeaf-Studio/src/shared/types/blueprint/schema.ts
var BLUEPRINT_DOCUMENT_SCHEMA_VERSION = 14;

// ../NarraLeaf-Studio/src/shared/types/ui-editor/graph.ts
var UI_GRAPH_DOCUMENT_SCHEMA_VERSION = 2;

// ../NarraLeaf-Studio/src/shared/documents/specs/uiGraphsDiff.ts
var LABEL13 = {
  ownerRecord: "documentDiff.uiGraphs.ownerRecord",
  blueprintAdded: "documentDiff.uiGraphs.blueprintAdded",
  blueprintRemoved: "documentDiff.uiGraphs.blueprintRemoved",
  blueprintChanged: "documentDiff.uiGraphs.blueprintChanged",
  blueprintRenamed: "documentDiff.uiGraphs.blueprintRenamed",
  blueprintSource: "documentDiff.uiGraphs.blueprintSource",
  scriptAdded: "documentDiff.uiGraphs.scriptAdded",
  scriptRemoved: "documentDiff.uiGraphs.scriptRemoved",
  scriptChanged: "documentDiff.uiGraphs.scriptChanged",
  blueprintField: "documentDiff.uiGraphs.blueprintField",
  graphAdded: "documentDiff.uiGraphs.graphAdded",
  graphRemoved: "documentDiff.uiGraphs.graphRemoved",
  graphChanged: "documentDiff.uiGraphs.graphChanged",
  graphRenamed: "documentDiff.uiGraphs.graphRenamed",
  graphField: "documentDiff.uiGraphs.graphField",
  graphOrder: "documentDiff.uiGraphs.graphOrder",
  nodeAdded: "documentDiff.uiGraphs.nodeAdded",
  nodeRemoved: "documentDiff.uiGraphs.nodeRemoved",
  nodeChanged: "documentDiff.uiGraphs.nodeChanged",
  nodeParams: "documentDiff.uiGraphs.nodeParams",
  nodeMoved: "documentDiff.uiGraphs.nodeMoved",
  nodeType: "documentDiff.uiGraphs.nodeType",
  nodeField: "documentDiff.uiGraphs.nodeField",
  edgeAdded: "documentDiff.uiGraphs.edgeAdded",
  edgeRemoved: "documentDiff.uiGraphs.edgeRemoved"
};
var NODE_POSITION_KEY = "editorLayout";
var GRAPH_SLOTS = ["events", "functions", "macros"];
var BLUEPRINT_FIELDS = ["owner", "members", "bindings", "meta"];
var ORDER_KEY = {
  events: "eventIds",
  functions: "functionIds",
  macros: void 0
};
var GRAPH_FIELDS_NOT_REPORTED = /* @__PURE__ */ new Set(["id", "name", "graph", "script", "nodes", "edges"]);
function diffUIGraphs(base, head, options) {
  const rows = [];
  for (const entry of sortedByName(diffKeyed(blueprintsOf(base), blueprintsOf(head)))) {
    blueprintRows(entry.key, entry.base, entry.head, rows);
  }
  for (const entry of diffKeyed(ownerRecordsOf(base), ownerRecordsOf(head))) {
    rows.push(change(["ownerRecords", entry.key], entry.kind, LABEL13.ownerRecord));
  }
  return buildDocumentDiff(rows, { tier: "semantic", limit: options.limit });
}
function countGraphNodes(document) {
  let total = 0;
  for (const blueprint of Object.values(blueprintsOf(document))) {
    for (const slot of GRAPH_SLOTS) {
      for (const graph of Object.values(graphSlot(blueprint, slot))) {
        total += Object.keys(nodesOf(irOf(graph))).length;
      }
    }
  }
  return total;
}
function blueprintRows(blueprintId, base, head, rows) {
  const path = ["blueprints", blueprintId];
  if (!base || !head) {
    const present = head ?? base;
    rows.push(change(
      path,
      head ? "added" : "removed",
      head ? LABEL13.blueprintAdded : LABEL13.blueprintRemoved,
      {
        subject: authoredName(present?.name),
        // One row for a whole blueprint, with its size in the label rather than a row per node:
        // the change the author made is "I wrote this piece of logic". Script layers count for
        // nothing here - their text is not in this document - and the layer rows name them.
        params: { nodes: blueprintNodeCount(present) }
      }
    ));
    return;
  }
  const subject = authoredName(head.name) ?? authoredName(base.name);
  const children = [];
  if (!sameJsonValue(base.name, head.name)) {
    children.push(change([...path, "name"], "changed", LABEL13.blueprintRenamed, {
      params: fromToParams(base.name, head.name),
      subject: authoredName(head.name) ?? subject
    }));
  }
  for (const field of BLUEPRINT_FIELDS) {
    if (!sameJsonValue(base[field], head[field])) {
      children.push(change([...path, field], "changed", LABEL13.blueprintField, { params: { field }, subject }));
    }
  }
  if (children.length > 0) {
    rows.push(change(path, "changed", LABEL13.blueprintChanged, { subject, children }));
  }
  for (const slot of GRAPH_SLOTS) {
    const wasGraphs = graphSlot(base, slot);
    const nowGraphs = graphSlot(head, slot);
    const byKey2 = new Map(diffKeyed(wasGraphs, nowGraphs).map((entry) => [entry.key, entry]));
    for (const graphId of graphOrder(graphIndexOf(base), graphIndexOf(head), slot, byKey2)) {
      const entry = byKey2.get(graphId);
      if (entry) {
        graphRows([...path, slot, graphId], entry.base, entry.head, rows);
      }
    }
    const shared = new Set(Object.keys(nowGraphs).filter((id) => Object.prototype.hasOwnProperty.call(wasGraphs, id)));
    const orderKey = ORDER_KEY[slot];
    if (orderKey && !sameJsonValue(
      declaredOrder(graphIndexOf(base), orderKey, shared),
      declaredOrder(graphIndexOf(head), orderKey, shared)
    )) {
      rows.push(change([...path, orderKey], "moved", LABEL13.graphOrder, { subject }));
    }
  }
}
function graphRows(path, base, head, rows) {
  if (!base || !head) {
    const present = head ?? base;
    const script = isScriptLayer(present);
    rows.push(change(path, head ? "added" : "removed", script ? head ? LABEL13.scriptAdded : LABEL13.scriptRemoved : head ? LABEL13.graphAdded : LABEL13.graphRemoved, {
      subject: authoredName(present?.name) ?? sourceOf(present),
      params: script ? {} : { nodes: Object.keys(nodesOf(irOf(present))).length }
    }));
    return;
  }
  const subject = authoredName(head.name) ?? authoredName(base.name);
  const children = [];
  if (!sameJsonValue(base.name, head.name)) {
    children.push(change([...path, "name"], "changed", LABEL13.graphRenamed, {
      params: fromToParams(base.name, head.name),
      subject: authoredName(head.name) ?? subject
    }));
  }
  if (!sameJsonValue(sourceOf(base), sourceOf(head))) {
    children.push(change([...path, "source"], "changed", LABEL13.blueprintSource, { subject }));
  }
  const wasFields = graphFields(base);
  const nowFields = graphFields(head);
  for (const field of [.../* @__PURE__ */ new Set([...Object.keys(wasFields), ...Object.keys(nowFields)])].sort()) {
    if (!sameJsonValue(wasFields[field], nowFields[field])) {
      children.push(change([...path, field], "changed", LABEL13.graphField, { params: { field }, subject }));
    }
  }
  if (children.length > 0) {
    rows.push(change(path, "changed", isScriptLayer(head) ? LABEL13.scriptChanged : LABEL13.graphChanged, { subject, children }));
  }
  const wasNodes = nodesOf(irOf(base));
  const nowNodes = nodesOf(irOf(head));
  const entries = diffKeyed(wasNodes, nowNodes);
  for (const entry of sortedByPosition(entries)) {
    nodeRows([...path, "nodes", entry.key], entry.base, entry.head, rows);
  }
  edgeRows(path, irOf(base), irOf(head), wasNodes, nowNodes, rows);
}
function nodeRows(path, base, head, rows) {
  if (!base || !head) {
    rows.push(change(path, head ? "added" : "removed", head ? LABEL13.nodeAdded : LABEL13.nodeRemoved));
    return;
  }
  const children = [];
  if (!sameJsonValue(base.params, head.params)) {
    children.push(change([...path, "params"], "changed", LABEL13.nodeParams));
  }
  if (!sameJsonValue(positionOf(base), positionOf(head))) {
    children.push(change([...path, NODE_POSITION_KEY], "moved", LABEL13.nodeMoved));
  }
  if (!sameJsonValue(base.type, head.type)) {
    children.push(change([...path, "type"], "changed", LABEL13.nodeType, {
      params: fromToParams(base.type, head.type)
    }));
  }
  if (!sameJsonValue(base.ports, head.ports)) {
    children.push(change([...path, "ports"], "changed", LABEL13.nodeField, { params: { field: "ports" } }));
  }
  if (!sameJsonValue(metaWithoutPosition(base), metaWithoutPosition(head))) {
    children.push(change([...path, "meta"], "changed", LABEL13.nodeField, { params: { field: "meta" } }));
  }
  rows.push(change(path, "changed", LABEL13.nodeChanged, { children }));
}
function edgeRows(path, base, head, baseNodes, headNodes, rows) {
  const shared = (id) => typeof id === "string" && Object.prototype.hasOwnProperty.call(baseNodes, id) && Object.prototype.hasOwnProperty.call(headNodes, id);
  const keysOf = (graph) => {
    const keys = /* @__PURE__ */ new Set();
    for (const edge of Array.isArray(graph.edges) ? graph.edges : []) {
      const from = edge?.from;
      const to = edge?.to;
      if (shared(from?.nodeId) && shared(to?.nodeId)) {
        keys.add(`${text(from?.nodeId)}:${text(from?.port)}->${text(to?.nodeId)}:${text(to?.port)}`);
      }
    }
    return keys;
  };
  const was = keysOf(base);
  const now = keysOf(head);
  for (const key of [.../* @__PURE__ */ new Set([...was, ...now])].sort()) {
    if (was.has(key) === now.has(key)) {
      continue;
    }
    rows.push(change(
      [...path, "edges", key],
      now.has(key) ? "added" : "removed",
      now.has(key) ? LABEL13.edgeAdded : LABEL13.edgeRemoved
    ));
  }
}
function blueprintsOf(document) {
  return mapOf(document?.blueprintDocument?.blueprints);
}
function ownerRecordsOf(document) {
  return mapOf(document?.blueprintDocument?.ownerRecords);
}
function graphIndexOf(blueprint) {
  const graphs = blueprint?.graphs;
  return isJsonObject(graphs) ? graphs : {};
}
function graphSlot(blueprint, slot) {
  return mapOf(graphIndexOf(blueprint)[slot]);
}
function graphFields(graph) {
  const out = {};
  for (const [key, value] of Object.entries(graph)) {
    if (!GRAPH_FIELDS_NOT_REPORTED.has(key)) {
      out[key] = value;
    }
  }
  const ir = irOf(graph);
  if (ir !== graph) {
    for (const [key, value] of Object.entries(ir)) {
      if (key !== "nodes" && key !== "edges") {
        out[`graph.${key}`] = value;
      }
    }
  }
  return out;
}
function irOf(graph) {
  const inner = graph?.graph;
  return isJsonObject(inner) ? inner : graph ?? {};
}
function nodesOf(ir) {
  return mapOf(ir.nodes);
}
function isScriptLayer(layer) {
  return isJsonObject(layer?.script);
}
function sourceOf(layer) {
  const script = layer?.script;
  return isJsonObject(script) ? script.scriptRef : void 0;
}
function positionOf(node) {
  const meta = node?.meta;
  return isJsonObject(meta) ? meta[NODE_POSITION_KEY] : void 0;
}
function metaWithoutPosition(node) {
  const meta = node?.meta;
  if (!isJsonObject(meta)) {
    return {};
  }
  const rest = {};
  for (const [key, value] of Object.entries(meta)) {
    if (key !== NODE_POSITION_KEY) {
      rest[key] = value;
    }
  }
  return rest;
}
function blueprintNodeCount(blueprint) {
  let total = 0;
  for (const slot of GRAPH_SLOTS) {
    for (const graph of Object.values(graphSlot(blueprint, slot))) {
      total += Object.keys(nodesOf(irOf(graph))).length;
    }
  }
  return total;
}
function mapOf(value) {
  if (!isJsonObject(value)) {
    return {};
  }
  const out = {};
  for (const [key, entry] of Object.entries(value)) {
    if (isJsonObject(entry)) {
      out[key] = entry;
    }
  }
  return out;
}
function text(value) {
  return typeof value === "string" ? value : "";
}
function sortedByName(entries) {
  return [...entries].sort((a, b) => {
    const left = authoredName(a.head?.name ?? a.base?.name) ?? "";
    const right = authoredName(b.head?.name ?? b.base?.name) ?? "";
    if (left !== right) {
      if (left === "") return 1;
      if (right === "") return -1;
      return left < right ? -1 : 1;
    }
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  });
}
function sortedByPosition(entries) {
  const axis = (entry, key) => {
    const position = positionOf(entry.head ?? entry.base ?? {});
    const value = isJsonObject(position) ? position[key] : void 0;
    return typeof value === "number" && Number.isFinite(value) ? value : Number.MAX_SAFE_INTEGER;
  };
  return [...entries].sort((a, b) => axis(a, "y") - axis(b, "y") || axis(a, "x") - axis(b, "x") || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}
function graphOrder(base, head, slot, changed) {
  const orderKey = ORDER_KEY[slot];
  const out = [];
  const seen = /* @__PURE__ */ new Set();
  const take = (id) => {
    if (typeof id === "string" && !seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  };
  for (const side2 of orderKey ? [head, base] : []) {
    const declared = side2[orderKey];
    for (const id of Array.isArray(declared) ? declared : []) {
      take(id);
    }
  }
  for (const id of [...changed.keys()].sort()) {
    take(id);
  }
  return out;
}
function declaredOrder(graphs, orderKey, shared) {
  const declared = graphs[orderKey];
  return Array.isArray(declared) ? declared.filter((id) => typeof id === "string" && shared.has(id)) : [];
}

// ../NarraLeaf-Studio/src/shared/documents/specs/uiGraphs.ts
var UI_GRAPHS_DOCUMENT_PATH = "editor/ui/uigraphs.json";
var uiGraphsSpec = defineDocumentSpec({
  kind: "ui-graphs",
  version: UI_GRAPH_DOCUMENT_SCHEMA_VERSION,
  paths: [UI_GRAPHS_DOCUMENT_PATH],
  parse: (raw, context) => {
    const record = requireDocumentObject(raw, context, "a blueprint document");
    rejectNewerSchema(record, context, UI_GRAPH_DOCUMENT_SCHEMA_VERSION);
    if (record.blueprintDocument !== void 0 && !isJsonObject(record.blueprintDocument)) {
      return context.corrupt(`"blueprintDocument" must be an object, got ${describe6(record.blueprintDocument)}`);
    }
    if (isJsonObject(record.blueprintDocument)) {
      rejectNewerSchema(record.blueprintDocument, context, BLUEPRINT_DOCUMENT_SCHEMA_VERSION);
      requireOptionalMap(record.blueprintDocument, "blueprints", context);
      requireOptionalMap(record.blueprintDocument, "ownerRecords", context);
    }
    return record;
  },
  /** Refused; see the note above for what has to land before it can write. */
  serialize: () => {
    throw new Error(
      "The ui-graphs spec is read-only in this build: `parse` does not run the blueprint migration (it seeds the variable registry as it goes, which needs a service), so serializing would write back a document that was never migrated. Use UIGraphService."
    );
  },
  summarize: (document) => {
    const blueprints = document?.blueprintDocument?.blueprints;
    return {
      // No authored name: there is one of these per project and the history UI labels it by
      // kind. A blueprint's own name belongs on the row about that blueprint.
      title: "",
      counts: [
        { key: "uiBlueprints", value: isJsonObject(blueprints) ? Object.keys(blueprints).length : 0 },
        { key: "uiGraphNodes", value: countGraphNodes(document) }
      ]
    };
  },
  diff: diffUIGraphs
  // No `merge3`; the reason is at the foot of `uiGraphsDiff.ts`.
});
function describe6(value) {
  if (value === null) {
    return "null";
  }
  return Array.isArray(value) ? "an array" : `a ${typeof value}`;
}

// ../NarraLeaf-Studio/src/shared/types/variables/registry.ts
var VARIABLE_REGISTRY_SCHEMA_VERSION = 2;

// ../NarraLeaf-Studio/src/shared/variables/variableRegistryModel.ts
function normalizePersistentValueType(valueType) {
  return valueType === "boolean" || valueType === "number" || valueType === "string" ? valueType : "json";
}
function normalizeVariableRegistryScope(scope) {
  return scope === "saved" ? "saved" : "persistent";
}
function withDefaultValue(value) {
  return value === void 0 ? {} : { defaultValue: value };
}
function migrateVariableRegistryToLatest(raw) {
  if (!isRecord(raw)) {
    throw new Error("VariableRegistry: expected object");
  }
  const entries = {};
  const rawEntries = isRecord(raw.entries) ? raw.entries : {};
  for (const [id, value] of Object.entries(rawEntries)) {
    if (!isRecord(value) || typeof value.storageKey !== "string" || typeof value.name !== "string") {
      continue;
    }
    entries[id] = {
      id,
      name: value.name,
      scope: normalizeVariableRegistryScope(value.scope),
      valueType: normalizePersistentValueType(typeof value.valueType === "string" ? value.valueType : void 0),
      ...withDefaultValue(value.defaultValue),
      storageKey: value.storageKey,
      ...typeof value.description === "string" ? { description: value.description } : {}
    };
  }
  return {
    schemaVersion: VARIABLE_REGISTRY_SCHEMA_VERSION,
    entries,
    ...isRecord(raw.meta) ? { meta: raw.meta } : {}
  };
}

// ../NarraLeaf-Studio/src/shared/documents/specs/variables.ts
var VARIABLE_REGISTRY_DOCUMENT_PATH = "editor/variables.json";
var variableRegistrySpec = defineDocumentSpec({
  kind: "variables",
  version: VARIABLE_REGISTRY_SCHEMA_VERSION,
  paths: [VARIABLE_REGISTRY_DOCUMENT_PATH],
  parse: (raw, context) => {
    const record = requireDocumentObject(raw, context, "a variable registry");
    rejectNewerSchema(record, context, VARIABLE_REGISTRY_SCHEMA_VERSION);
    requireOptionalMap(record, "entries", context);
    return migrateVariableRegistryToLatest(record);
  },
  // No authored name: the registry is one per project and the history UI labels it by kind.
  summarize: (registry) => ({
    title: "",
    counts: [{ key: "variables", value: Object.keys(registry.entries).length }]
  }),
  diff: diffVariableRegistry,
  merge3: merge3VariableRegistry
});
var LABEL14 = {
  added: "documentDiff.variables.added",
  removed: "documentDiff.variables.removed",
  changed: "documentDiff.variables.changed",
  renamed: "documentDiff.variables.renamed",
  defaultValue: "documentDiff.variables.defaultValue",
  valueType: "documentDiff.variables.valueType",
  scopeSaved: "documentDiff.variables.scopeSaved",
  scopeGlobal: "documentDiff.variables.scopeGlobal",
  storageKey: "documentDiff.variables.storageKey",
  description: "documentDiff.variables.description"
};
function merge3VariableRegistry(base, mine, theirs) {
  const entries = mergeKeyed(base?.entries, mine.entries, theirs.entries);
  const decisions = entries.rows.map((row) => {
    const present = row.mine.value ?? row.theirs.value ?? row.base.value;
    return decision(["entries", row.key], row, {
      label: keyedRowLabel(row, LABEL14),
      // The author's own label for it. The id is a generated handle nobody typed, and the
      // panel never shows it, so a row identified by one identifies nothing.
      subject: authoredName(present?.name)
    });
  });
  return {
    document: {
      schemaVersion: mine.schemaVersion,
      entries: entries.merged,
      ...mine.meta === void 0 ? {} : { meta: mine.meta }
    },
    decisions,
    conflicts: countConflicts(decisions)
  };
}
function diffVariableRegistry(base, head, options) {
  const rows = [];
  for (const entry of diffKeyed(base.entries, head.entries)) {
    const path = ["entries", entry.key];
    const subject = authoredName(entry.head?.name) ?? authoredName(entry.base?.name);
    if (!entry.base || !entry.head) {
      rows.push(change(path, entry.kind, entry.head ? LABEL14.added : LABEL14.removed, { subject }));
      continue;
    }
    if (!sameJsonValue(entry.base.name, entry.head.name)) {
      rows.push(change([...path, "name"], "changed", LABEL14.renamed, {
        params: fromToParams(entry.base.name, entry.head.name),
        subject
      }));
    }
    if (!sameJsonValue(entry.base.defaultValue, entry.head.defaultValue)) {
      rows.push(change([...path, "defaultValue"], "changed", LABEL14.defaultValue, {
        params: fromToParams(entry.base.defaultValue, entry.head.defaultValue),
        subject
      }));
    }
    if (!sameJsonValue(entry.base.valueType, entry.head.valueType)) {
      rows.push(change([...path, "valueType"], "changed", LABEL14.valueType, {
        params: fromToParams(entry.base.valueType, entry.head.valueType),
        subject
      }));
    }
    if (!sameJsonValue(entry.base.scope, entry.head.scope)) {
      rows.push(change([...path, "scope"], "changed", entry.head.scope === "saved" ? LABEL14.scopeSaved : LABEL14.scopeGlobal, {
        subject
      }));
    }
    if (!sameJsonValue(entry.base.storageKey, entry.head.storageKey)) {
      rows.push(change([...path, "storageKey"], "changed", LABEL14.storageKey, { subject }));
    }
    if (!sameJsonValue(entry.base.description, entry.head.description)) {
      rows.push(change([...path, "description"], "changed", LABEL14.description, {
        params: fromToParams(entry.base.description, entry.head.description),
        subject
      }));
    }
  }
  return buildDocumentDiff(rows, { tier: "semantic", limit: options.limit });
}

// ../NarraLeaf-Studio/src/shared/types/voice.ts
var VOICE_DOCUMENT_SCHEMA_VERSION = 1;
function createEmptyVoiceDocument(locale) {
  return {
    schemaVersion: VOICE_DOCUMENT_SCHEMA_VERSION,
    locale,
    units: {}
  };
}
function normalizeVoiceDocument(value, locale) {
  const document = createEmptyVoiceDocument(locale);
  if (!value || typeof value !== "object") {
    return document;
  }
  const record = value;
  if (!record.units || typeof record.units !== "object") {
    return document;
  }
  for (const [unitId, raw] of Object.entries(record.units)) {
    if (!unitId || !raw || typeof raw !== "object") {
      continue;
    }
    const unit = raw;
    if (typeof unit.assetId !== "string" || !unit.assetId) {
      continue;
    }
    document.units[unitId] = {
      assetId: unit.assetId,
      sourceHash: typeof unit.sourceHash === "string" ? unit.sourceHash : "",
      status: unit.status === "approved" ? "approved" : "linked",
      ...typeof unit.duration === "number" && Number.isFinite(unit.duration) ? { duration: unit.duration } : {},
      ...typeof unit.note === "string" && unit.note ? { note: unit.note } : {}
    };
  }
  return document;
}

// ../NarraLeaf-Studio/src/shared/documents/specs/voice.ts
var VOICE_DOCUMENT_PATH = "editor/voice/<locale>.json";
var VOICE_DOCUMENT_PATTERN = compileDocumentPathPattern(VOICE_DOCUMENT_PATH);
var voiceDocumentSpec = defineDocumentSpec({
  kind: "voice",
  version: VOICE_DOCUMENT_SCHEMA_VERSION,
  paths: [VOICE_DOCUMENT_PATH],
  parse: (raw, context) => {
    const locale = parameterFromPath(VOICE_DOCUMENT_PATTERN, "locale", context);
    const record = requireDocumentObject(raw, context, "a voice library");
    rejectNewerSchema(record, context, VOICE_DOCUMENT_SCHEMA_VERSION);
    requireOptionalMap(record, "units", context);
    return normalizeVoiceDocument(record, locale);
  },
  summarize: (document) => ({
    title: document.locale,
    counts: [{ key: "voiceUnits", value: Object.keys(document.units).length }]
  })
});

// ../NarraLeaf-Studio/src/shared/live/sharedDocuments.ts
function liveDocumentPath(document) {
  switch (document.doc) {
    case "story":
      return storyDocumentSpec.pathFor({ storyId: document.storyId });
    case "characters":
      return charactersSpec.pathFor();
    case "localization":
      return localizationDocumentSpec.pathFor({ locale: document.locale });
    case "voice":
      return voiceDocumentSpec.pathFor({ locale: document.locale });
    case "assets":
      return assetsMetadataSpec.pathFor({ type: document.assetType });
    case "asset-groups":
      return assetGroupsSpec.pathFor({ category: document.category });
    case "app-tags":
      return appTagsSpec.pathFor();
    case "dlc":
      return dlcSpec.pathFor();
    case "brand":
      return brandSpec.pathFor();
    case "ui":
      return uiDocumentSpec.pathFor();
    case "ui-graphs":
      return uiGraphsSpec.pathFor();
    case "dictionary":
      return dictionarySpec.pathFor();
    case "audio-tracks":
      return audioTracksSpec.pathFor();
    case "asset-sets":
      return assetSetsSpec.pathFor();
    case "variables":
      return variableRegistrySpec.pathFor();
    case "localization-keys":
      return localizationKeysSpec.pathFor();
  }
}

// ../NarraLeaf-Studio/src/shared/live/characterSweep.ts
function sweepSpeakerName(stories, characterId, speakerName) {
  const touched = [];
  for (const { storyId, rows } of located(stories, characterId)) {
    const document = read(stories, storyId);
    if (!document) {
      continue;
    }
    const edits = setRowsSpeakerName(document, rows, speakerName);
    if (edits.length === 0) {
      continue;
    }
    stories.applyLiveOp(storyId, { op: "update-blocks", edits });
    touched.push(...scenesOf2(storyId, edits));
  }
  return touched;
}
function rebindRows(stories, rows, characterId) {
  const touched = [];
  for (const [storyId, group] of byStory(rows)) {
    const document = read(stories, storyId);
    if (!document) {
      continue;
    }
    const edits = bindRowsToCharacter(document, group, characterId);
    if (edits.length === 0) {
      continue;
    }
    stories.applyLiveOp(storyId, { op: "update-blocks", edits });
    touched.push(...scenesOf2(storyId, edits));
  }
  return touched;
}
function located(stories, characterId) {
  const found = [];
  for (const entry of stories.listStories()) {
    const document = read(stories, entry.id);
    if (!document) {
      continue;
    }
    const rows = collectRowsSpokenBy(document, characterId);
    if (rows.length > 0) {
      found.push({ storyId: entry.id, rows });
    }
  }
  return found;
}
function byStory(rows) {
  const grouped = /* @__PURE__ */ new Map();
  for (const row of rows) {
    const group = grouped.get(row.storyId) ?? [];
    group.push({ sceneId: row.sceneId, blockId: row.blockId });
    grouped.set(row.storyId, group);
  }
  return grouped;
}
function scenesOf2(storyId, edits) {
  const seen = /* @__PURE__ */ new Set();
  const scopes = [];
  for (const edit of edits) {
    if (seen.has(edit.sceneId)) {
      continue;
    }
    seen.add(edit.sceneId);
    scopes.push({ of: "scene", storyId, sceneId: edit.sceneId });
  }
  return scopes;
}
function read(stories, storyId) {
  try {
    return stories.getStoryDocument(storyId);
  } catch {
    return null;
  }
}

// ../NarraLeaf-Studio/src/shared/utils/atomicWriteTemp.ts
var ATOMIC_WRITE_TEMP_PATTERN = /\.nltmp$/;

// ../NarraLeaf-Studio/src/shared/vcs/workingSet.ts
var ROOT_EXCLUDED_DIRECTORIES = [
  /** Build output. */
  "dist",
  /** Thumbnails and other derived artefacts, rebuilt on demand. */
  "editor/cache",
  /** Locally cached copies of remote assets; the reference is versioned, not the copy. */
  "editor/assets/remote",
  /**
   * Declarations generated for the author's scripts: the host API, and this project's own ids as
   * literal types. Rewritten whenever a name they mention changes, so versioning them would put a
   * generated diff in the history of every rename. Studio writes them again when the project
   * opens, so a fresh clone type-checks without them having been carried.
   */
  "scripts/.narraleaf"
];
var EXCLUDED_NAMES = /* @__PURE__ */ new Set([
  /** The repository itself. Lore excludes it intrinsically; listed so this predicate agrees. */
  ".lore",
  /** Studio's per-machine state: panel layout, build and preview output, quarantine. */
  ".nlstudio",
  ".git",
  ".DS_Store",
  "Thumbs.db",
  /**
   * A dependency tree, wherever it sits. Owned by a package manager and restorable from the
   * manifest beside it, so it is never the author's content no matter where it turns up.
   *
   * Unanchored, unlike the ordinary words above, and the distinction is the whole point of the
   * two lists: `dist` and `cache` are plausible names for a folder of the author's own, while
   * nobody names an asset folder `node_modules`. It was anchored to the root until scripts
   * arrived, and the author's install lands in `scripts/node_modules` - so anchored, the first
   * `npm install` in a versioned project committed every byte of every dependency.
   */
  "node_modules"
]);
function isVersioned(repositoryRelativePath) {
  const segments = splitRelative(repositoryRelativePath);
  if (segments.length === 0) return false;
  if (segments.some((segment) => segment === ".." || EXCLUDED_NAMES.has(segment))) return false;
  const relative = segments.join("/");
  if (ATOMIC_WRITE_TEMP_PATTERN.test(relative)) return false;
  return !ROOT_EXCLUDED_DIRECTORIES.some(
    (directory) => relative === directory || relative.startsWith(`${directory}/`)
  );
}
function splitRelative(repositoryRelativePath) {
  return repositoryRelativePath.split(/[\\/]+/).filter((segment) => segment.length > 0 && segment !== ".");
}

// ../NarraLeaf-Studio/src/shared/types/storyComments.ts
var STORY_COMMENTS_SCHEMA_VERSION = 1;
var STORY_COMMENT_EXCERPT_MAX = 120;
function isRecord2(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function normalizeAuthor(value) {
  if (!isRecord2(value) || typeof value.name !== "string") {
    return null;
  }
  const author = { name: value.name };
  if (typeof value.teamUserId === "string" && value.teamUserId) {
    author.teamUserId = value.teamUserId;
  }
  return author;
}
function normalizeComment(value) {
  if (!isRecord2(value) || typeof value.id !== "string" || typeof value.body !== "string") {
    return null;
  }
  const author = normalizeAuthor(value.author);
  if (!author) {
    return null;
  }
  const comment = {
    id: value.id,
    author,
    body: value.body,
    createdAt: typeof value.createdAt === "number" ? value.createdAt : 0
  };
  if (typeof value.editedAt === "number") {
    comment.editedAt = value.editedAt;
  }
  if (typeof value.teamCommentId === "string" && value.teamCommentId) {
    comment.teamCommentId = value.teamCommentId;
  }
  return comment;
}
function normalizeStoryCommentThread(value) {
  if (!isRecord2(value)) {
    return null;
  }
  const { id, storyId, sceneId, blockId } = value;
  if (typeof id !== "string" || typeof storyId !== "string" || typeof sceneId !== "string" || typeof blockId !== "string") {
    return null;
  }
  const comments = Array.isArray(value.comments) ? value.comments.map(normalizeComment).filter((comment) => comment !== null) : [];
  if (comments.length === 0) {
    return null;
  }
  const thread = {
    id,
    storyId,
    sceneId,
    blockId,
    todo: value.todo === true,
    resolved: value.resolved === true,
    createdAt: typeof value.createdAt === "number" ? value.createdAt : comments[0].createdAt,
    comments
  };
  if (typeof value.excerpt === "string" && value.excerpt) {
    thread.excerpt = value.excerpt.slice(0, STORY_COMMENT_EXCERPT_MAX);
  }
  if (typeof value.teamThreadId === "string" && value.teamThreadId) {
    thread.teamThreadId = value.teamThreadId;
  }
  if (typeof value.teamTodoId === "string" && value.teamTodoId) {
    thread.teamTodoId = value.teamTodoId;
  }
  if (thread.resolved) {
    const resolvedBy = normalizeAuthor(value.resolvedBy);
    if (resolvedBy) {
      thread.resolvedBy = resolvedBy;
    }
    if (typeof value.resolvedAt === "number") {
      thread.resolvedAt = value.resolvedAt;
    }
  }
  return thread;
}
function normalizeStoryCommentsDocument(raw) {
  const threads = {};
  if (isRecord2(raw.threads)) {
    for (const [key, value] of Object.entries(raw.threads)) {
      const thread = normalizeStoryCommentThread(value);
      if (thread) {
        threads[key] = { ...thread, id: key };
      }
    }
  }
  return { schemaVersion: STORY_COMMENTS_SCHEMA_VERSION, threads };
}

// ../NarraLeaf-Studio/src/shared/documents/specs/storyComments.ts
var STORY_COMMENTS_DOCUMENT_PATH = "editor/story-comments.json";
var storyCommentsSpec = defineDocumentSpec({
  kind: "story-comments",
  version: STORY_COMMENTS_SCHEMA_VERSION,
  paths: [STORY_COMMENTS_DOCUMENT_PATH],
  parse: (raw, context) => {
    const record = requireDocumentObject(raw, context, "a story comments document");
    rejectNewerSchema(record, context, STORY_COMMENTS_SCHEMA_VERSION);
    if (record.threads !== void 0 && (typeof record.threads !== "object" || record.threads === null || Array.isArray(record.threads))) {
      context.corrupt(`"threads" must be an object, got ${Array.isArray(record.threads) ? "array" : typeof record.threads}`);
    }
    return normalizeStoryCommentsDocument(record);
  },
  summarize: (document) => ({
    title: "",
    counts: [{ key: "storyCommentThreads", value: Object.keys(document.threads).length }]
  })
});

// ../NarraLeaf-Studio/src/shared/authority/project.ts
function isHeldFile(value) {
  return typeof value === "object" && value !== null && value.$file === 1;
}
var STORY_LIBRARY_FILE = STORY_INDEX_DOCUMENT_PATH;
var PROJECT_SPECS = [
  storyIndexSpec,
  storyDocumentSpec,
  charactersSpec,
  localizationDocumentSpec,
  voiceDocumentSpec,
  localizationKeysSpec,
  variableRegistrySpec,
  appTagsSpec,
  dlcSpec,
  brandSpec,
  dictionarySpec,
  audioTracksSpec,
  assetSetsSpec,
  uiDocumentSpec,
  uiGraphsSpec,
  assetsMetadataSpec,
  assetGroupsSpec
];
var PATTERNS = PROJECT_SPECS.flatMap(
  (spec) => spec.paths.map((path) => ({ pattern: compileDocumentPathPattern(path), spec }))
);
function specFor(path) {
  return PATTERNS.find((entry) => matchDocumentPath(entry.pattern, path) !== null)?.spec;
}
function isProjectDocumentPath(path) {
  return specFor(path) !== void 0;
}
var PROJECT_AREAS = ["story", "characters", "assets", "ui", "localization", "config"];
var AREA_BY_KIND = {
  "story": "story",
  "story-index": "story",
  "variables": "story",
  "characters": "characters",
  "assets-metadata": "assets",
  "assets-groups": "assets",
  "asset-sets": "assets",
  "audio-tracks": "assets",
  "ui-document": "ui",
  "ui-graphs": "ui",
  "localization": "localization",
  "localization-keys": "localization",
  "voice": "localization",
  "dictionary": "localization"
};
function projectAreaOf(path) {
  const kind = specFor(path)?.kind;
  const byKind = kind === void 0 ? void 0 : AREA_BY_KIND[kind];
  if (byKind !== void 0) {
    return byKind;
  }
  if (path.startsWith("editor/story/") || path === "editor/transform-presets.json") {
    return "story";
  }
  if (path.startsWith("assets/") || path.startsWith("editor/assets/")) {
    return "assets";
  }
  if (path.startsWith("editor/ui/")) {
    return "ui";
  }
  if (path.startsWith("editor/localization/") || path.startsWith("editor/voice/")) {
    return "localization";
  }
  return "config";
}
var ASSET_CONTENT_ROOT = "assets/content";
function isTeamFilePath(path) {
  if (!isVersioned(path) || path.includes("\\") || path.startsWith("/") || path === ".loreignore") {
    return false;
  }
  if (path === STORY_COMMENTS_DOCUMENT_PATH || path === STORY_LIBRARY_FILE) {
    return false;
  }
  return specFor(path)?.kind !== "story";
}
function isWholeFilePath(path) {
  return isTeamFilePath(path) && !isProjectDocumentPath(path) && path !== ASSET_CONTENT_ROOT && !path.startsWith(`${ASSET_CONTENT_ROOT}/`);
}
function projectDocumentPath(document) {
  return document.doc === "file" ? document.path : liveDocumentPath(document);
}
function parseProjectFile(path, text2) {
  const spec = specFor(path);
  if (spec === void 0) {
    throw new Error(`not a project document: ${path}`);
  }
  const kind = spec.kind;
  let raw;
  try {
    raw = JSON.parse(text2);
  } catch (error) {
    throw new DocumentCorruptError({ kind, path, reason: `not JSON: ${String(error)}`, text: text2, cause: error });
  }
  const context = contextFor2(kind, path, text2);
  if (kind === "story") {
    return storyDocumentSpec.parse(raw, context);
  }
  if (kind === "story-index") {
    return storyIndexSpec.parse(raw, context);
  }
  spec.parse(raw, context);
  return raw;
}
function serializeProjectFile(_path, value) {
  return JSON.stringify(value, null, 2);
}
function projectOpClaimKeys(document, op) {
  if (document.doc === "file" || op.op === "put-file") {
    return document.doc === "file" ? [fileClaimKey(document.path)] : [];
  }
  if (op.op === "create-story" || op.op === "delete-story") {
    return document.doc === "story" ? [`story:${document.storyId}`] : [];
  }
  let keys = [];
  try {
    const found = opClaimKeys(op);
    keys = Array.isArray(found) ? found : [];
  } catch {
    keys = [];
  }
  return [...keys, ...structuralKeys(document, op)];
}
function fileClaimKey(path) {
  return `file:${path}`;
}
function structuralKeys(document, op) {
  if (document.doc !== "story") {
    return [];
  }
  switch (op.op) {
    case "rename-scene":
    case "update-scene":
    case "delete-scene":
    case "move-scene":
    case "set-scene-snapshots":
    case "set-scene-layers":
      return [`scene:${op.sceneId}`];
    case "create-scene":
      return [`scene:${op.scene.id}`];
    case "rename-chapter":
    case "delete-chapter":
      return [`chapter:${op.chapterId}`];
    case "create-chapter":
      return [`chapter:${op.chapter.id}`];
    case "reorder-chapters":
      return [`chapters:${document.storyId}`];
    case "rename-story":
    case "set-entry-scene":
      return [`story:${document.storyId}`];
    default:
      return [];
  }
}
function applyProjectOp(view, document, op, context, derived) {
  const applied = applyToDocument(view, document, op, context);
  if (derived !== void 0) {
    applied.touched.push(...applyDerived(view, derived));
    applied.changed = applied.changed || applied.touched.length > 0;
  }
  applied.touched = [...new Set(applied.touched)];
  return applied;
}
function applyToDocument(view, document, op, context) {
  if (document.doc === "file") {
    if (op.op !== "put-file") throw unknownVerb(op);
    return applyPutFile(view, document.path, op);
  }
  if (op.op === "put-file") {
    throw new Error("a whole file is addressed by its path");
  }
  const path = liveDocumentPath(document);
  switch (document.doc) {
    case "story":
      return applyStory(view, document.storyId, op, context);
    case "characters":
      return applyCharacters(view, path, op);
    case "localization":
      return applyUnits(view, path, op);
    case "voice":
      return applyUnits(view, path, op);
    case "localization-keys":
      return applyKeys(view, path, op);
    case "variables":
      return applyVariables(view, path, op);
    case "app-tags":
      return applyAppTags(view, path, op);
    case "dlc":
      return applyDlc(view, path, op);
    case "brand":
      return applyBrand(view, path, op);
    case "dictionary":
      return applyDictionary(view, path, op);
    case "audio-tracks":
      return applyAudioTracks(view, path, op);
    case "asset-sets":
      return applyAssetSets(view, path, op);
    case "ui":
      return applyWhole(view, path, (document2) => applyUIParts(document2, op.parts));
    case "ui-graphs":
      return applyWhole(view, path, (document2) => applyUIGraphParts(document2, op.parts));
    case "assets":
      return applyAssets(view, path, op);
    case "asset-groups":
      return applyAssetFolders(view, document.category, path, op);
    default: {
      const unknown = document;
      throw new Error(`No document of kind ${JSON.stringify(unknown)}`);
    }
  }
}
function storyView(view) {
  const touched = /* @__PURE__ */ new Set();
  return {
    touched,
    listStories: () => view.get(STORY_LIBRARY_FILE)?.stories ?? [],
    getStoryDocument: (storyId) => {
      const document = view.get(liveDocumentPath({ doc: "story", storyId }));
      if (document === void 0) {
        throw new Error(`Story not found: ${storyId}`);
      }
      return document;
    },
    applyLiveOp: (storyId, op) => {
      const path = liveDocumentPath({ doc: "story", storyId });
      const document = view.get(path);
      if (document === void 0) {
        return;
      }
      applyStoryOpToDocument(document, op, { now: (/* @__PURE__ */ new Date()).toISOString() });
      touched.add(path);
    }
  };
}
function applyStory(view, storyId, op, context) {
  const path = liveDocumentPath({ doc: "story", storyId });
  let library = view.get(STORY_LIBRARY_FILE);
  if (op.op === "create-story") {
    if (library === void 0) {
      library = createEmptyStoryLibraryIndex(context.now);
      view.set(STORY_LIBRARY_FILE, library);
    }
    if (library.stories.some((entry) => entry.id === storyId) || view.get(path) !== void 0) {
      return { changed: false, touched: [] };
    }
    library.stories.push({ ...op.entry, id: storyId });
    view.set(path, { ...op.document, id: storyId });
    return { changed: true, touched: [path, STORY_LIBRARY_FILE] };
  }
  if (op.op === "delete-story") {
    if (library === void 0 || !library.stories.some((entry) => entry.id === storyId)) {
      return { changed: false, touched: [] };
    }
    library.stories = library.stories.filter((entry) => entry.id !== storyId);
    if (library.defaultStoryId === storyId) {
      delete library.defaultStoryId;
    }
    view.delete(path);
    return { changed: true, touched: [path, STORY_LIBRARY_FILE] };
  }
  const document = view.get(path);
  if (document === void 0) {
    throw new Error(`Story not found: ${storyId}`);
  }
  const applied = applyStoryOpToDocument(document, op, context);
  const touched = applied.changed ? [path] : [];
  if (library !== void 0 && applyStoryOpToLibrary(library, storyId, op, context)) {
    touched.push(STORY_LIBRARY_FILE);
  }
  void storyOpSceneReach;
  return { changed: applied.changed, touched };
}
function applyCharacters(view, path, op) {
  const store = view.get(path) ?? { version: 1, characters: [] };
  if (view.get(path) === void 0) {
    view.set(path, store);
  }
  const characters = store.characters;
  const stories = storyView(view);
  const find = (id) => characters.findIndex((record) => record.profile.id === id);
  let changed = true;
  switch (op.op) {
    case "create-character": {
      const record = op.character;
      const at = find(record.profile.id);
      if (at >= 0) {
        characters[at] = record;
      } else {
        characters.push(record);
      }
      if (op.rebind) {
        rebindRows(stories, op.rebind, record.profile.id);
      }
      break;
    }
    case "update-character": {
      const at = find(op.characterId);
      if (at < 0) {
        changed = false;
        break;
      }
      characters[at] = op.character;
      break;
    }
    case "delete-character": {
      const at = find(op.characterId);
      if (at < 0) {
        changed = false;
        break;
      }
      const speakerName = characters[at].profile.name ?? "";
      characters.splice(at, 1);
      sweepSpeakerName(stories, op.characterId, speakerName);
      break;
    }
    case "set-character-group": {
      const groups = { ...store.groups ?? {} };
      groups[op.groupId] = { ...op.group };
      store.groups = groups;
      for (const memberId of op.members ?? []) {
        const at = find(memberId);
        if (at >= 0) {
          characters[at].profile.groupId = op.groupId;
        }
      }
      break;
    }
    case "delete-character-group": {
      for (const record of characters) {
        if (record.profile.groupId === op.groupId) {
          delete record.profile.groupId;
        }
      }
      const groups = store.groups;
      if (groups !== void 0) {
        delete groups[op.groupId];
      }
      break;
    }
    default:
      throw unknownVerb(op);
  }
  return { changed: changed || stories.touched.size > 0, touched: changed ? [path, ...stories.touched] : [...stories.touched] };
}
function onFile(changed, path) {
  return changed ? { changed: true, touched: [path] } : { changed: false, touched: [] };
}
function applyUnitsOpToDocument(document, op) {
  const verb = op.op;
  const single = verb === "set-translation" || verb === "set-take";
  if (!single && verb !== "set-translations" && verb !== "set-takes") {
    throw unknownVerb(op);
  }
  const units = { ...document.units ?? {} };
  const entries = single ? [{ unitId: op.unitId, unit: op.unit }] : op.units;
  for (const entry of entries) {
    if (entry.unit === null) {
      delete units[entry.unitId];
    } else {
      units[entry.unitId] = entry.unit;
    }
  }
  document.units = units;
  return true;
}
function applyUnits(view, path, op) {
  const document = view.get(path);
  if (document === void 0) return { changed: false, touched: [] };
  return onFile(applyUnitsOpToDocument(document, op), path);
}
function applyDerived(view, derived) {
  const touched = [];
  const write = (path, entries) => {
    const document = view.get(path);
    if (document === void 0) return;
    document.units = { ...document.units ?? {}, ...structuredClone(entries) };
    touched.push(path);
  };
  for (const [locale, entries] of Object.entries(derived.translations ?? {})) {
    write(liveDocumentPath({ doc: "localization", locale }), entries);
  }
  for (const [locale, entries] of Object.entries(derived.voice ?? {})) {
    write(liveDocumentPath({ doc: "voice", locale }), entries);
  }
  return touched;
}
function applyLocalizationKeyOpToDocument(document, op) {
  const keys = { ...document.keys ?? {} };
  switch (op.op) {
    case "set-key":
      keys[op.name] = op.definition;
      break;
    case "remove-key":
      if (!(op.name in keys)) return false;
      delete keys[op.name];
      break;
    default:
      throw unknownVerb(op);
  }
  document.keys = keys;
  return true;
}
function applyKeys(view, path, op) {
  const document = view.get(path);
  if (document === void 0) return { changed: false, touched: [] };
  return onFile(applyLocalizationKeyOpToDocument(document, op), path);
}
function applyVariableOpToDocument(registry, op) {
  const entries = registry.entries ?? (registry.entries = {});
  switch (op.op) {
    case "create-variable":
      entries[op.entry.id] = { ...op.entry };
      return true;
    case "update-variable":
      if (!entries[op.variableId]) return false;
      entries[op.variableId] = { ...op.entry };
      return true;
    case "delete-variable":
      if (!entries[op.variableId]) return false;
      delete entries[op.variableId];
      return true;
    default:
      throw unknownVerb(op);
  }
}
function applyVariables(view, path, op) {
  const registry = view.get(path);
  if (registry === void 0) return { changed: false, touched: [] };
  return onFile(applyVariableOpToDocument(registry, op), path);
}
function moveBefore(list, id, beforeId) {
  const moving = list.find((entry) => entry.id === id);
  if (!moving || beforeId === id) return [...list];
  const rest = list.filter((entry) => entry.id !== id);
  const index = beforeId === null ? -1 : rest.findIndex((entry) => entry.id === beforeId);
  if (index < 0) return [...rest, moving];
  rest.splice(index, 0, moving);
  return rest;
}
function applyAppTagOpToDocument(document, op) {
  switch (op.op) {
    case "create-app-tag":
      document.tags = document.tags.some((entry) => entry.id === op.tag.id) ? document.tags.map((entry) => entry.id === op.tag.id ? op.tag : entry) : insertLiveRecordBefore(document.tags, op.tag, op.beforeId);
      break;
    case "update-app-tag":
      if (!document.tags.some((entry) => entry.id === op.tagId)) return false;
      document.tags = document.tags.map((entry) => entry.id === op.tagId ? op.tag : entry);
      break;
    case "delete-app-tag":
      document.tags = document.tags.filter((entry) => entry.id !== op.tagId);
      break;
    case "set-app-tag-defaults": {
      document.pluginConfig = op.defaults.pluginConfig;
      document.assetAxes = op.defaults.assetAxes;
      document.reachableScenes = op.defaults.reachableScenes;
      document.endingSurfaceId = op.defaults.endingSurfaceId;
      if (op.tagPluginConfig) {
        const byTag = new Map(op.tagPluginConfig.map((entry) => [entry.tagId, entry.pluginConfig]));
        document.tags = document.tags.map((tag) => byTag.has(tag.id) ? { ...tag, pluginConfig: byTag.get(tag.id) } : tag);
      }
      break;
    }
    default:
      throw unknownVerb(op);
  }
  normalizeAppTagDocument(document);
  return true;
}
function applyAppTags(view, path, op) {
  const document = view.get(path);
  if (document === void 0) return { changed: false, touched: [] };
  return onFile(applyAppTagOpToDocument(document, op), path);
}
function applyDlcOpToDocument(document, op) {
  switch (op.op) {
    case "create-dlc":
      document.dlcs = document.dlcs.some((entry) => entry.id === op.dlc.id) ? document.dlcs.map((entry) => entry.id === op.dlc.id ? op.dlc : entry) : insertLiveRecordBefore(document.dlcs, op.dlc, op.beforeId);
      break;
    case "update-dlc":
      if (!document.dlcs.some((entry) => entry.id === op.dlcId)) return false;
      document.dlcs = document.dlcs.map((entry) => entry.id === op.dlcId ? op.dlc : entry);
      break;
    case "delete-dlc":
      document.dlcs = document.dlcs.filter((entry) => entry.id !== op.dlcId);
      break;
    default:
      throw unknownVerb(op);
  }
  document.dlcs = normalizeProjectDlcs(document.dlcs);
  return true;
}
function applyDlc(view, path, op) {
  const document = view.get(path);
  if (document === void 0) return { changed: false, touched: [] };
  return onFile(applyDlcOpToDocument(document, op), path);
}
function applyBrandOpToDocument(document, op) {
  switch (op.op) {
    case "create-brand-color":
      document.colors = document.colors.some((entry) => entry.id === op.color.id) ? document.colors.map((entry) => entry.id === op.color.id ? op.color : entry) : insertLiveRecordBefore(document.colors, op.color, op.beforeId);
      break;
    case "update-brand-color":
      if (!document.colors.some((entry) => entry.id === op.colorId)) return false;
      document.colors = document.colors.map((entry) => entry.id === op.colorId ? op.color : entry);
      break;
    case "delete-brand-color":
      document.colors = document.colors.filter((entry) => entry.id !== op.colorId);
      break;
    case "move-brand-color":
      document.colors = moveBefore(document.colors, op.colorId, op.beforeId);
      break;
    case "set-brand-fonts":
      document.fonts = normalizeProjectFontStack(op.fonts);
      return true;
    default:
      throw unknownVerb(op);
  }
  document.colors = normalizeProjectBrandColors(document.colors);
  return true;
}
function applyBrand(view, path, op) {
  const document = view.get(path);
  if (document === void 0) return { changed: false, touched: [] };
  return onFile(applyBrandOpToDocument(document, op), path);
}
function applyDictionaryOpToDocument(document, op) {
  switch (op.op) {
    case "set-dictionary-entry": {
      const entry = op.entry;
      const rest = document.entries.filter((candidate) => candidate.term !== op.term && candidate.term !== entry?.term);
      document.entries = normalizeDictionaryEntries(entry ? [...rest, entry] : rest);
      return true;
    }
    case "set-dictionary-options":
      document.options = normalizeDictionaryOptions(op.options);
      return true;
    default:
      throw unknownVerb(op);
  }
}
function applyDictionary(view, path, op) {
  const document = view.get(path);
  if (document === void 0) return { changed: false, touched: [] };
  return onFile(applyDictionaryOpToDocument(document, op), path);
}
function applyAudioTrackOpToDocument(document, op) {
  let tracks = [...document.tracks];
  switch (op.op) {
    case "create-audio-track": {
      const reparent = new Set(op.reparent ?? []);
      const rest = tracks.filter((track) => track.id !== op.track.id).map((track) => reparent.has(track.id) ? { ...track, parentId: op.track.id } : track);
      const index = op.beforeId === null ? -1 : rest.findIndex((track) => track.id === op.beforeId);
      if (index < 0) rest.push({ ...op.track });
      else rest.splice(index, 0, { ...op.track });
      tracks = rest;
      break;
    }
    case "update-audio-track":
      tracks = tracks.map((track) => track.id === op.trackId ? { ...op.track, id: op.trackId } : track);
      break;
    case "delete-audio-track": {
      const doomed = tracks.find((track) => track.id === op.trackId);
      if (!doomed) return false;
      tracks = tracks.filter((track) => track.id !== op.trackId).map((track) => track.parentId === op.trackId ? { ...track, parentId: doomed.parentId } : track);
      break;
    }
    case "move-audio-track":
      tracks = moveBefore(tracks, op.trackId, op.beforeId);
      break;
    default:
      throw unknownVerb(op);
  }
  document.tracks = normalizeProjectAudioTracks(tracks);
  return true;
}
function applyAudioTracks(view, path, op) {
  const document = view.get(path);
  if (document === void 0) return { changed: false, touched: [] };
  return onFile(applyAudioTrackOpToDocument(document, op), path);
}
function applyAssetSetOpToDocument(document, op) {
  if (!assetSetOpToDocument(document, op)) return false;
  Object.assign(document, normalizeProjectAssetSets(document));
  return true;
}
function assetSetOpToDocument(document, op) {
  switch (op.op) {
    case "create-asset-sets": {
      const next = document.sets.filter((set) => !op.creates.some((create) => create.set.id === set.id));
      for (const create of op.creates) {
        const index = create.beforeId === null ? -1 : next.findIndex((set) => set.id === create.beforeId);
        next.splice(index < 0 ? next.length : index, 0, create.set);
      }
      document.sets = next;
      return true;
    }
    case "update-asset-set":
      document.sets = document.sets.map((set) => set.id === op.setId ? { ...op.set, id: op.setId } : set);
      return true;
    case "delete-asset-sets": {
      const doomed = new Set(op.setIds);
      document.sets = document.sets.filter((set) => !doomed.has(set.id));
      return true;
    }
    case "move-asset-sets": {
      const moves = new Map(op.moves.map((move) => [move.setId, move.groupId]));
      document.sets = document.sets.map((set) => {
        if (!moves.has(set.id)) return set;
        const groupId = moves.get(set.id) ?? null;
        const { groupId: _current, ...rest } = set;
        return groupId ? { ...rest, groupId } : rest;
      });
      return true;
    }
    default:
      throw unknownVerb(op);
  }
}
function applyAssetSets(view, path, op) {
  const document = view.get(path);
  if (document === void 0) return { changed: false, touched: [] };
  return onFile(applyAssetSetOpToDocument(document, op), path);
}
function applyWhole(view, path, apply) {
  const document = view.get(path);
  if (document === void 0) return { changed: false, touched: [] };
  apply(document);
  return { changed: true, touched: [path] };
}
function applyAssets(view, path, op) {
  const records = view.get(path) ?? {};
  if (view.get(path) === void 0) view.set(path, records);
  switch (op.op) {
    case "update-asset":
    case "replace-asset-content":
      if (!records[op.assetId]) return { changed: false, touched: [] };
      records[op.assetId] = { ...op.record };
      break;
    case "move-assets": {
      let moved = false;
      for (const move of op.moves) {
        const record = records[move.assetId];
        if (!record) continue;
        if (move.groupId === null) delete record.groupId;
        else record.groupId = move.groupId;
        moved = true;
      }
      if (!moved) return { changed: false, touched: [] };
      break;
    }
    case "create-assets": {
      let created = false;
      for (const create of op.creates) {
        const record = create.record;
        if (typeof record.id !== "string" || records[record.id]) continue;
        records[record.id] = { ...record };
        created = true;
      }
      if (!created) return { changed: false, touched: [] };
      break;
    }
    case "delete-assets": {
      let deleted = false;
      for (const assetId of op.assetIds) {
        if (records[assetId]) {
          delete records[assetId];
          deleted = true;
        }
      }
      if (!deleted) return { changed: false, touched: [] };
      break;
    }
    default:
      throw unknownVerb(op);
  }
  return { changed: true, touched: [path] };
}
var ASSET_CATEGORY_TYPE_NAMES = {
  image: ["image"],
  media: ["audio", "video"],
  data: ["json"],
  font: ["font"],
  model: ["model"],
  other: ["other"]
};
function applyAssetFolders(view, category, path, op) {
  const folders = view.get(path) ?? {};
  if (view.get(path) === void 0) view.set(path, folders);
  switch (op.op) {
    case "set-asset-folder":
      folders[op.folderId] = { ...op.folder };
      return { changed: true, touched: [path] };
    case "delete-asset-folder": {
      const doomed = /* @__PURE__ */ new Set([op.folderId]);
      if (op.recursive) {
        let grew = true;
        while (grew) {
          grew = false;
          for (const folder of Object.values(folders)) {
            const id = folder.id;
            const parent = folder.parentGroupId;
            if (typeof id === "string" && typeof parent === "string" && doomed.has(parent) && !doomed.has(id)) {
              doomed.add(id);
              grew = true;
            }
          }
        }
      }
      const touched = [path];
      for (const type of ASSET_CATEGORY_TYPE_NAMES[category] ?? []) {
        const shardPath = liveDocumentPath({ doc: "assets", assetType: type });
        const records = view.get(shardPath);
        if (records === void 0) continue;
        let changed = false;
        for (const record of Object.values(records)) {
          if (typeof record.groupId === "string" && doomed.has(record.groupId)) {
            delete records[record.id];
            changed = true;
          }
        }
        if (changed) touched.push(shardPath);
      }
      for (const id of doomed) delete folders[id];
      return { changed: true, touched };
    }
    case "restore-asset-folder": {
      const touched = [path];
      for (const folder of op.folders) {
        if (typeof folder.id === "string") folders[folder.id] = { ...folder };
      }
      for (const { assetType, record } of op.assets) {
        const shardPath = liveDocumentPath({ doc: "assets", assetType });
        const records = view.get(shardPath) ?? {};
        if (view.get(shardPath) === void 0) view.set(shardPath, records);
        const id = record.id;
        if (typeof id === "string") {
          records[id] = { ...record };
          touched.push(shardPath);
        }
      }
      return { changed: true, touched };
    }
    default:
      throw unknownVerb(op);
  }
}
function assetBytesOf(op) {
  const found = [];
  if (op.op === "create-assets") {
    for (const create of op.creates) {
      const id = create.record.id;
      if (create.bytes.from === "transfer" && typeof id === "string") {
        for (const part of create.bytes.parts) found.push({ assetType: op.assetType, assetId: id, ...part });
      }
    }
  } else if (op.op === "replace-asset-content" && op.bytes.from === "transfer") {
    for (const part of op.bytes.parts) found.push({ assetType: op.assetType, assetId: op.assetId, ...part });
  }
  return found;
}
function fileBytesOf(document, op) {
  if (document.doc !== "file" || op.op !== "put-file" || op.content === null || !("blob" in op.content)) {
    return void 0;
  }
  return { path: document.path, ...op.content.blob };
}
function applyPutFile(view, path, op) {
  if (!isTeamFilePath(path)) {
    throw new Error(`not a file a team project shares: ${path}`);
  }
  const before = view.get(path);
  if (op.content === null) {
    if (before === void 0) return { changed: false, touched: [] };
    view.delete(path);
    return { changed: true, touched: [path] };
  }
  const content = op.content;
  let next;
  if (isProjectDocumentPath(path)) {
    if (!("encoding" in content) || content.encoding !== "utf8" || typeof content.data !== "string") {
      throw new Error(`a document is put as text: ${path}`);
    }
    next = parseProjectFile(path, content.data);
  } else if ("blob" in content) {
    const blob = content.blob;
    if (blob === null || typeof blob !== "object" || typeof blob.transferId !== "string" || typeof blob.digest !== "string" || !/^[0-9a-f]{64}$/.test(blob.digest) || typeof blob.size !== "number" || !Number.isInteger(blob.size) || blob.size < 0) {
      throw new Error(`a file's transfer is malformed: ${path}`);
    }
    next = { $file: 1, blob: { transferId: blob.transferId, digest: blob.digest, size: blob.size } };
  } else {
    if (content.encoding !== "utf8" && content.encoding !== "base64" || typeof content.data !== "string") {
      throw new Error(`a file's content is malformed: ${path}`);
    }
    next = { $file: 1, encoding: content.encoding, data: content.data };
  }
  if (before !== void 0 && JSON.stringify(before) === JSON.stringify(next)) {
    return { changed: false, touched: [] };
  }
  view.set(path, next);
  return { changed: true, touched: [path] };
}
function contextFor2(kind, path, text2) {
  return {
    path,
    corrupt(reason, options) {
      throw new DocumentCorruptError({ kind, path, reason, text: text2, ...options });
    }
  };
}
function unknownVerb(op) {
  return new Error(`this kernel does not know the operation ${JSON.stringify(op.op)}`);
}

// ../NarraLeaf-Studio/src/shared/authority/kernel.ts
var KERNEL_VERSION = 4;
export {
  ASSET_CONTENT_ROOT,
  KERNEL_VERSION,
  PROJECT_AREAS,
  STORY_LIBRARY_FILE,
  STORY_LIBRARY_PATH,
  applyProjectOp,
  applyStoryOpToDocument,
  applyStoryOpToLibrary,
  assetBytesOf,
  fileBytesOf,
  fileClaimKey,
  firstSceneId2 as firstSceneId,
  isHeldFile,
  isProjectDocumentPath,
  isTeamFilePath,
  isWholeFilePath,
  opClaimKeys,
  parseProjectFile,
  parseStoryDocument,
  parseStoryLibrary,
  projectAreaOf,
  projectDocumentPath,
  projectOpClaimKeys,
  serializeProjectFile,
  serializeStoryFile,
  storyDocumentPath,
  storyOpSceneReach
};
