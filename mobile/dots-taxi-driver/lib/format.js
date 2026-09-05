// Money and time the way the rest of the app writes them, so a fare on the
// trips list matches the fare on the completion card to the character.

export function money(value, currency = 'ZMW') {
  if (value == null || Number.isNaN(Number(value))) return '—';
  return `${currency} ${Number(value).toFixed(2)}`;
}

export function kwacha(value) {
  if (value == null || Number.isNaN(Number(value))) return '—';
  return `K${Number(value).toFixed(2)}`;
}

function sameDay(a, b) {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// "Today · 06:03", "Yesterday · 22:45", "2 Sep · 14:10".
export function whenLabel(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const now = new Date();
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const day = sameDay(d, now)
    ? 'Today'
    : sameDay(d, yesterday)
    ? 'Yesterday'
    : `${d.getDate()} ${MONTHS[d.getMonth()]}`;
  return `${day} · ${hh}:${mm}`;
}

export function isToday(iso) {
  return iso ? sameDay(new Date(iso), new Date()) : false;
}

export function initials(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '·';
  return parts
    .slice(0, 2)
    .map((p) => p[0].toUpperCase())
    .join('');
}
