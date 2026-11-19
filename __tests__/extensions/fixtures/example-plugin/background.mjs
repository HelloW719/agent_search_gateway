/** 测试夹具：启动继承 stdio 的孙进程后永远不返回，用于验证 runner 超时清理。 */
export async function setup(ctx) {
  await ctx.mkdir(ctx.paths.tempDir, { recursive: true });
  const pidFile = `${ctx.paths.tempDir}/grandchild.pid`;
  const script = [
    'const {spawn}=require("node:child_process");',
    'const fs=require("node:fs");',
    'const child=spawn(process.execPath,["-e","setTimeout(()=>{}, 30000)"],{stdio:"inherit"});',
    "fs.writeFileSync(process.argv[1], String(child.pid));",
    "setTimeout(()=>{}, 30000);",
  ].join("");

  void ctx
    .run(process.execPath, ["-e", script, pidFile], { timeoutMs: 30_000 })
    .catch(() => {});
  await new Promise(() => {});
}
