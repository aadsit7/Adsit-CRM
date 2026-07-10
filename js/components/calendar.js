// ============================================
// Calendar Grid Component
// ============================================

import { el, clear } from '../utils/dom.js';
import {
  dayNames, getMonthGrid, formatMonthYear,
  shiftMonth, isToday, isSameDay, parseDate, isDateInRange
} from '../utils/date.js';

/**
 * Render a monthly calendar with events.
 * @param {HTMLElement} container
 * @param {Array} events - Parsed event objects
 * @param {Function} onEventClick - Called with event object
 * @returns {{ destroy: Function }}
 */
export function renderCalendar(container, events, onEventClick) {
  let currentDate = new Date();
  currentDate = new Date(currentDate.getFullYear(), currentDate.getMonth(), 1);

  const calendarEl = el('div', { class: 'calendar' });

  function render() {
    clear(calendarEl);

    // Header with month nav
    const header = el('div', { class: 'calendar__header' },
      el('h3', { class: 'calendar__title' }, formatMonthYear(currentDate)),
      el('div', { class: 'calendar__nav' },
        el('button', {
          class: 'calendar__nav-btn',
          html: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M10 3L5 8l5 5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
          onClick: () => { currentDate = shiftMonth(currentDate, -1); render(); }
        }),
        el('button', {
          class: 'btn btn--ghost btn--sm',
          onClick: () => { currentDate = new Date(new Date().getFullYear(), new Date().getMonth(), 1); render(); }
        }, 'Today'),
        el('button', {
          class: 'calendar__nav-btn',
          html: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M6 3l5 5-5 5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
          onClick: () => { currentDate = shiftMonth(currentDate, 1); render(); }
        })
      )
    );

    // Grid
    const grid = el('div', { class: 'calendar__grid' });

    // Weekday headers
    dayNames().forEach(day => {
      grid.appendChild(el('div', { class: 'calendar__weekday' }, day));
    });

    // Day cells
    const days = getMonthGrid(currentDate.getFullYear(), currentDate.getMonth());
    const currentMonth = currentDate.getMonth();

    days.forEach(date => {
      const isOutside = date.getMonth() !== currentMonth;
      const today = isToday(date);

      const dayClasses = [
        'calendar__day',
        isOutside ? 'calendar__day--outside' : '',
        today ? 'calendar__day--today' : '',
      ].filter(Boolean).join(' ');

      const dayEl = el('div', { class: dayClasses });

      // Day number
      const numberEl = el('div', { class: 'calendar__day-number' }, String(date.getDate()));
      dayEl.appendChild(numberEl);

      // Events for this day
      if (!isOutside) {
        const dayEvents = getEventsForDay(events, date);
        const maxShow = 2;

        dayEvents.slice(0, maxShow).forEach(evt => {
          const typeClass = evt.event_type?.toLowerCase() || 'other';
          const eventEl = el('div', {
            class: `calendar__event calendar__event--${typeClass}`,
            title: evt.title,
            onClick: (e) => {
              e.stopPropagation();
              if (onEventClick) onEventClick(evt);
            }
          }, evt.title);
          dayEl.appendChild(eventEl);
        });

        if (dayEvents.length > maxShow) {
          dayEl.appendChild(
            el('div', { class: 'calendar__more' }, `+${dayEvents.length - maxShow} more`)
          );
        }
      }

      grid.appendChild(dayEl);
    });

    calendarEl.append(header, grid);
  }

  render();
  clear(container);
  container.appendChild(calendarEl);

  return {
    destroy: () => clear(container),
    refresh: (newEvents) => { events = newEvents; render(); }
  };
}

function getEventsForDay(events, date) {
  return events.filter(evt => {
    const start = parseDate(evt.event_date);
    const end = evt.end_date ? parseDate(evt.end_date) : start;
    if (!start) return false;
    return isDateInRange(date, start, end);
  });
}
