'use strict';

// Shared by the popup and the countdown in the page. Rounds down to tenths of a
// second so the display never shows more time than is actually left.
// eslint-disable-next-line no-unused-vars
function formatRemaining(ms) {
  const tenths = Math.floor(Math.max(ms, 0) / 100);
  const days = Math.floor(tenths / 864000);
  const hours = Math.floor(tenths / 36000) % 24;
  const minutes = Math.floor(tenths / 600) % 60;
  const seconds = ((tenths % 600) / 10).toFixed(1).replace('.', ',');
  const unit = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  const parts = [];
  if (days) parts.push(unit(days, 'Tag', 'Tage'));
  if (days || hours) parts.push(unit(hours, 'Stunde', 'Stunden'));
  if (days || hours || minutes) parts.push(unit(minutes, 'Minute', 'Minuten'));
  parts.push(`${seconds} Sekunden`);
  return parts.join(' ');
}
