// ============================================
// Date Utilities
// ============================================

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'
];

const MONTHS_SHORT = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'
];

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Get month name */
export function monthName(monthIndex, short = false) {
  return short ? MONTHS_SHORT[monthIndex] : MONTHS[monthIndex];
}

/** Get day name */
export function dayName(dayIndex) {
  return DAYS[dayIndex];
}

/** Get all day names */
export function dayNames() {
  return [...DAYS];
}

/** Format a date value to "Mar 15, 2026" (any form parseDate accepts) */
export function formatDate(value) {
  const d = parseDate(value);
  if (!d) return '—';
  return `${MONTHS_SHORT[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}

/** Format to "March 2026" */
export function formatMonthYear(date) {
  return `${MONTHS[date.getMonth()]} ${date.getFullYear()}`;
}

/** Get today as ISO date string (YYYY-MM-DD) in local timezone */
export function todayISO() {
  const d = new Date();
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** Get now as ISO string */
export function nowISO() {
  return new Date().toISOString();
}

/** Check if two dates are the same day */
export function isSameDay(a, b) {
  return a.getFullYear() === b.getFullYear()
    && a.getMonth() === b.getMonth()
    && a.getDate() === b.getDate();
}

/** Check if a date is today */
export function isToday(date) {
  return isSameDay(date, new Date());
}

/**
 * Get calendar grid for a month.
 * Returns array of 42 date objects (6 weeks).
 */
export function getMonthGrid(year, month) {
  const firstDay = new Date(year, month, 1);
  const startOffset = firstDay.getDay(); // 0=Sun
  const grid = [];

  for (let i = 0; i < 42; i++) {
    const date = new Date(year, month, 1 - startOffset + i);
    grid.push(date);
  }

  return grid;
}

/** Move month forward or backward */
export function shiftMonth(date, offset) {
  return new Date(date.getFullYear(), date.getMonth() + offset, 1);
}

/** Build a local-midnight Date, or null when the parts don't make a real date. */
function localDate(year, monthIndex, day) {
  const d = new Date(year, monthIndex, day);
  if (isNaN(d.getTime())) return null;
  // new Date(2026, 1, 30) silently rolls to Mar 2 — reject that.
  if (d.getFullYear() !== year || d.getMonth() !== monthIndex || d.getDate() !== day) return null;
  return d;
}

/**
 * Parse a date value into a Date at local midnight, or null when it can't
 * be read. The portal writes dates as YYYY-MM-DD, but Google Sheets turns
 * that into a date cell and hands it back in the spreadsheet's DISPLAY
 * format (US locale: "11/16/2026"), so every reader has to accept:
 *   - "2026-11-16" and "2026-11-16T05:00:00.000Z"   (ISO, date part only)
 *   - "11/16/2026"                                  (Sheets US display format)
 *   - a Sheets serial number, e.g. 46342           (UNFORMATTED_VALUE reads)
 *   - a Date object, or anything else Date can read ("Nov 16, 2026")
 * Only the calendar day matters — the time part is dropped, never shifted
 * through UTC (new Date('YYYY-MM-DD') is UTC midnight, which in US
 * timezones is the previous local day).
 */
export function parseDate(value) {
  if (value === null || value === undefined || value === '') return null;

  if (value instanceof Date) {
    return isNaN(value.getTime()) ? null : localDate(value.getFullYear(), value.getMonth(), value.getDate());
  }

  const str = String(value).trim();
  if (!str) return null;

  // ISO date, optionally followed by a time part.
  let m = str.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T\s]|$)/);
  if (m) return localDate(+m[1], +m[2] - 1, +m[3]);

  // US display format M/D/YYYY (what a Sheets date cell reads back as).
  m = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[\sT]|$)/);
  if (m) return localDate(+m[3], +m[1] - 1, +m[2]);

  // Sheets serial day number (days since 1899-12-30), 1954..2119.
  if (/^\d+(?:\.\d+)?$/.test(str)) {
    const n = Number(str);
    if (n >= 20000 && n <= 80000) {
      const utc = new Date(Date.UTC(1899, 11, 30) + Math.floor(n) * 86400000);
      return localDate(utc.getUTCFullYear(), utc.getUTCMonth(), utc.getUTCDate());
    }
    return null;
  }

  // Anything else the engine can read, e.g. "Nov 16, 2026".
  const d = new Date(str);
  if (isNaN(d.getTime())) return null;
  return localDate(d.getFullYear(), d.getMonth(), d.getDate());
}

/** Check if a date falls within a range (inclusive) */
export function isDateInRange(date, start, end) {
  const d = date.getTime();
  const s = start.getTime();
  const e = end ? end.getTime() : s;
  return d >= s && d <= e;
}
