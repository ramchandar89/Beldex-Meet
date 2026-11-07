// HTTPS front door for using the dev servers from other machines on the LAN.
//
// Browsers only allow camera/microphone on https:// pages (or localhost), and an
// https page may only open secure (wss://) WebSockets. This proxy terminates TLS
// on one port and forwards plain HTTP/WebSocket traffic to the local servers:
//   /rtc…        -> LiveKit signaling (ws://localhost:7880)
//   everything   -> Next.js dev server (http://localhost:3003), incl. its HMR socket
// Serving both from one origin means the other machine accepts the self-signed
// certificate once. Media itself flows over WebRTC (UDP 7882), not this proxy.
//
// Usage: node scripts/lan-proxy.mjs   (see RUNNING.md, "Access from other machines")

import { readFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import os from "node:os";

const PORT = Number(process.env.LAN_PROXY_PORT ?? 3443);
const NEXT = { host: "127.0.0.1", port: Number(process.env.NEXT_PORT ?? 3003) };
const LIVEKIT = { host: "127.0.0.1", port: Number(process.env.LIVEKIT_PORT ?? 7880) };

const targetFor = (url = "") => (url === "/rtc" || url.startsWith("/rtc/") || url.startsWith("/rtc?") ? LIVEKIT : NEXT);

const tls = {
  key: readFileSync(new URL("../certs/lan-key.pem", import.meta.url)),
  cert: readFileSync(new URL("../certs/lan-cert.pem", import.meta.url)),
};

const server = https.createServer(tls, (req, res) => {
  const target = targetFor(req.url);
  const upstream = http.request(
    { ...target, method: req.method, path: req.url, headers: { ...req.headers, "x-forwarded-proto": "https" } },
    (up) => {
      res.writeHead(up.statusCode ?? 502, up.headers);
      up.pipe(res);
    },
  );
  upstream.on("error", (e) => {
    res.writeHead(502, { "content-type": "text/plain" });
    res.end(`Upstream ${target.port} unavailable: ${e.message}`);
  });
  req.pipe(upstream);
});

// WebSockets (LiveKit signaling, Next.js HMR): replay the upgrade request to the
// upstream and splice the raw sockets together.
server.on("upgrade", (req, socket, head) => {
  const target = targetFor(req.url);
  const upstream = net.connect(target.port, target.host, () => {
    const headers = Object.entries(req.headers)
      .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(", ") : v}`)
      .join("\r\n");
    upstream.write(`${req.method} ${req.url} HTTP/1.1\r\n${headers}\r\n\r\n`);
    if (head?.length) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  const close = () => {
    upstream.destroy();
    socket.destroy();
  };
  upstream.on("error", close);
  socket.on("error", close);
});

server.listen(PORT, "0.0.0.0", () => {
  const ips = Object.values(os.networkInterfaces())
    .flat()
    .filter((a) => a && a.family === "IPv4" && !a.internal)
    .map((a) => a.address);
  console.log(`LAN proxy listening on https://0.0.0.0:${PORT}`);
  for (const ip of ips) console.log(`  open https://${ip}:${PORT} on the other machine`);
});
