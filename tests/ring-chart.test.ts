import { test } from "node:test";
import assert from "node:assert/strict";
import { ringSegments, ringValueLabel } from "../src/lib/ring-chart";
test("环图区分缺失、有效零值和空闲收发占比", () => {
  assert.equal(ringSegments(null).state, "unknown");
  assert.equal(ringSegments(undefined).fraction, null);
  assert.equal(ringSegments(0).fraction, 0);
  assert.equal(ringSegments(0, 0).state, "idle");
  assert.equal(ringSegments(NaN).fraction, null);
  assert.equal(ringSegments(-1).fraction, null);
});
test("占用与收发比例保持真实口径，超限负载只限制圆弧", () => {
  assert.equal(ringSegments(64.5).fraction, 0.645);
  assert.equal(ringSegments(300, 400).fraction, 0.75);
  assert.equal(ringSegments(120).fraction, 1);
  assert.equal(ringValueLabel(120, "%")?.value, "120");
});
test("大速率使用明确二进制单位，缺失不格式化为零", () => {
  assert.deepEqual(ringValueLabel(1024 * 1024, "B/s"), {
    value: "1",
    unit: "MiB/s",
  });
  assert.deepEqual(ringValueLabel(0, "B/s"), { value: "0", unit: "B/s" });
  assert.equal(ringValueLabel(null, "B/s"), null);
});
