/** 测试夹具：setup 永不返回，用于验证 runner 超时。 */
export async function setup(ctx) {
  ctx.log("hang:start");
  await new Promise(() => {});
}
