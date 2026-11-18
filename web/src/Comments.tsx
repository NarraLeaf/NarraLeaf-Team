/**
 * Comments on story lines, in the same threads Studio writes.
 *
 * The anchor vocabulary is shared with Studio and never parsed by the server:
 * `document` is `story:<storyId>`, `element` is `<sceneId>/<blockId>`, and
 * `revision` is the revision the comment was written against. A thread written
 * here shows in Studio's scene editor on the same line, and the reverse.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ClipboardEvent, type FormEvent, type KeyboardEvent, type ReactNode } from "react";

import { projectThreadsTopic, type TeamComment, type TeamThread, type TeamThreadEvent } from "@narraleaf/team-protocol";

import { Face } from "./Collab";
import { Icon } from "./Icon";
import { MentionField, PersonHover, ReactionBar, useReactions } from "./Notify";
import { t } from "./i18n";
import { Blankslate, FormDialog, RelativeTime, toast, toastError } from "./ui";
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
    return connection.subscribe(projectThreadsTopic(projectId), (payload) => {
      // A reaction changes no thread; the reaction bars hear it themselves.
      if ((payload as TeamThreadEvent).kind !== "reaction") void load();
    });
  }, [open, load, connection, projectId]);
  return threads;
}

/** Whether a name is a guest's, who wrote through a share link. */
export function isGuest(author: string | undefined): boolean {
  return author?.startsWith("guest:") === true;
}

/** Who wrote something, as a reader sees it: a guest's own name with a mark saying they are one. */
export function authorName(author: string | undefined): string {
  if (author === undefined) return t("someoneGone");
  return isGuest(author) ? t("guestAuthor", { name: author.slice("guest:".length) }) : author;
}

const ATTACHMENT_TOKEN = /\[\[attachment:([0-9a-f-]{36})\]\]/g;

/** A comment's text, with the pictures put beside it shown where they were put. */
export function CommentBody({ projectId, body }: { projectId: string; body: string }) {
  const parts: ReactNode[] = [];
  let at = 0;
  for (const match of body.matchAll(ATTACHMENT_TOKEN)) {
    if (match.index > at) parts.push(body.slice(at, match.index));
    const url = `/api/team/v1/projects/${encodeURIComponent(projectId)}/attachments/${match[1]}`;
    parts.push(
      <a key={`${match.index}`} className="note-picture" href={url} target="_blank" rel="noreferrer">
        <img src={url} alt={t("attachmentAlt")} loading="lazy" />
      </a>,
    );
    at = match.index + match[0].length;
  }
  if (at < body.length) parts.push(body.slice(at));
  return <>{parts}</>;
}

/** Put a pasted or dropped picture beside a comment; answers the token to write into its text. */
export async function uploadAttachment(projectId: string, file: Blob): Promise<string> {
  const response = await fetch(`/api/team/v1/projects/${encodeURIComponent(projectId)}/attachments`, {
    method: "PUT",
    credentials: "same-origin",
    headers: { "content-type": file.type || "application/octet-stream" },
    body: file,
  });
  const answer = (await response.json().catch(() => ({}))) as { attachment?: { id: string }; error?: string };
  if (!response.ok || answer.attachment === undefined) throw new Error(answer.error ?? response.statusText);
  return `[[attachment:${answer.attachment.id}]]`;
}

/** A textarea's paste handler that sends any picture in the clipboard and writes its token in. */
export function pastePicture(projectId: string, setBody: (update: (body: string) => string) => void) {
  return (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const file = [...event.clipboardData.files].find((item) => item.type.startsWith("image/"));
    if (file === undefined) return;
    event.preventDefault();
    toast(t("attachmentUploading"));
    uploadAttachment(projectId, file)
      .then((token) => setBody((body) => `${body}${body === "" || body.endsWith("\n") ? "" : "\n"}${token}\n`))
      .catch(toastError);
  };
}

/** ⌘/Ctrl+Enter sends, the way GitHub's comment boxes do. */
function sendOnModEnter(event: KeyboardEvent<HTMLTextAreaElement>) {
  if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
    event.preventDefault();
    event.currentTarget.form?.requestSubmit();
  }
}

function ThreadView({ connection, thread, canWrite, me }: { connection: TeamConnection; thread: TeamThread; canWrite: boolean; me: string | undefined }) {
  const [comments, setComments] = useState<readonly TeamComment[] | undefined>(undefined);
  const [body, setBody] = useState("");
  const targets = useMemo(() => (comments ?? []).filter((comment) => comment.deletedAt === undefined).map((comment) => comment.id), [comments]);
  const reactions = useReactions(connection, thread.project, "comment", targets);
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
          <PersonHover connection={connection} username={isGuest(comment.author) ? undefined : comment.author}>
            <Face name={authorName(comment.author)} {...(isGuest(comment.author) ? {} : { user: comment.author })} size={24} />
          </PersonHover>
          <div className="note-main">
            <div className="note-head">
              <strong>{authorName(comment.author)}</strong>
              <RelativeTime at={comment.createdAt} />
            </div>
            <div className={comment.deletedAt === undefined ? "note-text" : "note-text muted"}>
              {comment.deletedAt === undefined ? <CommentBody projectId={thread.project} body={comment.body} /> : t("commentDeleted")}
            </div>
            {comment.deletedAt === undefined ? (
              <ReactionBar
                connection={connection}
                projectId={thread.project}
                kind="comment"
                target={comment.id}
                reactions={reactions.get(comment.id)}
                me={me}
                canReact={canWrite}
              />
            ) : null}
          </div>
        </article>
      ))}
      {canWrite && !resolved ? (
        <form className="note-reply" onSubmit={(event) => void reply(event)}>
          <MentionField
            connection={connection}
            value={body}
            placeholder={t("reply")}
            rows={body === "" ? 1 : 3}
            onValue={setBody}
            onKeyDown={sendOnModEnter}
            onPaste={pastePicture(thread.project, setBody)}
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
  me: string | undefined;
  close: () => void;
}) {
  const { connection, projectId, storyId, sceneId, blockId, revision, excerpt, threads, canWrite, me, close } = props;
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
          <ThreadView key={thread.id} connection={connection} thread={thread} canWrite={canWrite} me={me} />
        ))}
        {!canWrite && threads.length === 0 ? <p className="muted small">{t("noComments")}</p> : null}
        {canWrite && starting ? (
          <form className="note-reply note-new" onSubmit={(event) => void start(event)}>
            <MentionField
              connection={connection}
              autoFocus
              value={body}
              placeholder={t("addComment")}
              rows={3}
              onValue={setBody}
              onKeyDown={sendOnModEnter}
              onPaste={pastePicture(projectId, setBody)}
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

/**
 * The project's discussion: threads that hang on no line or page - a question for the whole
 * team, a decision to write down. Newest first, open ones before resolved ones.
 */
export function ProjectDiscussion({ connection, open, projectId, canWrite, me }: { connection: TeamConnection; open: boolean; projectId: string; canWrite: boolean; me: string | undefined }) {
  const [threads, setThreads] = useState<readonly TeamThread[] | undefined>(undefined);
  const [showResolved, setShowResolved] = useState(false);
  const [body, setBody] = useState("");
  const load = useCallback(() => {
    connection
      .call<{ threads: TeamThread[] }>("threads.list", { project: projectId, projectWide: true, limit: 200 })
      .then((answer) => setThreads(answer.threads))
      .catch((caught: unknown) => {
        setThreads([]);
        toastError(caught);
      });
  }, [connection, projectId]);
  useEffect(() => {
    if (!open) return undefined;
    load();
    return connection.subscribe(projectThreadsTopic(projectId), (payload) => {
      if ((payload as TeamThreadEvent).kind !== "reaction") load();
    });
  }, [open, load, connection, projectId]);
  const [starting, setStarting] = useState(false);
  const start = async () => {
    await connection.call("threads.create", { project: projectId, anchor: {}, body: body.trim(), clientId: crypto.randomUUID() });
    setBody("");
    toast(t("discussionStarted"));
  };
  const sorted = [...(threads ?? [])].sort((a, b) => b.updatedAt - a.updatedAt);
  const openThreads = sorted.filter((thread) => thread.status !== "resolved");
  const resolved = sorted.filter((thread) => thread.status === "resolved");
  return (
    <div className="discussion">
      <header className="discussion-head">
        <div>
          <h2>{t("discussion")}</h2>
          <p className="muted small">{t("discussionLead")}</p>
        </div>
        {canWrite ? (
          <button className="btn btn-primary btn-sm" onClick={() => setStarting(true)}>
            <Icon name="plus" size={14} /> {t("discussionNew")}
          </button>
        ) : null}
      </header>
      {canWrite && starting ? (
        <FormDialog title={t("discussionNew")} submitLabel={t("startThread")} width={600} ready={body.trim() !== ""} onSubmit={start} onClose={() => setStarting(false)}>
          <MentionField
            connection={connection}
            value={body}
            placeholder={t("discussionPlaceholder")}
            rows={6}
            onValue={setBody}
            onKeyDown={sendOnModEnter}
            onPaste={pastePicture(projectId, setBody)}
            maxLength={16000}
          />
          <p className="muted small">{t("sendHint")}</p>
        </FormDialog>
      ) : null}
      {threads === undefined ? <p className="muted small">{t("loading")}</p> : null}
      {threads !== undefined && openThreads.length === 0 ? (
        <Blankslate icon="chat" title={t("discussionEmpty")}>
          {canWrite ? t("discussionEmptyLead") : t("discussionReadOnly")}
        </Blankslate>
      ) : null}
      <div className="discussion-list">
        {openThreads.map((thread) => (
          <ThreadView key={thread.id} connection={connection} thread={thread} canWrite={canWrite} me={me} />
        ))}
      </div>
      {resolved.length > 0 ? (
        <>
          <button className="btn btn-invisible btn-sm" onClick={() => setShowResolved((value) => !value)}>
            {t(showResolved ? "discussionHideResolved" : "discussionShowResolved", { count: String(resolved.length) })}
          </button>
          {showResolved ? (
            <div className="discussion-list">
              {resolved.map((thread) => (
                <ThreadView key={thread.id} connection={connection} thread={thread} canWrite={canWrite} me={me} />
              ))}
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
