import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Reporter } from "../../src/cli/output.js";

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  probeGateway: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  spawn: mocks.spawn,
  spawnSync: vi.fn(),
}));

vi.mock("../../src/cli/runtime/health.js", () => ({
  DEFAULT_PROBE_TIMEOUT_MS: 1_000,
  probeGateway: mocks.probeGateway,
  probeFromHealth: vi.fn(),
  probeUrl: vi.fn(),
}));

vi.mock("../../src/cli/platform/index.js", () => ({
  createPlatformEnv: () => ({
    runner: () => ({ ok: true, status: 0, stdout: "", stderr: "" }),
    platform: "win32",
    home: "C:\\",
    uid: "1000",
  }),
  detectManager: () => ({
    mode: "pid",
    registered: false,
    active: false,
  }),
  startService: vi.fn(),
  stopService: vi.fn(),
  restartService: vi.fn(),
}));

import { startStack } from "../../src/cli/runtime/stack.js";

const tempDirs: string[] = [];
const windowsIt = process.platform === "win32" ? it : it.skip;

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "asg-stack-detached-"));
  tempDirs.push(root);
  fs.mkdirSync(path.join(root, "bin"), { recursive: true });
  fs.writeFileSync(path.join(root, "gateway.yaml"), "gateway:\n  port: 3000\n", "utf8");
  fs.writeFileSync(path.join(root, "bin", "asg.mjs"), "// fixture\n", "utf8");
  return root;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.probeGateway.mockResolvedValue({ probe: { up: false } });
  mocks.spawn.mockReturnValue({
    exitCode: 1,
    signalCode: null,
    on: vi.fn(),
    unref: vi.fn(),
  });
});

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("pid 模式 supervisor", () => {
  // 只有真实 Windows 能证明旧表达式 detached=process.platform !== "win32"
  // 的错误；Linux/macOS 会自然跳过，而不是产生假阳性。
  windowsIt("Windows 下以 detached 进程启动", async () => {
    const reporter = new Reporter({ json: true, jsonl: false });

    await expect(startStack(tempRoot(), reporter, 10)).rejects.toMatchObject({
      code: "START_FAILED",
    });

    expect(mocks.spawn).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Array),
      expect.objectContaining({
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      }),
    );
  });
});
