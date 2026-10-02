import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';

dayjs.extend(utc);
dayjs.extend(timezone);

/** Start and end of "today" in the organisation's timezone, as UTC Dates. */
export function todayRange(tz = 'Asia/Kolkata', ref = new Date()) {
  const start = dayjs(ref).tz(tz).startOf('day');
  return { start: start.toDate(), end: start.add(1, 'day').toDate() };
}

export function dayRange(tz: string, from?: string, to?: string) {
  const start = from ? dayjs.tz(from, tz).startOf('day') : dayjs().tz(tz).subtract(29, 'day').startOf('day');
  const end = to ? dayjs.tz(to, tz).endOf('day') : dayjs().tz(tz).endOf('day');
  return { start: start.toDate(), end: end.toDate() };
}

export { dayjs };
