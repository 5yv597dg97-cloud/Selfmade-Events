// iCalendar (.ics) file for "Add to calendar". Events have no end time, so we assume a length.
export const DEFAULT_EVENT_HOURS = 2;

const stamp = (date) => date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

/** Escape text per RFC 5545 §3.3.11 and fold lines longer than 75 octets. */
function escapeText(s) {
  return String(s ?? '').replace(/\\/g, '\\\\').replace(/;/g, '\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}
function fold(line) {
  const out = [];
  let rest = line;
  while (Buffer.byteLength(rest) > 75) {
    let i = 75;
    while (Buffer.byteLength(rest.slice(0, i)) > 75) i--;
    out.push(rest.slice(0, i));
    rest = ` ${rest.slice(i)}`;
  }
  out.push(rest);
  return out.join('\r\n');
}

export function eventIcs(event, { url, host = 'selfmade-events', now = new Date() } = {}) {
  const start = new Date(event.starts_at);
  const end = new Date(start.getTime() + DEFAULT_EVENT_HOURS * 3600 * 1000);
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Selfmade Events//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:event-${event.id}@${host}`,
    `DTSTAMP:${stamp(now)}`,
    `DTSTART:${stamp(start)}`,
    `DTEND:${stamp(end)}`,
    `SUMMARY:${escapeText(event.title)}`,
    `LOCATION:${escapeText(event.venue)}`,
    `DESCRIPTION:${escapeText([event.description, url].filter(Boolean).join('\n\n'))}`,
    ...(url ? [`URL:${url}`] : []),
    ...(event.status === 'cancelled' ? ['STATUS:CANCELLED'] : []),
    'END:VEVENT',
    'END:VCALENDAR',
  ];
  return `${lines.map(fold).join('\r\n')}\r\n`;
}

/** Google Calendar "create event" link with the same details. */
export function googleCalendarUrl(event, { url } = {}) {
  const start = new Date(event.starts_at);
  const end = new Date(start.getTime() + DEFAULT_EVENT_HOURS * 3600 * 1000);
  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: event.title,
    dates: `${stamp(start)}/${stamp(end)}`,
    location: event.venue,
    details: [event.description, url].filter(Boolean).join('\n\n'),
  });
  return `https://calendar.google.com/calendar/render?${params}`;
}
