/** 测试夹具：未处理的 Promise rejection。 */
export async function setup() {
  void Promise.reject(new Error("REJECTION_BOOM: unhandled"));
  await new Promise((resolve) => setTimeout(resolve, 50));
  return { ok: true };
}
