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

function writeServer(root: string): string {
  const file = path.join(root, "server.mjs");
  fs.writeFileSync(
    file,
    `import http from "node:http";
const port = Number(process.argv[2]);
const lifetimeMs = Number(process.argv[3] || 0);
http.createServer((_req, res) => {
  res.writeHead(200);
  res.end("ok");
}).listen(port, "127.0.0.1");
if (lifetimeMs > 0) setTimeout(() => process.exit(0), lifetimeMs);
else setInterval(() => {}, 1000);
`,
    "utf8",
  );
  return file;
}

function writeLaunch(root: string, services: unknown[]): void {
  const runtime = path.join(root, "data", "runtime");
  fs.mkdirSync(runtime, { recursive: true });
  fs.writeFileSync(path.join(runtime, "launch.json"), JSON.stringify({ services }), "utf8");
}

async function runHarness(
  root: string,
  assertion: (
    done: Promise<number>,
    logFile: string,
    settled: () => boolean,
  ) => Promise<void>,
): Promise<number> {
  const controller = new AbortController();
  let finished = false;
  const done = runSupervisor(root, {
    healthTimeoutMs: 1_500,
    healthIntervalMs: 25,
    stopGraceMs: 250,
    monitorIntervalMs: 25,
    shutdownSignal: controller.signal,
  }).finally(() => {
    finished = true;
  });
  const logFile = path.join(root, "data", "logs", "supervisor.log");
  let assertionError: unknown;
  try {
    await assertion(done, logFile, () => finished);
  } catch (error) {
    assertionError = error;
  }
  controller.abort();
  const code = await done;
  if (assertionError) throw assertionError;
  return code;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("supervisor 可选服务", () => {
  it("可选服务无法 spawn 时继续启动必需服务", async () => {
    const root = tempRoot();
    const port = await freePort();
    const server = writeServer(root);
    writeLaunch(root, [
      {
        name: "flaresolverr",
        command: [path.join(root, "missing-binary")],
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
    ]);

    const code = await runHarness(root, async (_done, logFile, settled) => {
      await waitForText(logFile, "1/2 个服务健康，进入监督模式");
      expect(settled()).toBe(false);
      const log = fs.readFileSync(logFile, "utf8");
      expect(log).toContain("可选服务已降级");
      expect(log).toContain("[gateway] 健康检查通过");
    });
    expect(code).toBe(0);
  });

  it("可选服务启动后立即退出时继续启动必需服务", async () => {
    const root = tempRoot();
    const port = await freePort();
    const server = writeServer(root);
    writeLaunch(root, [
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
    ]);

    const code = await runHarness(root, async (_done, logFile) => {
      await waitForText(logFile, "1/2 个服务健康，进入监督模式");
      const log = fs.readFileSync(logFile, "utf8");
      expect(log).toContain("意外退出");
      expect(log).toContain("可选服务已降级");
    });
    expect(code).toBe(0);
  });

  it("可选服务健康超时后停止该服务并继续启动必需服务", async () => {
    const root = tempRoot();
    const requiredPort = await freePort();
    const optionalPort = await freePort();
    const server = writeServer(root);
    writeLaunch(root, [
      {
        name: "flaresolverr",
        command: [process.execPath, "-e", "setInterval(() => {}, 1000)"],
        cwd: root,
        health: `http://127.0.0.1:${optionalPort}/`,
        required: false,
      },
      {
        name: "gateway",
        command: [process.execPath, server, String(requiredPort)],
        cwd: root,
        health: `http://127.0.0.1:${requiredPort}/health`,
      },
    ]);

    const code = await runHarness(root, async (_done, logFile) => {
      await waitForText(logFile, "1/2 个服务健康，进入监督模式", 8_000);
      const log = fs.readFileSync(logFile, "utf8");
      expect(log).toContain("健康检查超时");
      expect(log).toContain("可选服务已降级");
    });
    expect(code).toBe(0);
  });

  it("可选服务健康后崩溃时不停止整栈", async () => {
    const root = tempRoot();
    const requiredPort = await freePort();
    const optionalPort = await freePort();
    const server = writeServer(root);
    writeLaunch(root, [
      {
        name: "flaresolverr",
        command: [process.execPath, server, String(optionalPort), "1000"],
        cwd: root,
        health: `http://127.0.0.1:${optionalPort}/`,
        required: false,
      },
      {
        name: "gateway",
        command: [process.execPath, server, String(requiredPort)],
        cwd: root,
        health: `http://127.0.0.1:${requiredPort}/health`,
      },
    ]);

    const code = await runHarness(root, async (_done, logFile, settled) => {
      await waitForText(logFile, "2/2 个服务健康，进入监督模式");
      await waitForText(logFile, "[flaresolverr] 意外退出");
      expect(settled()).toBe(false);
      const log = fs.readFileSync(logFile, "utf8");
      expect(log).toContain("可选服务已降级");
    });
    expect(code).toBe(0);
  });
});
