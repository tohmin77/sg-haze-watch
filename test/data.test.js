const test = require('node:test');
const assert = require('node:assert');
const { countHotspots, sgDate, mapLimit } = require('../api/data.js')._test;

test('countHotspots counts rows and finds the date', () => {
  const txt = 'Pass 2026-10-15\nS/No Longitude Latitude\n1 101.5 -2.1\n2 102.0 -1.9\n';
  assert.deepStrictEqual(countHotspots(txt), { n: 2, date: '2026-10-15' });
});

test('countHotspots returns 0 for unrecognised format', () => {
  assert.strictEqual(countHotspots('<html>moved</html>').n, 0);
});

test('sgDate is a YYYY-MM-DD string', () => {
  assert.match(sgDate(0), /^\d{4}-\d{2}-\d{2}$/);
});

test('mapLimit caps concurrency and captures failures', async () => {
  let active = 0, peak = 0;
  const r = await mapLimit([1, 2, 3, 4, 5, 6], 2, async (n) => {
    active++; peak = Math.max(peak, active);
    await new Promise((x) => setTimeout(x, 5));
    active--;
    if (n === 3) throw new Error('boom');
    return n;
  });
  assert.strictEqual(peak, 2);
  assert.strictEqual(r[2].status, 'rejected');
  assert.strictEqual(r[5].value, 6);
});
