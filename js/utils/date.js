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

/** Format an ISO date string to "Mar 15, 2026" */
export function formatDate(isoString) {
  if (!isoString) return '—';
  // Strip any time portion and parse as local date parts to avoid
  // timezone shift (new Date('YYYY-MM-DD') parses as UTC midnight,
  // which displays as the previous day in western timezones).
  const parts = String(isoString).split('T')[0].split('-');
  if (parts.length < 3) {
    const d = new Date(isoString);
    if (isNaN(d.getTime())) return '—';
    return `${MONTHS_SHORT[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
  }
  const year = parseInt(parts[0], 10);
  const month = parseInt(parts[1], 10) - 1; // 0-indexed
  const day = parseInt(parts[2], 10);
  if (isNaN(year) || isNaN(month) || isNaN(day)) return '—';
  return `${MONTHS_SHORT[month]} ${day}, ${year}`;
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

/** Parse an ISO date string into a Date at local midnight */
export function parseDate(isoString) {
  if (!isoString) return null;
  const parts = isoString.split('T')[0].split('-');
  return new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]));
}

/** Check if a date falls within a range (inclusive) */
export function isDateInRange(date, start, end) {
  const d = date.getTime();
  const s = start.getTime();
  const e = end ? end.getTime() : s;
  return d >= s && d <= e;
}
