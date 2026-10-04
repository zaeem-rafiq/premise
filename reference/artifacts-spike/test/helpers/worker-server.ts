/**
 * The Worker's real request handler behind a local HTTP server, for tests that drive the
 * harness the way an operator does (curl, run-spikes.sh, outside-probe.mjs).
 * The experiments run in this process against the given deps (fake binding, real git).
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { EXPERIMENT_IDS, ExperimentRunner, type Deps } from "../../src/experiments";
import { handleRequest } from "../../src/router";

export interface WorkerServer {
  origin: string;
  /** Path of every request received, in order. */
  paths: string[];
  close(): Promise<void>;
}

export async function startWorkerServer(deps: Deps, key: string): Promise<WorkerServer> {
  const paths: string[] = [];
  // One experiment at a time, as in the Durable Object.
  const runner = new ExperimentRunner();
  const server: Server = createServer((req, res) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const headers = new Headers();
      for (const [name, value] of Object.entries(req.headers)) if (typeof value === "string") headers.set(name, value);
      paths.push(req.url ?? "");
      const method = req.method ?? "GET";
      const body = method === "GET" || method === "HEAD" ? undefined : Buffer.concat(chunks);
      const response = await handleRequest(new Request(`http://localhost${req.url}`, { method, headers, body }), {
        spikeKey: key,
        experimentIds: EXPERIMENT_IDS,
        meta: { worker_colo: "TEST" },
        run: (id, experimentBody, meta) => runner.run(id, { ...deps, meta }, experimentBody),
      });
      res.statusCode = response.status;
      response.headers.forEach((value, name) => res.setHeader(name, value));
      res.end(Buffer.from(await response.arrayBuffer()));
    })().catch((error: unknown) => {
      res.statusCode = 500;
      res.end(String(error));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    paths,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
