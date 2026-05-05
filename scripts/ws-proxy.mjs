import { createServer, request as httpRequest } from "http";

const PROXY_PORT = 4501;
const CODEX_HOST = "127.0.0.1";
const CODEX_PORT = 4500;

const server = createServer((req, res) => {
  if (req.url === "/healthz") { res.writeHead(200); res.end("ok"); return; }
  res.writeHead(404); res.end();
});

server.on("upgrade", (clientReq, clientSocket) => {
  const codexReq = httpRequest({
    host: CODEX_HOST,
    port: CODEX_PORT,
    path: "/",
    method: "GET",
    headers: {
      Connection: "Upgrade",
      Upgrade: "websocket",
      "Sec-WebSocket-Version": "13",
      "Sec-WebSocket-Key": clientReq.headers["sec-websocket-key"],
    },
  });

  codexReq.on("upgrade", (_res, codexSocket, codexHead) => {
    const accept = _res.headers["sec-websocket-accept"];
    clientSocket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${accept}\r\n` +
      "\r\n"
    );

    if (codexHead.length > 0) clientSocket.write(codexHead);

    codexSocket.pipe(clientSocket);
    clientSocket.pipe(codexSocket);

    codexSocket.on("error", () => clientSocket.destroy());
    clientSocket.on("error", () => codexSocket.destroy());
    codexSocket.on("close", () => clientSocket.destroy());
    clientSocket.on("close", () => codexSocket.destroy());
  });

  codexReq.on("response", (res) => {
    clientSocket.write(`HTTP/1.1 ${res.statusCode} ${res.statusMessage}\r\n\r\n`);
    res.pipe(clientSocket);
  });

  codexReq.on("error", (err) => {
    console.error("Codex error:", err.message);
    clientSocket.destroy();
  });

  codexReq.end();
});

server.listen(PROXY_PORT, "127.0.0.1", () => {
  console.log(`WS proxy: ws://127.0.0.1:${PROXY_PORT} -> ws://${CODEX_HOST}:${CODEX_PORT}`);
});
