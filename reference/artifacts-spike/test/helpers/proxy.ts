/**
 * Small HTTP proxy for tests. It sits between the experiment code and the local git
 * server so a test can make the "server" behave in ways plain git does not:
 * answer some requests itself, or change a request body before git sees it.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface ProxiedRequest {
  method: string;
  /** Path and query, for example "/git/spike/repo.git/git-receive-pack". */
  path: string;
  headers: Record<string, string>;
  body: Buffer;
}

/**
 * Decide what happens to one request:
 *  - return { status, body } to answer it without contacting the git server
 *    (a Buffer body is sent byte for byte, for example a hand-built ref advertisement);
 *  - return { forwardBody } to forward it with a different body;
 *  - return undefined to forward it unchanged.
 */
export type ProxyHook = (req: ProxiedRequest) => { status: number; body: string | Buffer } | { forwardBody: Buffer } | undefined;

export interface Proxy {
  origin: string;
  /** Every request the proxy received, in order, with the status it answered. */
  seen: { method: string; path: string; status: number }[];
  close(): Promise<void>;
}

const HOP_BY_HOP = new Set(["host", "content-length", "connection", "transfer-encoding"]);

export async function startProxy(upstreamOrigin: () => string, hook: ProxyHook): Promise<Proxy> {
  const seen: Proxy["seen"] = [];
  const server: Server = createServer((req, res) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const headers: Record<string, string> = {};
      for (const [name, value] of Object.entries(req.headers)) if (typeof value === "string") headers[name] = value;
      const request: ProxiedRequest = { method: req.method ?? "GET", path: req.url ?? "/", headers, body: Buffer.concat(chunks) };
      const decision = hook(request);
      if (decision && "status" in decision) {
        seen.push({ method: request.method, path: request.path, status: decision.status });
        res.statusCode = decision.status;
        res.setHeader("content-type", "text/plain");
        res.end(decision.body);
        return;
      }
      const body = decision ? decision.forwardBody : request.body;
      const forwardHeaders: Record<string, string> = {};
      for (const [name, value] of Object.entries(headers)) if (!HOP_BY_HOP.has(name)) forwardHeaders[name] = value;
      const upstream = await fetch(`${upstreamOrigin()}${request.path}`, { method: request.method, headers: forwardHeaders, body: request.method === "POST" ? new Uint8Array(body) : undefined });
      seen.push({ method: request.method, path: request.path, status: upstream.status });
      res.statusCode = upstream.status;
      upstream.headers.forEach((value, name) => {
        if (!HOP_BY_HOP.has(name)) res.setHeader(name, value);
      });
      res.end(Buffer.from(await upstream.arrayBuffer()));
    })().catch((error: unknown) => {
      res.statusCode = 502;
      res.end(String(error));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    seen,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** The secret (token without "?expires=") carried by an Authorization header, or "" when there is none. */
export function secretFromAuthorization(header: string | undefined): string {
  if (!header) return "";
  if (header.startsWith("Bearer ")) return header.slice("Bearer ".length).split("?")[0]!;
  if (header.startsWith("Basic ")) {
    const decoded = Buffer.from(header.slice("Basic ".length), "base64").toString("utf8");
    return decoded.slice(decoded.indexOf(":") + 1);
  }
  return "";
}

export interface ParsedCommand {
  oldOid: string;
  newOid: string;
  ref: string;
  /** Capability list of the first command, "" on the others. */
  capabilities: string;
}

/** The ref commands of a receive-pack request body: the pkt-lines up to the first flush-pkt. */
export function parseCommands(body: Buffer): ParsedCommand[] {
  const commands: ParsedCommand[] = [];
  let pos = 0;
  for (;;) {
    const length = parseInt(body.subarray(pos, pos + 4).toString("latin1"), 16);
    if (!length) break;
    const [head, capabilities] = body.subarray(pos + 4, pos + length).toString("latin1").split("\0");
    commands.push({ oldOid: head!.slice(0, 40), newOid: head!.slice(41, 81), ref: head!.slice(82).trim(), capabilities: (capabilities ?? "").trim() });
    pos += length;
  }
  return commands;
}

/**
 * Rewrite the commands of a receive-pack request so that every claimed old id is replaced
 * by `currentValue(ref)`. A server behind this rewrite never sees a wrong old id, which
 * models a service that ignores the old id.
 */
export function overwriteOldIds(body: Buffer, currentValue: (ref: string) => string): Buffer {
  const out = Buffer.from(body);
  let pos = 0;
  for (;;) {
    const length = parseInt(out.subarray(pos, pos + 4).toString("latin1"), 16);
    if (!length) break; // flush-pkt: the commands end here, the pack follows
    const line = out.subarray(pos + 4, pos + length).toString("latin1");
    // "<old 40> <new 40> <ref>[\0 capabilities]"
    const ref = line.slice(82).split("\0")[0]!.trim();
    out.write(currentValue(ref), pos + 4, "latin1");
    pos += length;
  }
  return out;
}
