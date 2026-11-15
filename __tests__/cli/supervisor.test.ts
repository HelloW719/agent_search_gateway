import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runSupervisor } from "../../src/cli/runtime/supervisor.js";

const tempDirs: string[] = [];

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "asg-supervisor-"));
  tempDirs.push(root);
  return root;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

async function waitForText(file: string, text: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(file) && fs.readFileSync(file, "utf8").includes(text)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`等待日志超时：${text}`);
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("supervisor 可选服务", () => {
  it("可选服务退出后继续启动并监督必需服务", async () => {
    const root = tempRoot();
    const port = await freePort();
    const server = path.join(root, "server.mjs");
    fs.writeFileSync(
      server,
      `import http from "node:http";
const port = Number(process.argv[2]);
http.createServer((_req, res) => {
  res.writeHead(200);
  res.end("ok");
}).listen(port, "127.0.0.1");
setInterval(() => {}, 1000);
`,
      "utf8",
    );

    const runtime = path.join(root, "data", "runtime");
    fs.mkdirSync(runtime, { recursive: true });
    fs.writeFileSync(
      path.join(runtime, "launch.json"),
      JSON.stringify({
        services: [
          {
            name: "flaresolverr",
            command: [process.execPath, "-e", "process.exit(1)"],
            cwd: root,
            health: `http://127.0.0.1:${port}/`,
            required: false,
          },
          {
            name: "gateway",
            command: [process.execPath, server, String(port)],
            cwd: root,
            health: `http://127.0.0.1:${port}/health`,
          },
        ],
      }),
      "utf8",
    );

    const supervisor = runSupervisor(root, {
      healthTimeoutMs: 3_000,
      healthIntervalMs: 25,
      stopGraceMs: 500,
      monitorIntervalMs: 50,
    });
    const logFile = path.join(root, "data", "logs", "supervisor.log");

    await waitForText(logFile, "1/2 个服务健康，进入监督模式");
    process.emit("SIGTERM");

    await expect(supervisor).resolves.toBe(0);
    const log = fs.readFileSync(logFile, "utf8");
    expect(log).toContain("可选服务意外退出");
    expect(log).toContain("[gateway] 健康检查通过");
  });
});
