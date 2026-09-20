import http from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, WebSocket } from "ws";
import { Store } from "./store.js";
import { ConfigRevisionConflictError, OfficeEngine } from "./engine.js";
import { diagnoseConfig } from "./diagnostics.js";
const appRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
export async function startServer(
  options: { root?: string; port?: number; production?: boolean } = {},
) {
  const root = options.root || process.env.AGENT_OFFICE_ROOT || process.cwd();
  const port = options.port ?? Number(process.env.PORT || 4310);
  const production =
    options.production ?? process.env.NODE_ENV === "production";
  const engine = await OfficeEngine.create(new Store(root));
  const vite = production
    ? null
    : await (
        await import("vite")
      ).createServer({
        root: appRoot,
        server: { middlewareMode: true, host: "127.0.0.1", hmr: { host: "127.0.0.1" } },
        appType: "spa",
      });
  let mutationQueue: Promise<unknown> = Promise.resolve();
  const json = (res: http.ServerResponse, status: number, value: unknown) => {
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    res.end(JSON.stringify(value));
  };
  const localHost = (req: http.IncomingMessage) => {
    const address = server.address();
    const boundPort =
      typeof address === "object" && address ? address.port : port;
    return (
      req.headers.host === `127.0.0.1:${boundPort}` ||
      req.headers.host === `localhost:${boundPort}`
    );
  };
  const sameOrigin = (req: http.IncomingMessage) =>
    !req.headers.origin || req.headers.origin === `http://${req.headers.host}`;
  async function body(req: http.IncomingMessage) {
    if (!req.headers["content-type"]?.startsWith("application/json"))
      throw new Error("Use Content-Type application/json.");
    let size = 0;
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 1024 * 1024) throw new Error("Requisição excede 1 MB.");
      chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString() || "{}");
  }
  const server = http.createServer(async (req, res) => {
    if (!localHost(req) || !sameOrigin(req)) {
      json(res, 403, {
        error: "Acesso permitido apenas pela aplicação local.",
      });
      return;
    }
    const url = new URL(req.url || "/", "http://localhost");
    if (url.pathname.startsWith("/api/")) {
      try {
        if (req.method === "GET" && url.pathname === "/api/state") {
          json(res, 200, engine.snapshot());
          return;
        }
        if (req.method === "GET" && url.pathname === "/api/diagnostics") {
          const projectId = url.searchParams.get("projectId") || undefined;
          const workflowId = url.searchParams.get("workflowId") || undefined;
          json(res, 200, await diagnoseConfig(engine.snapshot().config, projectId, workflowId));
          return;
        }
        if (!["POST", "PUT"].includes(req.method || "")) {
          json(res, 404, { error: "Rota não encontrada." });
          return;
        }
        const input = await body(req);
        const operation = async () => {
          if (req.method === "PUT" && url.pathname === "/api/config") {
            if (
              !input ||
              typeof input !== "object" ||
              Array.isArray(input) ||
              !("config" in input) ||
              typeof (input as { expectedRevision?: unknown }).expectedRevision !== "string"
            )
              throw new Error("PUT /api/config exige {config, expectedRevision}.");
            return engine.updateConfig(
              (input as { config: Parameters<OfficeEngine["updateConfig"]>[0] }).config,
              (input as { expectedRevision: string }).expectedRevision,
            );
          }
          if (req.method === "POST" && url.pathname === "/api/diagnostics") {
            if (!input || typeof input !== "object" || Array.isArray(input))
              throw new Error("POST /api/diagnostics exige um objeto JSON.");
            if (input.projectId !== undefined && typeof input.projectId !== "string")
              throw new Error("projectId precisa ser texto.");
            if (input.workflowId !== undefined && typeof input.workflowId !== "string")
              throw new Error("workflowId precisa ser texto.");
            return diagnoseConfig(
              engine.snapshot().config,
              input.projectId,
              input.workflowId,
            );
          }
          if (req.method === "POST" && url.pathname === "/api/config/reload") {
            // Reload is an explicit local-file operation. It remains
            // backward-compatible with the old empty body, while callers may
            // provide a revision when they want stale reloads rejected.
            if (!input || typeof input !== "object" || Array.isArray(input))
              throw new Error("POST /api/config/reload exige um objeto JSON.");
            if (input.expectedRevision !== undefined && typeof input.expectedRevision !== "string")
              throw new Error("expectedRevision precisa ser texto.");
            return engine.updateConfig(
              await new Store(root).load(),
              input.expectedRevision ?? engine.snapshot().configRevision,
            );
          }
          if (req.method === "POST" && url.pathname === "/api/run")
            return engine.runTask(
              input.projectId,
              input.workflowId,
              input.task,
            );
          if (req.method === "POST" && url.pathname === "/api/run/stop")
            return engine.stopRun();
          if (req.method === "POST" && url.pathname === "/api/run/restart")
            return engine.restartRun();
          const match = url.pathname.match(
            /^\/api\/agents\/([\w-]+)\/(send|stop|restart)$/,
          );
          if (req.method === "POST" && match) {
            if (match[2] === "send")
              return engine.send(match[1], input.message);
            if (match[2] === "stop") return engine.stopAgent(match[1]);
            return engine.restartAgent(match[1]);
          }
          throw new Error("Rota não encontrada.");
        };
        const result = mutationQueue.then(operation);
        mutationQueue = result.catch(() => {});
        json(res, 200, await result);
      } catch (e) {
        if (e instanceof ConfigRevisionConflictError) {
          json(res, 409, {
            error: e.message,
            expectedRevision: e.expectedRevision,
            currentRevision: e.currentRevision,
          });
        } else {
          json(res, 400, { error: e instanceof Error ? e.message : String(e) });
        }
      }
      return;
    }
    if (vite) {
      vite.middlewares(req, res);
      return;
    }
    try {
      const relative = decodeURIComponent(url.pathname);
      const file = path.resolve(appRoot, "dist", "." + relative);
      const dist = path.join(appRoot, "dist");
      if (!file.startsWith(dist + path.sep) && file !== dist) {
        res.writeHead(403);
        res.end();
        return;
      }
      const exists = await stat(file).catch(() => null);
      const target = exists?.isFile() ? file : path.join(dist, "index.html");
      const ext = path.extname(target);
      const mime: Record<string, string> = {
        ".html": "text/html; charset=utf-8",
        ".js": "text/javascript",
        ".css": "text/css",
        ".svg": "image/svg+xml",
        ".png": "image/png",
        ".woff2": "font/woff2",
        ".ico": "image/x-icon",
      };
      res.writeHead(200, {
        "Content-Type": mime[ext] || "application/octet-stream",
        "X-Content-Type-Options": "nosniff",
      });
      res.end(await readFile(target));
    } catch {
      res.writeHead(404);
      res.end("Execute npm run build antes de iniciar em produção.");
    }
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 });
  server.on("upgrade", (req, socket, head) => {
    if (req.url !== "/ws") {
      if (!vite) socket.destroy();
      return;
    } // Vite owns its HMR socket.
    if (!localHost(req) || !sameOrigin(req)) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) =>
      wss.emit("connection", ws, req),
    );
  });
  wss.on("connection", (ws) =>
    ws.send(JSON.stringify({ type: "snapshot", data: engine.snapshot() })),
  );
  let broadcastTimer: ReturnType<typeof setTimeout> | undefined;
  engine.on("change", () => {
    if (broadcastTimer) return;
    broadcastTimer = setTimeout(() => {
      broadcastTimer = undefined;
      const message = JSON.stringify({
        type: "snapshot",
        data: engine.snapshot(),
      });
      for (const client of wss.clients)
        if (client.readyState === WebSocket.OPEN) {
          if (client.bufferedAmount > 2 * 1024 * 1024) client.terminate();
          else client.send(message);
        }
    }, 40);
  });
  engine.on("persistenceError", (error) => {
    for (const client of wss.clients)
      if (client.readyState === WebSocket.OPEN)
        client.send(JSON.stringify({ type: "error", error }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  const address = server.address();
  const actualPort =
    typeof address === "object" && address ? address.port : port;
  let closed = false;
  return {
    server,
    engine,
    port: actualPort,
    async close() {
      if (closed) return;
      closed = true;
      await mutationQueue;
      await engine.dispose();
      clearTimeout(broadcastTimer);
      for (const client of wss.clients) client.terminate();
      wss.close();
      await vite?.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const app = await startServer();
  console.log(`Agent Office: http://127.0.0.1:${app.port}`);
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.once(signal, () => {
      app
        .close()
        .then(() => process.exit(0))
        .catch((e) => {
          console.error(e);
          process.exit(1);
        });
    });
}
