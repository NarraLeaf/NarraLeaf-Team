# NarraLeaf Team 2.0 重构策划书：登录后可用的网页前台 + 管理后台

日期：2026-11-13　依据：Team `develop_wangzixu`（9d465e3）、Studio `develop_wangzixu`（f6e0aedee）的代码，以及《NarraLeaf 协作功能现状》。

## 0. 背景与目标

现在想知道项目里的情况，只能打开 NarraLeaf Studio。人在外面、手边只有手机时，被问到「第三章那句台词定了没」「立绘交了没」，答不上来。

这次重构要让 Team 从「无界面的项目服务器」变成**一个需要登录的网页**，分两块：

- **前台**：给团队成员用，手机能打开。用来看项目、看历史、写批注、管自己的待办。
- **管理后台**：给管理员用，管账号、项目、权限、品牌和服务器设置。

同时顺手解决两件事：Studio 改成**跳浏览器登录**（Team 当 OAuth2 授权服务器），以及**让批注和权限只有一套**。

**边界（写进 `docs/architecture.md`）**：网页**看、留话、管理，不编辑项目内容**。要改故事、蓝图、资源还是去 Studio。只有这样「为什么网页上改了 Studio 里没变」这种问题才不会出现，版本控制也一直只有一个写入方。

宿主从两个变成三个：**Studio（编辑）／网页（看、留话、管理）／命令行（脚本与急救）**。

---

## 1. 核对另一份总结：对接时要注意的出入

总体准确。下面这些是**过时或需要补充**的，对接时以这一节为准：

| # | 总结里的说法 | 实际代码 | 影响 |
|---|---|---|---|
| 1 | Team 已有「项目授权（grants）」 | **migration 7 已删除 `project_grants` 表**，现在服务器上每个账号都能访问每个项目；组只有 `member` / `admin`（`src/identity/users.ts:179,188`） | 项目级角色要**重新做**，不是「接上就行」（见 §4.6） |
| 2 | `callbackUrl()` 的修复「应修进主线」 | 主线仍是 `https://127.0.0.1:${port}`（`src/identity/config.ts:274`）；`src/lore/call.ts:80` identity 仍写死 undefined | **P0 实测：`--hostname` 不是 127.0.0.1 时，所有仓库操作都会失败**（§10）。**2026-11-13 已在工作区修好（未提交）**：`callbackUrl` 改为公开地址，启动时自检能否连通，compose 加 `extra_hosts`，提供证书时两边都信任证书链。`call.ts` 这次没有挡住 Team 自己读仓库 |
| 3 | Studio 版本 09c51e250 | 当前 HEAD 是 f6e0aedee，多了 14 个提交（安全修复和性能优化），**协作代码没变** | 无 |
| 4 | Studio 登录方式 | 两条路：`vcs/serverPassword.ts` 用账号密码 POST `/api/studio/v1/sign-in` 换令牌；或者粘贴管理员 mint 的令牌。令牌用 safeStorage 存（`vcs/serverTokens.ts`）。登录令牌 30 天、仓库令牌 15 分钟（`src/identity/config.ts:103`），**没有刷新令牌** | 新登录流程替换前一条，后一条留着做急救 |
| 5 | — | Studio **没有注册任何自定义协议**（没有 `setAsDefaultProtocolClient`），只处理 `second-instance` | 网页里的「在 Studio 中打开」链接要新做协议注册 |
| 6 | 「Team 不读 Studio 格式」 | 更准确的说法：Team 会**浅读**每个项目——工程文件、文件树、资源登记、故事的场景列表（`src/projects/content.ts`），对着缓存目录下的裸克隆按需取文件（`src/projects/cache.ts`），每分钟刷新一次 | 网页看原始文件可以直接复用这条读取路径 |
| 7 | — | Team 已有 HTTP 路由器 `src/web/router.ts`，分四支：发现文档、`/api/studio/*`（只有 sign-in）、blobs、socket | 网页静态资源和新路由都挂这里 |
| 8 | 「蓝图」 | 蓝图不是独立文件，**存在 UI 文档里**（`editor/ui/…`）；故事是 `editor/story/index.json` 加场景文件；角色在 `editor/services/character.json` | 网页查看器按这些路径读 |
| 9 | 提交历史有作者 | Team 读到的作者 `details.author` 只是 Lore 记下的一个字符串（`src/projects/read.ts:118`）。**P0 实测：它是客户端自己写的字符串，服务器不校验**；同一个账号推上来的修订里，作者可能是 `显示名 <邮箱>`、账号 UUID 或任意文本（§10） | 贡献图**不能**直接用它，改为 Studio 写一个账号 id 元数据键，再由 Team 交叉核对（§4.3） |
| 10 | 桌面上旧的 `narraleaf-team-console-plan.md` | 它的 D1「前台不浏览内容」、D4「待办复用 overlay」跟这次需求冲突 | **本文取代 D1、D4**；activity 表、`thread_seen`、静态 SPA 打进 `dist/` 这些沿用 |

总结里其他条目（Lore 的 8 条约束、协议三原则、Live 的「只有主持人改文档」、teamCall 的调用情况、两套批注并存）我都对过代码，没问题。

---

## 2. 前台功能

### 2.1 你提的功能，加上细化

**个人主页 `/u/:name`**
- 头像、显示名、简介、所在项目和每个项目里的角色。
- **动态时间线**：提交、批注、回复、解决、待办完成、加入项目、Live 会话。可以按项目筛。
- **贡献图**：365 天热力图，按浏览器时区分桶。数据源是提交 + 批注 + 待办完成，点某一天能看到当天的条目。
- **我的待办**：每条可设「仅自己 / 项目成员可见」，**由服务器执行过滤**，不是前端藏起来。可以挂在某一行或某个资源上（带锚点），也可以不挂。

**项目页 `/p/:id`**
- 概览：简介、封面（取工程图标）、成员、最近动态、待办统计、未解决批注数、翻译进度。
- **故事**：大纲、场景列表、按行只读显示（角色名、台词、旁白、指令折叠显示），每行旁边显示批注标记，**可以直接写批注**。
- **蓝图**：只读节点图，可以缩放和平移，节点能点开看属性；在节点上写批注。
- **资源**：按分类浏览，图片和音频能在线预览，显示元数据和被谁引用（引用关系能从资源登记读出来就显示）。
- **角色、变量、本地化键**：只读表格。
- **提交历史**：列表加单个修订详情（改了哪些文件、提交说明）；**可以切到任意修订去看当时的故事和资源**。
- **讨论**：项目级讨论串（就是现在启动器里那个）。
- **待办**：项目看板（待办／进行中／完成），可以指派。

**团队与个人设置**
- 团队名、LOGO、主题色、登录页背景、欢迎语（管理员改）。
- 头像上传和裁剪、显示名、简介、语言、通知偏好（个人改）。

### 2.2 建议补充的前台功能

| 功能 | 为什么 | 优先级 |
|---|---|---|
| **通知中心 + @提及** | 网页最大的价值是「没开 Studio 也知道有人找我」。批注里 @人、被指派待办、我写的那行被回复，都发通知 | P1 |
| **「在 Studio 中打开」深链** | 网页上看到一行，点一下 Studio 就打开并跳到那一行。需要 Studio 注册 `narraleaf://` 协议 | P1 |
| **全局搜索** | 在手机上搜台词、角色名、资源名，最常见的问题就是「那句话在哪」 | P1 |
| **移动端优先 + PWA** | 需求本身就是「在外面没电脑」。PWA 能装到主屏幕 | P1 |
| **未读与关注** | 关注某个项目或场景，有新提交或新批注时提醒；跨项目汇总未读 | P2 |
| **审阅请求** | 「请 @小李 审第 3–5 章」，对一段修订范围发起审阅，审阅人逐行批注后标「通过／需修改」。像轻量版 PR，但不涉及合并 | P2 |
| **试玩包下载页** | 构建产物上传后，团队成员在手机上就能下载 Web 版或安装包试玩（复用 blobs） | P2 |
| **外部通知（Webhook）** | 推到飞书、Discord、企业微信群：新提交、待办到期、审阅请求 | P2 |
| **翻译／配音进度看板** | 每种语言、每个场景的完成度，配音缺哪些行 | P3 |
| **只读分享链接** | 带有效期、限定某个修订的只读链接，给外包或发行商看。默认关闭，管理员开启 | P3 |

### 2.3 管理后台 `/admin`（只有 admin 组能看到这个入口）

协议里 `admin.*` 本来就有一整套，Studio 一个都没接，**后台直接用它们，不新建管理接口**：
- 账号：创建、停用、重置密码、强制登出（递增 `token_epoch`）、看此人已登录的设备。
- 项目：注册、改名、归档、**成员与角色**。
- 品牌：LOGO、团队名、主题色。
- 安全：签名密钥轮换、证书状态、审计日志（`decisions` 表 + `admin/refusals`）。
- 服务器：令牌有效期、协作开关、存储占用、loreserver 健康状态。
- 已授权的应用和设备：哪些 Studio 拿着刷新令牌，可以吊销。

---

## 3. 定下来的方向

| 决策 | 结论 |
|---|---|
| D1 网页能否编辑内容 | **不能**。只看、批注、待办、管理 |
| D2 网页怎么看内容 | **服务器只转发原始文件，不解析**；浏览器用共享查看包解析和渲染 |
| D3 权限 | **恢复项目级角色** |
| D4 Studio 登录 | **Team 当 OAuth2 授权服务器**，Studio 是公共客户端（授权码 + PKCE，回调到本机回环地址） |
| D5 批注 | **有 Team 时以服务器讨论串为准**，项目内文件作离线缓存和无 Team 时的存储 |
| D6 待办 | **新建 `todos` 表**，不复用 overlay（理由见 §4.4） |
| D7 网页会话 | 同源 HttpOnly Cookie 会话，WebSocket 同源升级时带 Cookie，加 Origin 校验 |

---

## 4. 技术方案

### 4.1 内容查看：原始文件代理 + 浏览器端查看包

**服务器**新增一条只读路由：

```
GET /api/team/v1/projects/:id/raw/:revision/*path
```

- 从 `src/projects/cache.ts` 管的裸克隆按修订取文件，**原样返回字节，不解析**。这跟 `content.ts` 现在读工程文件走的是同一条路。
- 鉴权：Cookie 会话或 Bearer；角色至少是 viewer。
- 防护：路径规范化后再查文件树（防 `..`）；单文件大小上限；`Content-Type` 按白名单给，其余一律 `application/octet-stream` 加 `Content-Disposition: attachment`；SVG 和 HTML 配 `Content-Security-Policy: sandbox`；修订 id 不可变，所以可以给 `Cache-Control: immutable`。
- 另加 `GET …/tree/:revision` 返回文件树（`content.ts` 已经有这份数据）。

**浏览器**用新包 `@narraleaf/project-view`：
- 从 Studio 的 `src/shared/` 抽出只读部分：故事文档的类型和规范化、UI 文档和蓝图节点的类型、资源登记、角色和变量的类型。**只抽纯数据代码，不带 React、不带 Electron**。
- Studio 和网页都依赖这个包，Studio 那边换成从包里导入，保证两边只有一份。
- 每类文档带 schema 号。遇到更高的号就整块显示「这个修订是新版 Studio 写的，需要更新 Team」，不猜着渲染。这跟 `content.ts` 的降级规则一致。
- 蓝图渲染：只画节点、连线和属性面板，用节点注册表里的名字和引脚定义（Studio 有 `project/app/blueprint.js` 能导出注册表，可以生成一份 JSON 打进包里）。

**为什么这么做**：服务器还是不懂 Studio 的格式，「锚点永不解析」「服务器不随 Studio 升级」这两条约束不破。Studio 改了格式，只需要发一个新版查看包，Team 重新构建前端即可，服务端代码不用动。

### 4.2 批注统一

- **有 Team 的项目**：行级批注写 Team 的 `threads.*`。锚点约定：`document = "story:<storyId>"`，`element = <blockId>`，`revision = 当前基修订`。蓝图用 `document = "ui:<docId>"`，`element = <nodeId>`。锚点字符串的约定写进 `@narraleaf/team-protocol` 的共享词汇表，**服务器照样不解析**。
- **没有 Team 的项目**：继续用 `editor/story-comments.json`（`StoryCommentsService.ts`）。
- **迁移**：项目第一次关联 Team 时，Studio 提示「把 N 条本地批注上传到服务器」。用 `comments.client_id` 唯一索引保证重复上传不会出现两条。上传后本地文件只当离线缓存用。
- 网页和 Studio 看到的是同一批讨论串，服务器推送，实时同步（也顺带解决了「批注不走 Live」的问题）。

### 4.3 动态与贡献图

新 migration：

```sql
CREATE TABLE activity (
  id         INTEGER PRIMARY KEY,
  account_id TEXT,              -- 对应不上账号时为 NULL，此时 actor_label 保留原始字符串
  actor_label TEXT,
  project_id TEXT,
  kind       TEXT NOT NULL,     -- commit | thread | comment | resolve | todo-done | join | live
  ref        TEXT,              -- 修订 id / thread id / todo id，用来跳转，不存正文
  at         INTEGER NOT NULL
);
CREATE INDEX activity_by_account ON activity(account_id, at);
CREATE INDEX activity_by_project ON activity(project_id, at);
```

- **提交活动**：`src/projects/refresh.ts` 每分钟刷新时，发现新修订就写一行 `commit`。按 P0 实测（§10），`committed-by` 是客户端随便写的，所以这样归属：
  1. Studio 提交时，在修订元数据里多写一个键 `narraleaf-account = <令牌 sub>`（跟 `committed-by` 放在同一处），已登录时写，离线时不写。
  2. Team 读到这个键，并且推送窗口内确实有该账号对这个仓库的令牌交换或访问检查记录（`decisions` 表和 auth 日志），才算「已核实」，计入那个人的贡献图。
  3. 没有这个键或核对不上的，`account_id` 留空，`actor_label` 存 `committed-by` 原文；时间线上显示原文名字并标「未核实」，不计入任何人的贡献图。
  4. 再进一步（可选）：让 loreserver 的访问检查带上读写区分和修订 id，就能做到逐修订精确归属。要看 Lore 是否支持，先不依赖。
- 批注、待办这类活动在对应方法里同步写入。
- 贡献图 `activity.heatmap({ tzOffsetMinutes })` 按客户端时区分桶。
- 可见性：只返回调用者有权看的项目的活动。私密待办的完成**不计入**别人看到的时间线，但计入本人的贡献图。

### 4.4 待办：新建 `todos` 表

旧计划想复用 overlay，这次不行：「是否显示给团队成员」要服务器来过滤，而 overlay 的 body 服务器不读，也没有按人可见的概念。

```sql
CREATE TABLE todos (
  id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, assignee_id TEXT,
  project_id TEXT,                 -- NULL 表示个人待办，不属于任何项目
  document TEXT, element TEXT, revision TEXT,   -- 可选锚点，不解析
  title TEXT NOT NULL, body TEXT, status TEXT NOT NULL,  -- open | doing | done
  visibility TEXT NOT NULL,        -- private | project
  due_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, done_at INTEGER
);
```

协议加 `todos.list / create / update / delete`，新增能力 `todos`，topic `account:{id}/todos` 和 `project:{id}/todos`。overlay 保持原来「附加在修订上的数据」的定位。

### 4.5 品牌与头像

- 品牌存 `settings` 表（`team.name`、`team.accent`、`team.logo` 存 blob 的 id）。发现文档里带上团队名和 LOGO 地址，**Studio 启动器的服务器卡片也能显示 LOGO**。
- 头像：`users` 加 `avatar_blob`、`bio` 两列。上传走现有 blobs 存储；服务端解码后重新编码成 256×256 WebP 再存（顺便去掉 EXIF，也防恶意图片），大小上限 2MB。
- 协议里 `members.list`、评论作者都带上 `avatarUrl`，Studio 的批注和在场列表一起显示头像。

### 4.6 项目级角色

```sql
CREATE TABLE project_members (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role       TEXT NOT NULL,    -- owner | editor | reviewer | viewer
  added_by TEXT, added_at INTEGER NOT NULL,
  PRIMARY KEY (project_id, user_id)
);
```

| 角色 | 仓库 | 批注 | 待办 | 管理成员 |
|---|---|---|---|---|
| owner | 读写 | ✓ | ✓ | ✓ |
| editor | 读写 | ✓ | ✓ | — |
| reviewer | **无**（在网页上看） | ✓ | ✓ | — |
| viewer | **无**（在网页上看） | 只看 | 只看自己的 | — |

（2026-11-13 定：因为 loreserver 不分读写，reviewer/viewer 在仓库层就是非成员，只能通过 Team 读项目。已实现：migration 12、`src/projects/members.ts`、四个授权应答和协议的可见性检查。）

- ⚠ **实测（2026-11-13，§10 实测三）：loreserver 0.8.6 不区分读和写。** 把令牌和权限应答里的权限都改成只有 `read`，推送照样成功。它真正执行的只有「是不是成员」：Team 应答 denied 的项目根本打不开。所以 reviewer 和 viewer 的「只读」在仓库层**拦不住**，只能靠 Studio 界面限制，并由 Team 事后发现（见 §10）。
- 服务器级 `admin` 视同所有项目的 owner。
- **迁移**：把现有账号全部以 editor 身份加进每个现有项目，升级后行为不变。可以加一个设置项「新账号默认加入所有项目」，兼容现在的小团队用法。
- loreserver 问「这个令牌能否写这个仓库」时，按角色回答（`registry.ts` 里现在那一句「全员可访问」的规则改掉）。
- 协议：`projects.list` 只返回有成员身份的项目；`members.*` 加 `role`；hello 帧里给出当前用户在每个项目的角色，**Studio 按角色隐藏它做不了的操作**（比如 reviewer 看不到「提交」按钮）。
- 注意：这一条推翻了 migration 7 的裁决，`docs/architecture.md` 要写清楚理由：有了网页、外包和审阅者，「全员可见」已经不够用。

### 4.7 前端工程

- Vite + React + TypeScript，单独放在 `web/` 目录。构建产物打进 `dist/console/`，跟 `nlteam.js` 一起构建。**运行时依赖还是只有 koffi**。
- 路由：`/` 跳到个人主页，`/login`、`/u/:name`、`/p/:id/...`、`/notifications`、`/settings`、`/admin/...`、`/oauth/...`（授权页）。
- 数据：登录后连**同一条** `/api/team/v1/socket`，走现有协议方法，不新开一套 REST。REST 只加：登录和登出、OAuth 端点、原始文件和文件树、上传。
- 移动端优先的响应式布局，加 PWA manifest。视觉复用 Studio 的设计令牌（见 §4.8），不复用组件。
- 国际化复用 Team 的 `src/i18n`（zh/en/ja）。

### 4.8 界面与视觉风格

**原则：页面结构和交互参考成熟产品，视觉完全用 NarraLeaf 自己的设计规范。** 网页是 Studio 的延伸，用户在两边来回切换时应该觉得是同一个产品。

**参考对象（各取一块）**

| 产品 | 学什么 | 用在哪 |
|---|---|---|
| Gitea / Forgejo | 自部署产品的骨架：项目页标签、提交历史、修订详情、后台分区 | 项目页、历史、管理后台 |
| GitHub | 个人主页、贡献图、动态；逐行审阅和「建议修改」 | 个人主页、审阅请求 |
| Linear / Plane | 高密度但清楚的列表；Inbox 式通知；⌘K 命令面板；待办状态和指派 | 通知、待办、全局搜索 |
| Figma | 评论钉在可以缩放平移的画布上，手机上也能看能回 | 蓝图批注 |
| Frame.io | 素材审阅：评论锚定到图片或音频的时间点，标通过或需修改 | 资源页、资源需求单 |
| ShotGrid / ftrack | 制作管理：资源需求、指派、进度看板 | 需求单、翻译和配音进度 |
| 飞书文档 | @提及和推送，手机端读和评论 | 移动端、通知 |

**NarraLeaf 设计令牌（来自 Studio `docs/design-system.md` 和 `src/renderer/styles/styles.css`）**

- 品牌色 `#40a8c4`（Leaf teal），两个主题同值；用在填充上（主按钮、选中背景、贡献图、焦点圈）。
- 主色上的文字用 `on-primary`，压在普通表面上的强调色文字用 `primary-ink`，按主题夹到 AA 4.5:1（亮色主题下是 `#2d768a`）。团队自定义主题色时沿用 `@shared/constants/accent` 的 `accentInk` / `accentForeground` 来算。
- 语义色：`binding #7e70c2`（审阅者、实时会话、故事指令行）、`danger #da6958`、`success #6db094`、`warning #ccaa5c`。
- 5 级表面：canvas → sunken（标题栏、侧栏）→ surface（主体）→ raised（卡片、批注栏）→ overlay（弹窗、菜单）。默认暗色，有完整的亮色主题。
- 文字三级：`fg` / `fg-muted` / `fg-subtle`；分隔线用半透明 `edge` / `edge-subtle`。
- 圆角：控件 `rounded-md`，浮层 `rounded-lg`，头像和 pill 用 `rounded-full`。
- 故事行高沿用 `--nl-story-row-box`（28px），网页和 Studio 的故事看起来一样。

**落地**
- 把 Studio `tailwind.config.js` 的 token 定义和 `styles.css` 的变量抽成共享包 `@narraleaf/design-tokens`，Studio 和网页都从这个包引用。
- 主题：Studio 靠 Electron 翻转系统主题；网页用 `prefers-color-scheme`，再加一个手动切换（写到根元素 class 上）。CSS 写法不变。
- 组件：只共享 token 和视觉语言。网页组件按触控尺寸重新做（点击区至少 40px），桌面宽度下再提高密度。

**画面清单（草图已确认方向）**
1. 个人主页：头像和各项目角色 / 贡献图 / 动态 / 我的待办（团队可见或仅自己）。
2. 项目 · 故事：左侧项目导航，中间只读故事行加修订切换，右侧该行的批注栏，右上角「在 Studio 中打开」。
3. 手机：底部五个标签（首页、项目、通知、待办、我），通知页和资源网格页。
4. 管理后台：左侧分区，项目成员和角色表，存储、在线客户端、证书状态。
5. Studio 授权页：团队 LOGO 和 NarraLeaf 图标并排，列出能做和不能做的事，允许或取消，并提示可以随时撤销。

---

## 5. 登录流程重构：Team 当 OAuth2 授权服务器

### 5.1 网页登录

- 账号密码，复用 `src/identity/passwords.ts`（scrypt）和 `signin.ts` 的限速器。可选 TOTP 二步验证。
- 新表 `web_sessions(id_hash, user_id, created_at, last_seen_at, expires_at, user_agent)`。Cookie 设成 `HttpOnly; Secure; SameSite=Lax`，滑动续期，可以吊销。
- CSRF：所有写操作走 WebSocket（升级请求要校验 Origin），REST 写操作要求自定义请求头加同源校验。
- **这一条改写了「没有会话可以登出」的原则**，要在 `docs/security.md` 里写明：网页需要会话，Studio 和命令行仍然用无状态令牌。

### 5.2 Studio 登录（RFC 8252：原生应用用授权码 + PKCE）

```
作者在 Studio 输入服务器地址（或者在网页上点「在 Studio 中连接」）
  → Studio 读 /.well-known/nlteam（新增 authorization_endpoint / token_endpoint / device_endpoint）
  → Studio 在 127.0.0.1 随机端口开一个临时监听，生成 code_verifier 和 state
  → 打开系统浏览器：https://team.example/oauth/authorize?client_id=narraleaf-studio
       &redirect_uri=http://127.0.0.1:<port>/cb&code_challenge=…&state=…
  → 浏览器里：没登录就先登录（复用网页会话），然后显示授权页
       「允许『小王的 MacBook』上的 NarraLeaf Studio 访问 <团队名>？」
  → 跳回 127.0.0.1/cb?code=…，Studio 用 code + verifier 换令牌
  → 拿到 access_token（就是现在的 JWT，声明完全不变，loreserver 不受影响）
       + refresh_token（只存哈希，每次使用就轮换，绑定设备名）
```

- 公共客户端，不需要 client secret。`client_id` 固定写死，回调只认 `127.0.0.1` / `[::1]` 的回环地址（RFC 8252 §7.3 允许任意端口）。
- access_token 有效期从 30 天缩短到 1 小时，Studio 用 refresh_token 静默续期。`token_epoch` 吊销机制保留，刷新时同样检查。
- 新表 `oauth_grants(id, user_id, client_id, device_name, refresh_hash, created_at, last_used_at, revoked_at)`，网页「已登录设备」直接读这张表。
- Studio 侧：`serverPassword.ts` 换成 `serverOAuth.ts`；`serverTokens.ts` 照旧用 safeStorage 存，多存一个 refresh_token。

### 5.3 「输入链接」和备用路径

- **连接链接**：网页上「在 Studio 中连接」生成 `narraleaf://team/connect?server=https://team.example`。Studio 要注册协议：macOS 处理 `open-url`，Windows 和 Linux 从 `second-instance` 的 argv 里取。打开后自动走 5.2。
- **深链**：`narraleaf://team/open?server=…&project=…&doc=story:…&element=…` 打开项目并定位到那一行。Studio 打开前**必须确认**服务器和项目都是已经连接过的，不然只提示，不自动连接（防钓鱼链接）。
- **设备码（RFC 8628）**：没法在本机开浏览器的时候（远程桌面、浏览器在另一台设备上），Studio 显示 `ABCD-EFGH` 和网址，用手机登录网页输入这个码就行。
- **急救**：`nlteam token mint --root` 加粘贴令牌这条路保留。
- **兼容**：`POST /api/studio/v1/sign-in` 保留一个大版本，标为 deprecated。发现文档里新增能力 `oauth`；Studio 看到 `oauth` 就走浏览器登录，看不到就退回密码登录。

### 5.4 证书：要先解决的现实问题

浏览器不认 Team 自签的 CA，打开网页就是红色警告，OAuth 跳转也会卡在这里。
- 推荐：正式部署用受信证书（`src/tls/supplied.ts` 已经支持 `--tls-cert`），文档里给 Caddy 反代和 ACME 的示例。
- 内网自签：网页登录页提供 CA 下载和各平台安装说明；令牌里的 `authority_sha256` 照旧给 Studio 用。
- 同时修掉 `callbackUrl()`（§1 第 2 条），并且实测 Lore 的 `authLoginWithToken` 在 https authUrl 下的真实 JWT 路径（现状文档 §1 第 8 条）。

---

## 6. Studio 侧可以做的协作增强

按「做的成本 / 团队收益」排序。标 ★ 的依赖本次服务器改动。

**P1：跟网页同时上线**
1. ★ **行级批注接 Team 讨论串**（§4.2），一套数据，Studio 和网页互通。
2. ★ **@提及 + Studio 内通知**：标题栏铃铛，点开跳到对应行；跨项目未读汇总在启动器。
3. ★ **行级待办／指派**：故事行和蓝图节点右键「新建待办并指派给…」。
4. ★ **浏览器登录 + 连接链接 + 深链**（§5）。
5. ★ **按角色限制界面**：reviewer 进入「审阅模式」，只能批注，编辑器只读。
6. **提交时关联**：提交对话框列出「我负责的未完成待办」，勾选后提交即完成，并在动态里关联这个修订。

**P2：提升实时协作**
7. **Live 在场光标和选区**：在故事行、蓝图节点上显示其他人的位置和颜色（走现有 `live.say` 负载，不改服务器）。
8. **Live 聊天和「跟随某人」**：跟随模式下自动跳到对方正在看的场景。
9. **软锁提示**：不在 Live 里时，用 `clients.announce` 带上「正在编辑的文档」，别人打开同一章时提示「小李 10 分钟前在改这一章」。
10. **建议修改**：`comments.suggestion` 字段已经有了（64KB），审阅者可以提交「改成这样」，作者一键采纳，生成一次普通编辑。
11. ★ **审阅请求**：选一段修订范围发起审阅，审阅人在 Studio 或网页上逐行批注，标「通过／需修改」。
12. **提交前提醒**：要提交的场景里有未解决的批注，或者别人刚推了冲突风险高的修改，提交前提示一下。

**P3：生产流程**
13. ★ **资源需求单**：编剧在某一行标「需要立绘：xx 哭泣差分」，美术在网页看板接单，上传资源后自动关联回那一行。
14. ★ **翻译／配音分配**：按语言和场景分配给人，进度汇总到网页看板。
15. ★ **里程碑和版本标签**：给修订打「Demo 1」这类标签，网页上能按标签切换查看。
16. ★ **Webhook**：推到飞书、Discord 等群。
17. **Live 会话里重基到新修订**（现在遇到会拒绝）。

---

## 7. 分阶段路线

每个阶段结束都要过：`npm run typecheck / test / lint`，`npm run contract` 之后 `git diff --exit-code`，Studio 的 `teamContract.test.ts` 也要是绿的。

| 阶段 | 内容 | 验收 |
|---|---|---|
| **P0 裁决与实测**（几天） | 把 D1–D7 写进 `architecture.md` 和 `security.md`；~~实测提交作者跟账号怎么对应；实测真实 JWT 登录路径~~（2026-11-13 已完成，见 §10） | 文档合入；两项实测有结论 ✅ |
| **P1 地基** | 修 `callbackUrl` 和 `call.ts` identity；`project_members` 加迁移；`web_sessions`；`/console/*` 静态服务；Cookie 登录；同源 WebSocket；抽出 `@narraleaf/design-tokens` 并搭好网页外壳 | 浏览器能登录并连上 socket 收到 hello；升级后旧账号对旧项目权限不变 |
| **P2 OAuth** | authorize/token/device 端点、授权页、`oauth_grants`、刷新令牌轮换；Studio 的 `serverOAuth.ts` 和协议注册 | Studio 输入地址 → 浏览器登录 → 回到 Studio 已登录；吊销设备后 Studio 下次刷新被拒；没有 `oauth` 能力的旧服务器仍能用密码登录 |
| **P3 内容查看** | raw/tree 路由；`@narraleaf/project-view` 包，Studio 改成从包导入；网页上的故事、蓝图、资源、历史 | 手机上能看任意修订的故事和蓝图；新 schema 显示降级提示；路径穿越测试被拒 |
| **P4 协作数据** | `activity`、`todos`、通知、头像、品牌；协议扩展和契约重新生成 | 个人主页的时间线、贡献图、待办可见性都正确；私密待办别人拿不到（协议层测试） |
| **P5 批注统一** | Studio 行级批注接 Team、本地批注迁移、网页写批注 | Studio 写的批注网页立即可见，网页写的 Studio 立即可见；重复迁移不产生重复条目 |
| **P6 管理后台** | 账号、项目和成员、品牌、安全、设备 | 全部用现有 `admin.*` 方法；非 admin 账号拿不到入口，也调不通方法 |
| **P7 Studio 增强** | §6 的 P1 剩余项，然后是 P2 | 逐项验收 |

---

## 8. 风险

| 风险 | 缓解 |
|---|---|
| 自签证书让网页和 OAuth 都卡住 | §5.4；`nlteam up` 时检测没有受信证书就打印引导 |
| 查看包跟 Studio 格式漂移 | 包从 Studio 的 `shared/` 抽出、两边共用；schema 号降级；CI 用 Studio 的示例工程跑一遍查看器 |
| 原始文件路由变成泄露面 | 按角色鉴权、路径规范化、类型白名单、审计日志记录读取 |
| 恢复角色破坏现有部署 | 迁移时全员默认 editor；加「新账号默认加入所有项目」开关 |
| 深链被拿来钓鱼 | 只对已连接的服务器生效，打开前先确认 |
| 网页变成「第二个 Studio」 | D1 写进 architecture.md，以后想改这条要先改文档 |
| 协议版本跨仓库同步 | `TEAM_PROTOCOL_VERSION` 升到 3；契约从 Team 生成后拷到 Studio，两边一起发版 |

## 9. 明确不做

- 网页上编辑故事、蓝图、资源，网页上合并或解决冲突。
- CI/构建流水线（试玩包只做上传和下载）。
- 公开注册（账号仍然由管理员创建）。
- Team 作为第三方应用的通用 OAuth 提供方（第一版 client 只认 Studio；以后要开放再说）。
- 完整的 issue 系统（里程碑、标签体系、状态机）。待办 + 审阅请求就够了。

---

## 10. P0 实测记录（2026-11-13）

**环境**：Team 主线 9d465e3，Node 24.19，内嵌 loreserver 0.8.6（darwin-arm64），`nlteam up --hostname localhost`，存储根放在临时目录；两个账号 `ada`（admin）和 `bob`（member）。客户端用的是 Studio f6e0aedee 自带的远程集成测试（`LORE_TEST_TOKEN` / `LORE_TEST_AUTH` / `LORE_TEST_REMOTE`），走的就是 Studio 真实的 `signInToServer` → Lore `authLoginWithToken` → 建库 / 推送 / 克隆 / 同步代码。历史作者用 Team 协议 `projects.history` 读出。

### 实测一：真实 JWT 登录路径

| 步骤 | 结果 |
|---|---|
| `POST /api/studio/v1/sign-in` 换令牌 | ✅ 200。声明里有 `sub`、`name`、`preferred_username`、`groups`、`authority_sha256`；账号没填邮箱时**没有 `email` 声明** |
| Lore `authLoginWithToken`（https authUrl） | ✅ `serverSession.integration.test.ts` 5/5 通过，包括「用真实令牌登录并在存储里找到账号」 |
| 登录后建库、推送（**主线代码**） | ❌ 全部失败：`repositoryCreate: connecting to remote: No token stored` |
| 原因 | loreserver 配置里的 `auth_url` 被写成 `https://127.0.0.1:41402`（`callbackUrl()`），但令牌和客户端会话都记在 `https://localhost:41402` 下。客户端按服务器报的地址去找令牌，找不到。改用 127.0.0.1 登录也不行：Studio 会拒绝，因为令牌声明的是 localhost |
| 把 `callbackUrl()` 改成返回 `authUrl(config)`（只在临时副本里改，没动仓库） | ✅ `remote.integration.test.ts` 6/7、`syncMergeAuthor.integration.test.ts` 2/2 通过。唯一失败的用例在断言里写死了 `127.0.0.1`，是测试本身的问题 |

**结论**：
- 真实 JWT 登录路径本身是通的（Lore 接受 https authUrl，`SSL_CERT_FILE` 指向 Team 的 CA 在 macOS 上就够了，**不用改钥匙串**）。
- 但**主线 Team 只要 `--hostname` 不是 127.0.0.1（也就是所有真实部署），登录后每次仓库操作都会失败**。`callbackUrl` 的修复是 P1 的第一件事，并且要加一条回归测试：用非 127.0.0.1 的主机名起服务，跑一次建库和推送。
- 顺带发现：每个推送或同步用例都要大约 30 秒，像是撞上了某个固定超时，P1 时要查清楚（可能跟 loreserver 的 `flush_delay_seconds: 10` 或通知超时有关）。
- 关于 `src/lore/call.ts:80` 写死 identity：这次 Team 自己的读取器能克隆、能读历史（`cache/projects/*.ready` 都在，`projects.history` 有数据），**没有构成阻塞**，可以降为代码清理。
- 现状文档里说「`nlteam up` 收 SIGINT 后进程不退出」：这次两次 SIGINT 都正常退出（exit 0），**没有复现**。

### 实测二：提交作者跟 Team 账号怎么对应

Studio 怎么写作者（`VcsManager.resolveIdentity` / `onlineIdentity`，`serverSession.ts:123`）：
- 普通提交：已登录时用令牌里的 `显示名 <邮箱>`（没邮箱就只有显示名），否则用本地设置 `versionControl.authorName`。
- 需要联网的操作（同步时自动产生的合并等）：写的是**账号 UUID**，之后 Studio 再用 `attributeAutomaticMerge` 改回作者名。

Team 读到的 `by`（都是 `bob` 用同一个令牌推上去的）：

| 项目 | 修订 | `by` |
|---|---|---|
| author-… | from b / base | `spec@narraleaf` |
| diverge-… | from b | `dcc525cd-58bd-…`（bob 的账号 UUID） |
| diverge-… | first | `test@narraleaf` |
| roundtrip-… | from the clone | `dcc525cd-58bd-…` |
| roundtrip-… | first | `test@narraleaf` |

**结论**：
- `committed-by` 是**客户端随便写的字符串，loreserver 和 Team 都不校验**。bob 推上去的修订可以署名成任何人。
- 同一个人的提交，作者字段可能是 `显示名 <邮箱>`、账号 UUID，或者旧的本地作者名，三种混在一起。
- Team 能确定知道的只有「哪个账号在什么时间拿令牌访问了哪个仓库」（auth 日志里的 `exchange` / `check`，`decisions` 表），但这些记录不区分读写，也不带修订 id。
- 所以贡献图**不能**按 `committed-by` 统计。采用 §4.3 的方案：Studio 写 `narraleaf-account` 元数据键，Team 用访问记录交叉核对，核对不上的标「未核实」，不计入任何人。另外，Studio 应该在登录后把邮箱和显示名补全（建议账号必须填邮箱），让显示出来的作者名一致。

### 留下的东西

- 临时存储根、打过补丁的构建副本和测试脚本都在 Claude 的临时目录里，没有动这个仓库的代码。
- 测试在服务器上登记了 7 个 `*-mwew…` 项目，都在临时存储根里，删掉目录就没了。
- Lore 在本机的用户级会话存储里留了一条 `lore://localhost:41337` 下 `bob` 的登录记录（测试账号，服务器已经停了）。

### 实测三：loreserver 是否区分读写（2026-11-13）

做法：临时副本里把 `PROJECT_PERMISSIONS` 改成只有 `["read"]`。这样登录交换出来的令牌、`CheckUserPermission` 和 `LookupUserPermissions` 的应答里都只有读权限。然后跑 Studio 的「克隆并来回推送」「拒绝分叉推送后同步合并」两个用例。

结果：**两个用例都通过，推送成功**。auth 日志里只有 `check … allowed` 和 `multiresource … allowed`，loreserver 从没问过「能不能写」。这跟 `src/projects/registry.ts` 注释里说的「repository authorizer never looks at the verbs」一致。

结论：
- 能在仓库层执行的只有**成员资格**：不是成员就 denied，打不开。
- 「只读角色不能推送」做不到，除非 Lore 以后支持按动词授权。
- 可选的处理方式：(a) reviewer/viewer 在仓库层照样能写，只在 Studio 界面上隐藏提交和推送，Team 在刷新时发现非可写角色推上来的修订就记审计、通知 owner；(b) 只读角色干脆不给仓库访问权，只能在网页上看（网页读的是 Team 自己的检出，不需要他们本人有仓库权限），批注和待办都走协议；(c) 先只做成员资格，角色延后。

---

## 11. 进度（2026-11-14）

| 阶段 | 状态 | 说明 |
|---|---|---|
| P0 | ✅ | 裁决写入 architecture/security；三项实测记录在 §10 |
| P1 | ✅ | 项目角色（migration 12）、成员管理协议、项目事件只发给相关账号；`web_sessions`（migration 13）、Cookie 登录、同源 WebSocket、`/console` 静态服务、`@narraleaf/design-tokens` 与网页外壳；HTTP/2 上非 gRPC 请求改走网页处理器（浏览器协商 h2，否则网页不可达） |
| P2 | ✅ | OAuth：授权码+PKCE、设备码、刷新令牌轮换与重放检测（migration 14）；令牌带 `grant` 声明，吊销设备立即生效；访问令牌沿用登录令牌时长（会话每次调用都校验过期，1 小时会让 Studio 每小时断线）；Studio「在浏览器中登录」、后台续期、`narraleaf://` 连接链接 |
| P3 | ✅ | `tree`/`raw` 只读路由；`@narraleaf/project-view` 读故事/角色/资源/蓝图；网页故事、蓝图、资源、历史查看器。「Studio 从包导入」改为 schema 版本握手：Studio 导出 `projectSchemas.json`，Team 拷贝为 `project-view/studio-schemas.json` 并测试读取上限一致（Studio 不需要只读视图模型，会漂移的是版本号） |
| P4 | ✅ | 动态、贡献图、待办、通知、头像（migration 15）；网页主页、待办看板、通知铃、个人设置。头像由浏览器裁剪重编码，服务器只校验格式与大小（无图像库） |
| P5 | ✅ | Studio 行级批注与 Team 讨论串双向同步（clientId 幂等）；网页按行写批注；查看者不能写；修复：按 id 读写讨论串时未校验项目可见性 |
| P6 | ✅ | 网页管理后台：账号、项目成员、品牌（主题色/LOGO）与设置、签名密钥与审计、服务器状态；`admin.brand.set` |
| P7 | 进行中 | 已做：Studio 通知铃（点击跳到对应批注行）、行待办→Team 项目待办（解决即完成）、审阅者/只读成员提示；**提交时关联待办**（提交表单勾选我负责的待办，提交后标完成并记下 `doneRevision`，migration 16，网页待办卡片链到该修订）；**软锁提示**（`clients.announce` 带 `editing`，打开别人正在编辑的故事/蓝图时提示是谁、多久，不加锁）；**提交前提醒**（这次修改的故事里有未解决批注时在提交按钮旁提示）；**Live 光标、聊天与跟随**（独立的 `cursor`/`chat` 负载走 `live.say`，不经主持方，服务器与旧版 Studio 不受影响；故事行显示他人光标，蓝图目前只到文档级）。**未做**：建议修改一键采纳、审阅请求、资源需求单、翻译分配、里程碑、Webhook、Live 内重基 |

锚点约定（Studio 与网页共用，服务器不解析）：故事行 `document = story:<storyId>`、`element = <sceneId>/<blockId>`；蓝图节点 `ui:<blueprintId>` / `<graphId>/<nodeId>`。
