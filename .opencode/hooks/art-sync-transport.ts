import type { CloudFile, SyncTransport } from "./art-sync";

/** MCP control-plane requests; file bytes go directly to GCS signed URLs. */
export function createSyncTransport(
  url: string, key: string, email: string, slug: string, fetcher: typeof fetch = fetch
): SyncTransport {
  const call = async (name: string, args: Record<string, unknown>): Promise<any> => {
    const requestId = crypto.randomUUID();
    const response = await fetcher(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${key}`,
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
      },
      body: JSON.stringify({jsonrpc: "2.0", id: requestId, method: "tools/call", params: {name, arguments: {user_email: email, project_slug: slug, ...args}}}),
    });
    if (!response.ok) throw new Error(`ART MCP request failed (${response.status})`);
    const raw = await response.text();
    const outer = response.headers.get("content-type")?.includes("text/event-stream")
      ? (() => {
          const messages = raw.split(/\r?\n\r?\n/).map(block => block.split(/\r?\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5).trim()).join("\n")).filter(Boolean);
          const matching = messages.map(message => JSON.parse(message)).find(message => message.id === requestId);
          if (!matching) throw new Error("ART MCP event stream contained no matching response");
          return matching;
        })()
      : JSON.parse(raw);
    if (outer.error || outer.result?.isError) throw new Error("ART MCP sync operation failed");
    const structured = outer.result?.structuredContent;
    if (structured) return structured.result ?? structured;
    const text = outer.result?.content?.find((c: any) => c.type === "text")?.text;
    if (!text) throw new Error("ART MCP returned no sync result");
    const parsed = JSON.parse(text);
    return parsed.result ?? parsed;
  };
  const authorize = (file: string, method: string, generation: string) =>
    call("sync_project_transfer", {path: file, method, generation});
  return {
    async inventory() {
      const files: CloudFile[] = [];
      let page_token: string | null = null;
      do {
        const page = await call("sync_project_inventory", {page_size: 200, page_token});
        files.push(...page.files);
        page_token = page.next_page_token;
      } while (page_token);
      return files;
    },
    async download(file: CloudFile) {
      const transfer = await authorize(file.path, "GET", file.generation);
      const response = await fetcher(transfer.url, {method: "GET", headers: transfer.headers});
      if (!response.ok) throw new Error(`Cloud download failed (${response.status})`);
      return Buffer.from(await response.arrayBuffer());
    },
    async upload(name: string, bytes: Buffer, generation: string) {
      const transfer = await authorize(name, "PUT", generation);
      const response = await fetcher(transfer.url, {method: "PUT", headers: transfer.headers, body: bytes});
      if (!response.ok) throw new Error(`Cloud upload failed (${response.status})`);
      const next = response.headers.get("x-goog-generation");
      if (!next) throw new Error("Cloud upload did not return a generation");
      return next;
    },
  };
}
