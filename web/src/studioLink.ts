/**
 * Links that open Studio (`narraleaf://team/...`, src/shared/utils/teamDeepLink.ts
 * in Studio). Studio only takes an https origin it already holds a sign-in for,
 * so the address is the server's auth URL from its discovery document rather
 * than whatever this page happens to be served from.
 */
let origin: Promise<string> | undefined;

function serverOrigin(): Promise<string> {
  origin ??= fetch("/.well-known/nlteam")
    .then((response) => response.json() as Promise<{ auth?: { url?: string } }>)
    .then((document) => new URL(document.auth?.url ?? window.location.origin).origin)
    .catch(() => window.location.origin);
  return origin;
}

/** Open a project in Studio, at a document where one is named (`story:<id>`, `ui:<id>`). */
export async function openInStudio(project: string, doc?: string): Promise<void> {
  const server = await serverOrigin();
  const query = new URLSearchParams({ server, project, ...(doc === undefined ? {} : { doc }) });
  window.location.href = `narraleaf://team/open?${query.toString()}`;
}

/**
 * The link that has Studio add this server: Add Server with the address filled in.
 * The address is the one a person would type there, `nlteam://host:port`, on the
 * listener the discovery document is served from.
 */
export async function studioConnectLink(): Promise<string> {
  const host = new URL(await serverOrigin()).host;
  return `narraleaf://team/connect?server=${encodeURIComponent(`nlteam://${host}`)}`;
}
