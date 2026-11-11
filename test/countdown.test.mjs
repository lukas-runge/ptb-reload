import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../extension/countdown.js', import.meta.url), 'utf8');
const context = {};
vm.runInNewContext(source, context);
const { formatRemaining } = context;

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

test('kurze Restzeit nur in Sekunden', () => {
  assert.equal(formatRemaining(5_349), '5,3 Sekunden');
  assert.equal(formatRemaining(59_999), '59,9 Sekunden');
  assert.equal(formatRemaining(0), '0,0 Sekunden');
  assert.equal(formatRemaining(-250), '0,0 Sekunden');
});

test('rundet nie auf', () => {
  assert.equal(formatRemaining(MINUTE - 1), '59,9 Sekunden');
  assert.equal(formatRemaining(HOUR - 1), '59 Minuten 59,9 Sekunden');
  assert.equal(formatRemaining(99), '0,0 Sekunden');
});

test('größere Einheiten mit Singular und Plural', () => {
  assert.equal(formatRemaining(MINUTE), '1 Minute 0,0 Sekunden');
  assert.equal(formatRemaining(3 * HOUR + 20 * MINUTE + 5_400), '3 Stunden 20 Minuten 5,4 Sekunden');
  assert.equal(formatRemaining(HOUR + 5_000), '1 Stunde 0 Minuten 5,0 Sekunden');
  assert.equal(formatRemaining(DAY), '1 Tag 0 Stunden 0 Minuten 0,0 Sekunden');
  assert.equal(
    formatRemaining(2 * DAY + HOUR + MINUTE + 1_100),
    '2 Tage 1 Stunde 1 Minute 1,1 Sekunden',
  );
});

test('Zehntelsekunden bleiben über Tage exakt', () => {
  assert.equal(formatRemaining(40 * DAY + 123), '40 Tage 0 Stunden 0 Minuten 0,1 Sekunden');
});
