/**
 * Comments on story lines, in the same threads Studio writes.
 *
 * The anchor vocabulary is shared with Studio and never parsed by the server:
 * `document` is `story:<storyId>`, `element` is `<sceneId>/<blockId>`, and
 * `revision` is the revision the comment was written against. A thread written
 * here shows in Studio's scene editor on the same line, and the reverse.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";

import { projectThreadsTopic, type TeamComment, type TeamThread } from "@narraleaf/team-protocol";

import { Face } from "./Collab";
import { Icon } from "./Icon";
import { t } from "./i18n";
import { RelativeTime, toastError } from "./ui";
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

/** ⌘/Ctrl+Enter sends, the way GitHub's comment boxes do. */
function sendOnModEnter(event: KeyboardEvent<HTMLTextAreaElement>) {
  if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
    event.preventDefault();
    event.currentTarget.form?.requestSubmit();
  }
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
    await connection
      .call("threads.reply", {
        thread: thread.id,
        body: text,
        clientId: crypto.randomUUID(),
      })
      .catch((caught: unknown) => {
        setBody(text);
        toastError(caught);
      });
  };
  const resolved = thread.status === "resolved";
  const count = comments?.length ?? thread.comments;
  return (
    <section className={resolved ? "note-thread is-resolved" : "note-thread"}>
      <header className="note-thread-head">
        <span className="note-count">{resolved ? t("threadResolvedBy", { name: thread.resolvedBy ?? "?" }) : t("commentCount", { count: String(count) })}</span>
        {canWrite ? (
          <button
            className="btn btn-invisible btn-icon btn-sm"
            title={resolved ? t("reopen") : t("resolve")}
            aria-label={resolved ? t("reopen") : t("resolve")}
            onClick={() =>
              void connection
                .call("threads.resolve", {
                  thread: thread.id,
                  resolved: !resolved,
                })
                .catch(toastError)
            }
          >
            <Icon name={resolved ? "history" : "tick"} size={15} />
          </button>
        ) : null}
      </header>
      {comments === undefined ? <p className="muted small">{t("loading")}</p> : null}
      {(comments ?? []).map((comment) => (
        <article key={comment.id} className="note">
          <Face name={comment.author ?? "?"} user={comment.author} size={24} />
          <div className="note-main">
            <div className="note-head">
              <strong>{comment.author ?? t("someoneGone")}</strong>
              <RelativeTime at={comment.createdAt} />
            </div>
            <div className={comment.deletedAt === undefined ? "note-text" : "note-text muted"}>
              {comment.deletedAt === undefined ? comment.body : t("commentDeleted")}
            </div>
          </div>
        </article>
      ))}
      {canWrite && !resolved ? (
        <form className="note-reply" onSubmit={(event) => void reply(event)}>
          <textarea
            value={body}
            placeholder={t("reply")}
            rows={body === "" ? 1 : 3}
            onChange={(event) => setBody(event.target.value)}
            onKeyDown={sendOnModEnter}
            maxLength={16000}
          />
          {body.trim() === "" ? null : (
            <div className="note-reply-actions">
              <button type="button" className="btn btn-sm" onClick={() => setBody("")}>
                {t("cancel")}
              </button>
              <button type="submit" className="btn btn-primary btn-sm">
                {t("sendReply")}
              </button>
            </div>
          )}
        </form>
      ) : null}
    </section>
  );
}

/**
 * The comments on one line, in a card beside that line, the way a pull request's
 * review comments sit beside the code: each thread with its own reply box, and
 * starting a new thread a separate, named step.
 */
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
  const [writing, setWriting] = useState(false);
  const [top, setTop] = useState<number | undefined>(undefined);
  const card = useRef<HTMLElement>(null);
  const starting = writing || threads.length === 0;

  // Sit level with the line, inside the scrolling script so it moves with it.
  useLayoutEffect(() => {
    const row = document.getElementById(`row-${blockId}`);
    setTop(row === null ? undefined : row.offsetTop);
  }, [blockId, threads.length]);
  useEffect(() => {
    setWriting(false);
    setBody("");
  }, [blockId]);
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close]);

  const start = async (event: FormEvent) => {
    event.preventDefault();
    const text = body.trim();
    if (text === "") return;
    setBody("");
    setWriting(false);
    try {
      await connection.call("threads.create", {
        project: projectId,
        anchor: { document: storyDocumentAnchor(storyId), element: storyLineAnchor(sceneId, blockId), ...(revision === "" ? {} : { revision }) },
        body: text,
        clientId: crypto.randomUUID(),
      });
    } catch (caught) {
      setBody(text);
      setWriting(true);
      toastError(caught);
    }
  };
  return (
    <aside ref={card} className="note-pop" style={top === undefined ? undefined : { top }} role="dialog" aria-label={t("comments")}>
      <header className="note-pop-head">
        <span className="note-excerpt" title={excerpt}>
          {excerpt || t("comments")}
        </span>
        <button className="btn btn-invisible btn-icon btn-sm" onClick={close} aria-label={t("close")} title={t("close")}>
          <Icon name="close" size={15} />
        </button>
      </header>
      <div className="note-pop-body">
        {threads.map((thread) => (
          <ThreadView key={thread.id} connection={connection} thread={thread} canWrite={canWrite} />
        ))}
        {!canWrite && threads.length === 0 ? <p className="muted small">{t("noComments")}</p> : null}
        {canWrite && starting ? (
          <form className="note-reply note-new" onSubmit={(event) => void start(event)}>
            <textarea
              autoFocus
              value={body}
              placeholder={t("addComment")}
              rows={3}
              onChange={(event) => setBody(event.target.value)}
              onKeyDown={sendOnModEnter}
              maxLength={16000}
            />
            <div className="note-reply-actions">
              <span className="muted small">{t("sendHint")}</span>
              {threads.length > 0 ? (
                <button type="button" className="btn btn-sm" onClick={() => setWriting(false)}>
                  {t("cancel")}
                </button>
              ) : null}
              <button type="submit" className="btn btn-primary btn-sm" disabled={body.trim() === ""}>
                {t("startThread")}
              </button>
            </div>
          </form>
        ) : null}
        {canWrite && !starting ? (
          <button className="btn btn-sm note-new-button" onClick={() => setWriting(true)}>
            <Icon name="plus" size={14} /> {t("newThread")}
          </button>
        ) : null}
      </div>
    </aside>
  );
}
