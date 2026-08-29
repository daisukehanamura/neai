// 第0段階の検証ページを HTTPS で配信する使い捨てサーバー。
// getUserMedia と Wake Lock は保護されたコンテキストでしか動かないため、
// 家庭内LANでも HTTPS が要る。自己署名証明書を初回に自動生成する。
import { createServer } from "node:https";
import { readFileSync, existsSync, writeFileSync, unlinkSync, statSync, createReadStream } from "node:fs";
import { execFileSync } from "node:child_process";
import { networkInterfaces, tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const PORT = 8443;

const lanIp = Object.values(networkInterfaces()).flat()
  .find((i) => i && i.family === "IPv4" && !i.internal)?.address ?? "127.0.0.1";

const keyPath = join(here, "dev-key.pem");
const certPath = join(here, "dev-cert.pem");

if (!existsSync(keyPath) || !existsSync(certPath)) {
  console.log(`自己署名証明書を生成します (IP: ${lanIp}) ...`);
  const confPath = join(tmpdir(), `neai-openssl-${process.pid}.cnf`);
  writeFileSync(confPath, [
    "[req]", "distinguished_name = dn", "x509_extensions = ext", "prompt = no",
    "[dn]", "CN = neai-spike",
    "[ext]", "subjectAltName = @san", "basicConstraints = CA:FALSE",
    "[san]", `IP.1 = ${lanIp}`, "DNS.1 = localhost", "IP.2 = 127.0.0.1",
  ].join("\n"));
  execFileSync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "365",
    "-keyout", keyPath, "-out", certPath, "-config", confPath,
  ], { stdio: "inherit" });
  unlinkSync(confPath);
  console.log("生成しました。\n");
}

createServer(
  { key: readFileSync(keyPath), cert: readFileSync(certPath) },
  (req, res) => {
    const url = new URL(req.url, "https://x");
    const name = url.pathname === "/" ? "/phase0.html" : url.pathname;
    const file = join(here, name.replace(/\.\./g, ""));
    if (!existsSync(file) || statSync(file).isDirectory()) {
      res.writeHead(404).end("not found");
      return;
    }

    const TYPES = {
      ".html": "text/html; charset=utf-8",
      ".js": "application/javascript; charset=utf-8",
      ".wasm": "application/wasm",
      ".gz": "application/gzip",
      ".json": "application/json",
      ".md": "text/plain; charset=utf-8",
    };
    const ext = name.slice(name.lastIndexOf("."));
    const size = statSync(file).size;

    res.writeHead(200, {
      "content-type": TYPES[ext] ?? "application/octet-stream",
      "content-length": size,
      // モデルは 47MB あるのでキャッシュさせる。HTML は常に最新を配る。
      "cache-control": ext === ".html" ? "no-store" : "public, max-age=86400",
    });
    // 大きいファイルをメモリに載せないよう流して返す。
    createReadStream(file).pipe(res);
    console.log(
      `  ${new Date().toTimeString().slice(0, 8)}  ${req.method} ${name}` +
        (size > 1e6 ? `  (${(size / 1e6).toFixed(1)}MB)` : ""),
    );
  }
).listen(PORT, "0.0.0.0", () => {
  console.log("─".repeat(52));
  console.log("  iPhone の Safari でこのURLを開いてください:");
  console.log(`\n    https://${lanIp}:${PORT}/\n`);
  console.log("  自己署名なので警告が出ます。以下の順にタップして進んでください:");
  console.log("    「詳細を表示」→「この Web サイトを閲覧」→「Web サイトを閲覧」");
  console.log("─".repeat(52));
});
