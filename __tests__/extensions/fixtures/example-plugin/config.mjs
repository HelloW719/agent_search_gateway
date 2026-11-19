/** 测试夹具：通过 setup(ctx) 写插件私有配置。 */
export async function setup(ctx) {
  const timeoutMs = ctx.backends.includes("invalid") ? 100 : 20000;
  const config = await ctx.config.patch({ timeout_ms: timeoutMs });
  return { config };
}
