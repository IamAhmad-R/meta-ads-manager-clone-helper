import { mapLimit } from '../extension/src/lib/pool.js';

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`ok   ${name}`);
  } catch (error) {
    console.log(`FAIL ${name}\n     ${error.message}`);
    process.exitCode = 1;
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

await test('never exceeds the concurrency limit', async () => {
  let active = 0;
  let peak = 0;
  await mapLimit([1, 2, 3, 4, 5, 6], 2, async () => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
  });
  assert(peak === 2, `peak was ${peak}`);
});

await test('preserves input order', async () => {
  const out = await mapLimit([3, 1, 2], 3, async (value) => {
    await new Promise((resolve) => setTimeout(resolve, value * 2));
    return value * 10;
  });
  assert(out.join(',') === '30,10,20', `got ${out}`);
});

await test('handles an empty list and a limit above the item count', async () => {
  const empty = await mapLimit([], 4, async () => 1);
  assert(empty.length === 0, 'empty list should stay empty');
  const wide = await mapLimit([1, 2], 8, async (value) => value);
  assert(wide.join(',') === '1,2', `got ${wide}`);
});

console.log(`\n${passed} pool checks passed`);
