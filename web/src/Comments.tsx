/**
 * Comments on story lines, in the same threads Studio writes.
 *
 * The anchor vocabulary is shared with Studio and never parsed by the server:
 * `document` is `story:<storyId>`, `element` is `<sceneId>/<blockId>`, and
 * `revision` is the revision the comment was written against. A thread written
 * here shows in Studio's scene editor on the same line, and the reverse.
 */
import { useCallback, useEffect, useState, type FormEvent } from "react";

import { projectThreadsTopic, type TeamComment, type TeamThread } from "@narraleaf/team-protocol";

import { t } from "./i18n";
import type { TeamConnection } from "./socket";

/** The anchor document for one story. */
export function storyDocumentAnchor(storyId: string): string {
  return `story:${storyId}`;
}

/** The anchor element for one line of one scene. */
export function storyLineAnchor(sceneId: string, blockId: string): string {
  return `${sceneId}/${blockId}`;
}

/** Every thread on one story, by line, kept current by the project's threads topic. */
export function useStoryThreads(connection: TeamConnection, open: boolean, projectId: string, storyId: string | undefined) {
  const [threads, setThreads] = useState<ReadonlyMap<string, readonly TeamThread[]>>(new Map());
  const load = useCallback(async () => {
    if (storyId === undefined) return;
    const byLine = new Map<string, TeamThread[]>();
    let cursor: string | undefined;
    // Pages until the end: a story's threads, not the whole project's.
    for (let page = 0; page < 50; page += 1) {
      const answer = await connection
        .call<{ threads: TeamThread[]; cursor?: string }>("threads.list", {
          project: projectId,
          document: storyDocumentAnchor(storyId),
          limit: 200,
          ...(cursor === undefined ? {} : { before: cursor }),
        })
        .catch(() => undefined);
      if (answer === undefined) break;
      for (const thread of answer.threads) {
        const element = thread.anchor.element ?? "";
        byLine.set(element, [...(byLine.get(element) ?? []), thread]);
      }
      cursor = answer.cursor;
      if (cursor === undefined) break;
    }
    setThreads(byLine);
  }, [connection, projectId, storyId]);
  useEffect(() => {
    if (!open) return undefined;
    void load();
    return connection.subscribe(projectThreadsTopic(projectId), () => void load());
  }, [open, load, connection, projectId]);
  return threads;
}

function ThreadView({ connection, thread, canWrite }: { connection: TeamConnection; thread: TeamThread; canWrite: boolean }) {
  const [comments, setComments] = useState<readonly TeamComment[] | undefined>(undefined);
  const [body, setBody] = useState("");
  const load = useCallback(() => {
    connection
      .call<{ comments: TeamComment[] }>("threads.get", { thread: thread.id, limit: 200 })
      .then((answer) => setComments(answer.comments))
      .catch(() => setComments([]));
  }, [connection, thread.id]);
  useEffect(() => load(), [load, thread.updatedAt, thread.comments]);
  const reply = async (event: FormEvent) => {
    event.preventDefault();
    const text = body.trim();
    if (text === "") return;
    setBody("");
    await connection.call("threads.reply", { thread: thread.id, body: text, clientId: crypto.randomUUID() }).catch(() => undefined);
  };
  const resolved = thread.status === "resolved";
  return (
    <div className={resolved ? "thread resolved" : "thread"}>
      {(comments ?? []).map((comment) => (
        <div key={comment.id} className="comment">
          <div className="comment-head">
            <strong>{comment.author ?? "?"}</strong>
            <span className="muted small">{new Date(comment.createdAt).toLocaleString()}</span>
          </div>
          <div className={comment.deletedAt === undefined ? "comment-body" : "comment-body muted"}>
            {comment.deletedAt === undefined ? comment.body : "—"}
          </div>
        </div>
      ))}
      {canWrite ? (
        <div className="thread-actions">
          {!resolved ? (
            <form className="comment-form" onSubmit={(event) => void reply(event)}>
              <input value={body} placeholder={t("reply")} onChange={(event) => setBody(event.target.value)} maxLength={16000} />
            </form>
          ) : null}
          <button
            className="ghost small"
            onClick={() => void connection.call("threads.resolve", { thread: thread.id, resolved: !resolved }).catch(() => undefined)}
          >
            {resolved ? t("reopen") : t("resolve")}
          </button>
        </div>
      ) : resolved ? (
        <span className="muted small">{t("resolved")}</span>
      ) : null}
    </div>
  );
}

/** The side panel for one line: its threads, and a box to open another. */
export function LineComments(props: {
  connection: TeamConnection;
  projectId: string;
  storyId: string;
  sceneId: string;
  blockId: string;
  revision: string;
  excerpt: string;
  threads: readonly TeamThread[];
  canWrite: boolean;
  close: () => void;
}) {
  const { connection, projectId, storyId, sceneId, blockId, revision, excerpt, threads, canWrite, close } = props;
  const [body, setBody] = useState("");
  const [error, setError] = useState<string | undefined>(undefined);
  const open = async (event: FormEvent) => {
    event.preventDefault();
    const text = body.trim();
    if (text === "") return;
    setBody("");
    try {
      await connection.call("threads.create", {
        project: projectId,
        anchor: { document: storyDocumentAnchor(storyId), element: storyLineAnchor(sceneId, blockId), ...(revision === "" ? {} : { revision }) },
        body: text,
        clientId: crypto.randomUUID(),
      });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };
  return (
    <aside className="line-comments card">
      <div className="bell-head">
        <strong>{t("comments")}</strong>
        <button className="ghost small" onClick={close}>
          {t("close")}
        </button>
      </div>
      <blockquote className="excerpt muted">{excerpt}</blockquote>
      {threads.length === 0 ? <p className="muted small">{t("noComments")}</p> : null}
      {threads.map((thread) => (
        <ThreadView key={thread.id} connection={connection} thread={thread} canWrite={canWrite} />
      ))}
      {error !== undefined ? <p className="error">{error}</p> : null}
      {canWrite ? (
        <form className="comment-form" onSubmit={(event) => void open(event)}>
          <textarea value={body} placeholder={t("addComment")} rows={3} onChange={(event) => setBody(event.target.value)} maxLength={16000} />
          <button className="primary" type="submit">
            {t("send")}
          </button>
        </form>
      ) : null}
    </aside>
  );
}
