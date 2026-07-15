import assert from "node:assert/strict";
import test from "node:test";

import { ProcessLocalQueue } from "../src/state/process-queue.js";

test("process-local queue serializes one key in submission order and cleans up", async () => {
  const queue = new ProcessLocalQueue();
  const order: number[] = [];
  let active = 0;
  let maximumActive = 0;

  await Promise.all(
    Array.from({ length: 12 }, (_, index) =>
      queue.run("state.json", async () => {
        active++;
        maximumActive = Math.max(maximumActive, active);
        await new Promise((resolve) => setImmediate(resolve));
        order.push(index);
        active--;
      }),
    ),
  );

  assert.equal(maximumActive, 1);
  assert.deepEqual(
    order,
    Array.from({ length: 12 }, (_, index) => index),
  );
  assert.equal(queue.size, 0);
});

test("process-local queue releases the next operation after a failure", async () => {
  const queue = new ProcessLocalQueue();
  const failed = queue.run("state.json", async () => {
    throw new Error("expected failure");
  });
  const recovered = queue.run("state.json", async () => "recovered");

  await assert.rejects(failed, /expected failure/);
  assert.equal(await recovered, "recovered");
  assert.equal(queue.size, 0);
});
