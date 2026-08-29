// 開発中の HTTPS 終端。iPhone の Safari は getUserMedia と Wake Lock を
// 保護されたコンテキストでしか許可しないため、LAN 経由でも HTTPS が要る。
// `vite dev`（Cloudflare プラグインが Worker ごと動かす）へ中継する。
import { createServer } from "node:https";
import { request as httpRequest } from "node:http";
import { connect } from "node:net";
import { readFileSync, existsSync, writeFileSync, unlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { networkInterfaces, tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const HTTPS_PORT = 8444;  // 8443 は spike の検証ページが使っている
const TARGET = { host: "127.0.0.1", port: 5173 };

const lanIp =
  Object.values(networkInterfaces()).flat()
    .find((i) => i && i.family === "IPv4" && !i.internal)?.address ?? "127.0.0.1";

const keyPath = join(here, "dev-key.pem");
const certPath = join(here, "dev-cert.pem");

if (!existsSync(keyPath) || !existsSync(certPath)) {
  console.log(`自己署名証明書を生成します (IP: ${lanIp}) ...`);
  const conf = join(tmpdir(), `neai-openssl-${process.pid}.cnf`);
  writeFileSync(conf, [
    "[req]", "distinguished_name = dn", "x509_extensions = ext", "prompt = no",
    "[dn]", "CN = neai-dev",
    "[ext]", "subjectAltName = @san", "basicConstraints = CA:FALSE",
    "[san]", `IP.1 = ${lanIp}`, "DNS.1 = localhost", "IP.2 = 127.0.0.1",
  ].join("\n"));
  execFileSync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "365",
    "-keyout", keyPath, "-out", certPath, "-config", conf,
  ], { stdio: ["ignore", "ignore", "inherit"] });
  unlinkSync(conf);
  console.log("生成しました。\n");
}

const server = createServer(
  { key: readFileSync(keyPath), cert: readFileSync(certPath) },
  (req, res) => {
    const upstream = httpRequest(
      { ...TARGET, path: req.url, method: req.method, headers: req.headers },
      (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers);
        up.pipe(res);
      },
    );
    upstream.on("error", (err) => {
      res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
      res.end(`vite dev へ繋がりません (${err.message})\n別のターミナルで npm run dev を起動してください。`);
    });
    req.pipe(upstream);
  },
);

// Vite の HMR は WebSocket を使うため、Upgrade も中継する。
server.on("upgrade", (req, socket, head) => {
  const up = connect(TARGET.port, TARGET.host, () => {
    up.write(
      `${req.method} ${req.url} HTTP/1.1\r\n` +
        Object.entries(req.headers).map(([k, v]) => `${k}: ${v}\r\n`).join("") +
        "\r\n",
    );
    up.write(head);
    up.pipe(socket);
    socket.pipe(up);
  });
  up.on("error", () => socket.destroy());
  socket.on("error", () => up.destroy());
});

server.listen(HTTPS_PORT, "0.0.0.0", () => {
  console.log("─".repeat(52));
  console.log("  iPhone の Safari で開いてください:\n");
  console.log(`    https://${lanIp}:${HTTPS_PORT}/\n`);
  console.log("  自己署名なので警告が出ます:");
  console.log("    「詳細を表示」→「この Web サイトを閲覧」");
  console.log(`\n  中継先: http://${TARGET.host}:${TARGET.port}  (npm run dev)`);
  console.log("─".repeat(52));
});
