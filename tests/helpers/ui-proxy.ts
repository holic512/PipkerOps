import { createServer } from "node:https";
import { request } from "node:http";
import { connect, type Socket } from "node:net";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { configValues } from "../../src/lib/config";
import { initPki, pkiFiles } from "../../src/lib/pki";
import { availablePort } from "./agent-fixture";

/** Owned HTTPS proxy exercises same-origin RPC and real WSS in the browser fixture. */
export async function uiProxy(
  webPort: number,
  gatewayPort: number,
  directory: string,
) {
  configValues.DEV_PKI_DIR = join(directory, "ui-pki");
  initPki();
  const files = pkiFiles();
  const sockets = new Set<Socket>();
  const server = createServer(
    { key: readFileSync(files.key), cert: readFileSync(files.cert) },
    (incoming, outgoing) => {
      const upstream = request(
        {
          hostname: "127.0.0.1",
          port: webPort,
          path: incoming.url,
          method: incoming.method,
          headers: { ...incoming.headers, "x-forwarded-proto": "https" },
        },
        (response) => {
          outgoing.writeHead(response.statusCode ?? 502, response.headers);
          response.pipe(outgoing);
        },
      );
      upstream.on("error", () => {
        if (!outgoing.headersSent) outgoing.writeHead(502);
        outgoing.end();
      });
      incoming.pipe(upstream);
    },
  );
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  server.on("upgrade", (incoming, socket, head) => {
    const upstream = connect(gatewayPort, "127.0.0.1", () => {
      const headers = { ...incoming.headers, "x-forwarded-proto": "https" };
      upstream.write(
        `${incoming.method} ${incoming.url} HTTP/${incoming.httpVersion}\r\n${Object.entries(
          headers,
        )
          .map(
            ([key, value]) =>
              `${key}: ${Array.isArray(value) ? value.join(", ") : value}`,
          )
          .join("\r\n")}\r\n\r\n`,
      );
      if (head.length) upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
    socket.on("error", () => upstream.destroy());
    socket.on("close", () => upstream.destroy());
    upstream.on("error", () => socket.destroy());
    upstream.on("close", () => socket.destroy());
  });
  const port = await availablePort();
  await new Promise<void>((done, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", done);
  });
  return {
    port,
    origin: `https://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((done) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => done());
      }),
  };
}
