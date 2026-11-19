/** 测试夹具：fire-and-forget 的异步异常。 */
export async function setup() {
  setTimeout(() => {
    throw new Error("ASYNC_BOOM: fire-and-forget failed");
  }, 10);
  await new Promise((resolve) => setTimeout(resolve, 50));
  return { ok: true };
}
