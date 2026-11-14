import test from "node:test";
import assert from "node:assert/strict";
import { fetch as plugin } from "../index.mjs";

test("只接管 example.com", () => {
  assert.equal(plugin.match(new URL("https://example.com/a")), true);
  assert.equal(plugin.match(new URL("https://sub.example.com/a")), true);
  assert.equal(plugin.match(new URL("https://example.org/a")), false);
});

test("返回 HTML 结果", async () => {
  const result = await plugin.fetch(new URL("https://example.com/a"));
  assert.equal(result.ok, true);
  assert.match(result.html, /example\.com\/a/);
});
