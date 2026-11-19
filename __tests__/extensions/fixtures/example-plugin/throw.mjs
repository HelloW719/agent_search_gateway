/** 测试夹具：setup 抛异常。 */
export async function setup() {
  throw new Error("BOOM: setup failed");
}
