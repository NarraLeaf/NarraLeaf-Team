/**
 * 简体中文。
 *
 * Written to say what the English says, not to say it the same way. Two habits
 * of this catalogue are worth knowing before changing it:
 *
 *   - What Team recorded stays as Team recorded it. A username, a project's
 *     name, a group, a `kid`, the detail of a decision — none of them are
 *     translated, because the page would then show something the database does
 *     not hold. Only the sentence around them is Chinese.
 *   - The clauses that say how far something reaches are the point of these
 *     sentences, not decoration. "从下一次请求开始生效" has to survive any
 *     rewording, because that is the part an operator otherwise gets wrong.
 */
import type { Messages } from "./messages.js";

export const zh: Messages = {
  locale: "zh",
  name: "简体中文",

  format: {
    unknown: "未知",
    never: "从未",
    justNow: "刚刚",
    secondsAgo: (seconds) => `${seconds} 秒前`,
    minutesAgo: (minutes) => `${minutes} 分钟前`,
    hoursAgo: (hours) => `${hours} 小时前`,
    yesterday: "昨天",
    daysAgo: (days) => `${days} 天前`,
    duration: (amount, unit) =>
      `${amount} ${{ day: "天", hour: "小时", minute: "分钟", second: "秒" }[unit]}`,
    durationWords: [
      ["小时", "h"],
      ["分钟", "m"],
      ["天", "d"],
      ["秒", "s"],
    ],
  },

  page: {
    nav: {
      overview: "概览",
      projects: "项目",
      members: "成员",
      decisions: "授权记录",
      settings: "设置",
    },
    gate: {
      username: "用户名",
      password: "密码",
      signIn: "登录",
    },
    shell: {
      signOut: "退出登录",
      dismiss: "知道了",
      reconnecting: "正在重连",
      language: "语言",
    },
    overview: {
      projects: "个项目",
      members: "名成员",
      signingKeys: "把签名密钥",
      reach: "连接方式",
      recentDecisions: "最近的授权记录",
      allDecisions: "全部记录",
      state: "状态",
      healthy: "正常",
      notAnswering: "没有响应",
      version: "版本",
      checked: "最后检查",
      storage: "占用",
      storageRoot: "存储目录",
      signInAt: "登录地址",
      data: "数据地址",
      authority: "证书授权",
      loopback: "仅本机",
    },
    projects: {
      newProject: "新建项目",
      name: "项目名",
      create: "创建",
      cancel: "取消",
      empty: "这台服务器上还没有项目",
      revisionCount: (revisions) => `${revisions} 个修订`,
      owner: "拥有者",
      created: "创建于",
      branch: "分支",
      revisions: "修订数",
      repository: "仓库大小",
      lastRevision: "最后一次修订",
      message: "提交说明",
      projectFile: "项目文件",
      title: "标题",
      stage: "舞台",
      scenes: "场景数",
      assets: "资源",
    },
    members: {
      account: "账号",
      role: "角色",
      projects: "可访问的项目",
      added: "加入于",
      state: "状态",
      none: "无",
      active: "正常",
      disabled: "已停用",
      serviceAccount: "服务账号",
      enable: "启用",
      disable: "停用",
      revokeTokens: "吊销令牌",
      newAccount: "新建账号",
      username: "用户名",
      displayName: "显示名称",
      email: "邮箱",
      password: "密码",
      operator: "管理员",
      create: "创建",
      cancel: "取消",
      issueToken: "签发令牌",
      tokenFor: ({ username }) => `给 ${username} 的令牌`,
      tokenShownOnce: "只显示这一次。服务器不会保留它的副本。",
      done: "完成",
    },
    decisions: {
      when: "时间",
      account: "账号",
      resource: "资源",
      answer: "结果",
      detail: "详情",
      allowed: "已放行",
      refused: "已拒绝",
      empty: "还没有人向这台服务器请求过什么",
    },
    settings: {
      change: "修改",
      save: "保存",
      cancel: "取消",
      rotateKey: "轮换签名密钥",
      groupNames: {
        server: "服务器",
        tokens: "令牌",
        identity: "身份",
        loreserver: "loreserver",
        authority: "证书授权",
      },
      rowNames: {
        name: "名称",
        "sign-in token": "登录令牌有效期",
        "repository token": "仓库令牌有效期",
        issuer: "签发者",
        audience: "受众",
        hostnames: "主机名",
        "pinned version": "锁定版本",
        "data port": "数据端口",
        "storage root": "存储目录",
        fingerprint: "指纹",
      },
      repositoryCaution:
        "loreserver 接受这个令牌时不会再问 Team，所以收回访问权限并不能让它提前失效。",
    },
  },

  action: {
    keyRotated: ({ kid, published }) =>
      `现在用 ${kid} 签名；已发布的 ${published} 把密钥签出的令牌仍然可以验证`,
    userDisabled: ({ username }) =>
      `已停用 ${username}；从现在起不再签发任何令牌，已经签发的也会被拒绝`,
    userEnabled: ({ username }) => `已启用 ${username}`,
    tokensRevoked: ({ username, lifetime }) =>
      `已吊销 ${username} 的令牌；已经建立的连接可能还会持续到它的仓库令牌过期，最多 ${lifetime}`,
    settingReadOnly: "这一行是只读的",
    settingChanged: ({ label, value }) =>
      `${label}现在是 ${value}；已经签发的令牌仍然保留它们当初拿到的有效期`,
    accountCreated: ({ username, group }) =>
      `已创建 ${username}，属于 ${group}；还需要给他们签发一个登录令牌`,
    tokenIssued: ({ username, lifetime }) =>
      `给 ${username} 的登录令牌，有效期 ${lifetime}`,
    projectCreated: ({ project, owner }) => `已创建 ${project}，拥有者是 ${owner}`,
    // 权限本身是数据，服务器存的就是 read / write；把它读成中文是这句话的事，
    // 不是数据库的事。
    loreserverNotOurs: "loreserver 属于启动它的那个 nlteam up，请去停止并重新启动那个进程",
  },

  refusal: {
    notSignedIn: "这个浏览器没有登录",
    sessionEnded: "这个会话已经结束",
    // 和英文一样只说一句：说“没有这个账号”就等于让任何人都能枚举出服务器上有哪些账号。
    signInRefused: "用户名或密码不对",
    // 只说这里被拒了多少次，不提被问的账号在不在：上面那条规矩在这里同样适用。
    tooManySignIns: ({ seconds }) => `这里被拒绝的登录太多了，请 ${seconds} 秒后再试`,
    notAnOperator: ({ group }) => `网页界面只对 ${group} 组开放，这个账号不在其中`,
    needUsernameAndPassword: "需要用户名和密码",
    fromSomewhereElse: "这个请求来自别的站点",
    needsJson: "这个接口只接受 JSON 请求体",
    notJson: "这个请求不是 JSON",
    tooLong: "这个请求太长了",
    notAnAction: "这不是一个动作",
    notSomethingWeDo: "这台服务器不做这件事",
    projectNeedsNameAndOwner: "创建项目需要项目名和拥有者",
    needsAccount: "这需要一个账号",
    accountNeedsUsernameAndPassword: "创建账号需要用户名和密码",
    needsAccountAndDisabled: "这需要一个账号，以及要不要停用它",
    settingNeedsRowAndValue: "修改设置需要指明是哪一行和新的值",
    nothingAtThatAddress: "这个地址上没有东西",
    methodNotAllowed: "不允许这个请求方法",
    wentWrong: "回答这个请求时出了问题",
    interfaceIsOff: "这台服务器关闭了网页界面。用 nlteam up --web 启动它。",
    noInterfaceBuilt: "这个构建里没有网页界面。请运行构建脚本后重新启动服务器。",
    serverSilent: "这台服务器没有响应",
    serverAnswered: ({ status }) => `服务器回了 ${status}`,
  },

  error: {
    unknownUser: ({ username }) => `没有叫 ${username} 的账号。`,
    unknownProject: ({ project }) => `没有叫 ${project} 的项目。`,
    invalidProjectName: ({ project }) =>
      `“${project}”不能作为项目名。项目名是 1 到 64 个字符，可以用字母、数字、点、` +
      "短横线和下划线，并且以字母或数字开头。",
    projectNameTaken: ({ project }) => `已经有一个叫 ${project} 的项目了。`,
    accountDisabled: ({ username }) => `${username} 已被停用，不能为其签发令牌。`,
    noSigningKey: ({ directory }) =>
      `${directory} 里的密钥全部已退役，没有东西可以签名了。轮换一次以生成新的密钥。`,
    invalidSetting: ({ label, value, minimum, maximum }) =>
      `${label}不能是“${value}”。令牌有效期是一个整数秒，最少 ${minimum}，最多 ${maximum}。`,
    invalidServerName: ({ value, maximum }) =>
      `“${value}”不能作为这台服务器的名称。名称是 1 到 ${maximum} 个字符，且不含控制字符。` +
      "它是给人看的标签，不是地址。",
    notADuration: ({ value }) => `“${value}”不是一段时长。可以写成 30 分钟、48 小时或 7 天。`,
    durationTooSmall: "有效期必须大于零",
    loreserverRefused: ({ detail }) => `loreserver 拒绝了它：${detail}`,
    loreserverSilent: "loreserver 没有响应，所以什么都没有创建",
  },
};
