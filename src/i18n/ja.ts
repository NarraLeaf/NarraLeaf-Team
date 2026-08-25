/**
 * 日本語。
 *
 * The same two habits as the Chinese catalogue. What Team recorded — a
 * username, a project's name, a group, a `kid`, the detail of a decision — is
 * left exactly as it is; only the sentence around it is Japanese. And the
 * clauses that say how far a thing reaches ("次のリクエストから") are the
 * reason these sentences exist, so they survive any rewording.
 */
import type { Messages } from "./messages.js";

export const ja: Messages = {
  locale: "ja",
  name: "日本語",

  format: {
    unknown: "不明",
    never: "なし",
    justNow: "たった今",
    secondsAgo: (seconds) => `${seconds}秒前`,
    minutesAgo: (minutes) => `${minutes}分前`,
    hoursAgo: (hours) => `${hours}時間前`,
    yesterday: "昨日",
    daysAgo: (days) => `${days}日前`,
    duration: (amount, unit) =>
      `${amount}${{ day: "日", hour: "時間", minute: "分", second: "秒" }[unit]}`,
    durationWords: [
      ["時間", "h"],
      ["日", "d"],
      ["分", "m"],
      ["秒", "s"],
    ],
  },

  page: {
    nav: {
      overview: "概要",
      projects: "プロジェクト",
      members: "メンバー",
      decisions: "アクセス記録",
      settings: "設定",
    },
    gate: {
      username: "ユーザー名",
      password: "パスワード",
      signIn: "サインイン",
    },
    shell: {
      signOut: "サインアウト",
      dismiss: "閉じる",
      reconnecting: "再接続中",
      language: "言語",
    },
    overview: {
      projects: "プロジェクト",
      members: "メンバー",
      signingKeys: "署名鍵",
      reach: "接続先",
      recentDecisions: "最近のアクセス記録",
      allDecisions: "すべての記録",
      state: "状態",
      healthy: "正常",
      notAnswering: "応答なし",
      version: "バージョン",
      checked: "最終確認",
      storage: "使用量",
      storageRoot: "ストレージの場所",
      signInAt: "サインイン先",
      data: "データ接続先",
      authority: "認証局",
      loopback: "ループバック",
    },
    projects: {
      newProject: "新しいプロジェクト",
      name: "プロジェクト名",
      create: "作成",
      cancel: "キャンセル",
      empty: "このサーバーにはまだプロジェクトがありません",
      revisionCount: (revisions) => `${revisions} リビジョン`,
      owner: "オーナー",
      created: "作成日",
      branch: "ブランチ",
      revisions: "リビジョン数",
      repository: "リポジトリ",
      lastRevision: "最新のリビジョン",
      message: "メッセージ",
      projectFile: "プロジェクトファイル",
      title: "タイトル",
      stage: "ステージ",
      scenes: "シーン数",
      assets: "アセット",
    },
    members: {
      account: "アカウント",
      role: "ロール",
      projects: "プロジェクト",
      added: "追加日",
      state: "状態",
      none: "なし",
      active: "有効",
      disabled: "無効",
      serviceAccount: "サービスアカウント",
      enable: "有効にする",
      disable: "無効にする",
      revokeTokens: "トークンを失効",
      newAccount: "アカウントを作成",
      username: "ユーザー名",
      displayName: "表示名",
      email: "メールアドレス",
      password: "パスワード",
      operator: "管理者",
      create: "作成",
      cancel: "キャンセル",
      issueToken: "トークンを発行",
      tokenFor: ({ username }) => `${username} のトークン`,
      tokenShownOnce: "表示はこの一回だけです。このサーバーは控えを保存しません。",
      done: "完了",
    },
    decisions: {
      when: "日時",
      account: "アカウント",
      resource: "リソース",
      answer: "結果",
      detail: "詳細",
      allowed: "許可",
      refused: "拒否",
      empty: "このサーバーはまだ何も尋ねられていません",
    },
    settings: {
      change: "変更",
      save: "保存",
      cancel: "キャンセル",
      rotateKey: "署名鍵をローテーション",
      groupNames: {
        server: "サーバー",
        tokens: "トークン",
        identity: "アイデンティティ",
        loreserver: "loreserver",
        authority: "認証局",
      },
      rowNames: {
        name: "名前",
        "sign-in token": "サインイントークンの有効期間",
        "repository token": "リポジトリトークンの有効期間",
        issuer: "発行者",
        audience: "オーディエンス",
        hostnames: "ホスト名",
        "pinned version": "固定バージョン",
        "data port": "データポート",
        "storage root": "ストレージの場所",
        fingerprint: "フィンガープリント",
      },
      repositoryCaution:
        "loreserver はこのトークンを Team に問い合わせずに受け入れるため、アクセス権を取り消しても途中で切ることはできません。",
    },
  },

  action: {
    keyRotated: ({ kid, published }) =>
      `これからは ${kid} で署名します。公開中の ${published} 個の鍵で署名されたトークンは引き続き検証できます`,
    userDisabled: ({ username }) =>
      `${username} を無効にしました。今後は何も発行されず、発行済みのトークンも拒否されます`,
    userEnabled: ({ username }) => `${username} を有効にしました`,
    tokensRevoked: ({ username, lifetime }) =>
      `${username} のトークンを失効させました。すでに開いている接続は、そのリポジトリトークンが切れるまで、最大 ${lifetime} 続くことがあります`,
    settingReadOnly: "この行は読み取り専用です",
    settingChanged: ({ label, value }) =>
      `${label}は ${value} になりました。発行済みのトークンは受け取った有効期間のままです`,
    accountCreated: ({ username, group }) =>
      `${username} を ${group} に作成しました。サインイン用のトークンを発行して渡してください`,
    tokenIssued: ({ username, lifetime }) =>
      `${username} のサインイントークンです。有効期間は ${lifetime} です`,
    projectCreated: ({ project, owner }) => `${project} を作成しました。オーナーは ${owner} です`,
    // レベルはデータで、サーバーが保存しているのは read / write そのものです。
    // それを日本語で読ませるのはこの文の仕事で、データベースの仕事ではありません。
    loreserverNotOurs:
      "loreserver は起動した nlteam up のものです。そちらを停止して起動し直してください",
  },

  refusal: {
    notSignedIn: "このブラウザーはサインインしていません",
    sessionEnded: "このセッションは終了しました",
    // 英語と同じく一文だけ。「そのアカウントはありません」と言えば、
    // ブラウザーさえあれば誰でもアカウントを数え上げられてしまいます。
    signInRefused: "ユーザー名かパスワードが違います",
    // ここから拒否された回数だけを伝え、尋ねられたアカウントの有無には触れません。
    tooManySignIns: ({ seconds }) =>
      `ここからのサインインが何度も拒否されました。${seconds} 秒後にもう一度お試しください`,
    notAnOperator: ({ group }) =>
      `ウェブ画面は ${group} グループのためのもので、このアカウントは含まれていません`,
    needUsernameAndPassword: "ユーザー名とパスワードが必要です",
    fromSomewhereElse: "このリクエストは別のサイトから来ています",
    needsJson: "この経路は JSON の本文を受け取ります",
    notJson: "このリクエストは JSON ではありません",
    tooLong: "このリクエストは長すぎます",
    notAnAction: "これは操作ではありません",
    notSomethingWeDo: "このサーバーはそれを行いません",
    projectNeedsNameAndOwner: "プロジェクトには名前とオーナーが必要です",
    needsAccount: "アカウントが必要です",
    accountNeedsUsernameAndPassword: "アカウントにはユーザー名とパスワードが必要です",
    needsAccountAndDisabled: "アカウントと、無効にするかどうかが必要です",
    settingNeedsRowAndValue: "設定にはどの行かと新しい値が必要です",
    nothingAtThatAddress: "そのアドレスには何もありません",
    methodNotAllowed: "そのメソッドは許可されていません",
    wentWrong: "応答の途中で問題が起きました",
    interfaceIsOff:
      "このサーバーではウェブ画面が切られています。nlteam up --web で起動してください。",
    noInterfaceBuilt:
      "このビルドにはウェブ画面が入っていません。ビルドスクリプトを実行してから起動し直してください。",
    serverSilent: "このサーバーは応答していません",
    serverAnswered: ({ status }) => `サーバーは ${status} を返しました`,
  },

  error: {
    unknownUser: ({ username }) => `${username} というアカウントはありません。`,
    unknownProject: ({ project }) => `${project} というプロジェクトはありません。`,
    invalidProjectName: ({ project }) =>
      `「${project}」はプロジェクト名にできません。プロジェクト名は 1〜64 文字で、` +
      "英数字とピリオド・ハイフン・アンダースコアが使え、英数字で始まります。",
    projectNameTaken: ({ project }) => `${project} というプロジェクトはすでにあります。`,
    accountDisabled: ({ username }) =>
      `${username} は無効なので、トークンを発行できません。`,
    noSigningKey: ({ directory }) =>
      `${directory} の鍵はすべて退役していて、署名できるものがありません。ローテーションして新しい鍵を作ってください。`,
    invalidSetting: ({ label, value, minimum, maximum }) =>
      `${label}を「${value}」にはできません。トークンの有効期間は整数の秒で、最小 ${minimum}、最大 ${maximum} です。`,
    invalidServerName: ({ value, maximum }) =>
      `「${value}」はこのサーバーの名前にできません。名前は 1 文字以上 ${maximum} 文字以下で、` +
      "制御文字を含みません。アドレスではなく、人が読むラベルです。",
    notADuration: ({ value }) =>
      `「${value}」は期間ではありません。30分、48時間、7日 のように書いてください。`,
    durationTooSmall: "有効期間は 0 より大きくなければなりません",
    loreserverRefused: ({ detail }) => `loreserver に断られました: ${detail}`,
    loreserverSilent: "loreserver が応答しないため、何も作成されませんでした",
  },
};
