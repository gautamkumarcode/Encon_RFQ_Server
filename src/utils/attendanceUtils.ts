/**
 * Small, dependency-free helpers for attendance: geofence distance and
 * office-timezone day/time math. Kept separate so the controller stays readable
 * and the logic is unit-testable.
 */

/** Great-circle distance in metres between two lat/lng points. */
export function haversineMeters(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): number {
  const R = 6371000; // earth radius, metres
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/** Minutes-into-the-day (0..1439) for an instant, as seen in a timezone. */
export function minutesOfDayInTz(date: Date, tz: string): number {
  const parts = getTimeZoneParts(date, tz);
  return parts.hours * 60 + parts.minutes;
}

/** Calendar day key "YYYY-MM-DD" for an instant in a timezone. */
export function dayKeyInTz(date: Date, tz: string): string {
  const p = getTimeZoneParts(date, tz);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

/** Turn a "YYYY-MM-DD" key into a UTC-midnight Date (stable storage value). */
export function dayKeyToUtcDate(key: string): Date {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(Date.UTC(y, (m || 1) - 1, d || 1));
}

/** Parse "HH:MM" (24h) into minutes; defaults to 0 on bad input. */
export function parseHHMMtoMinutes(hhmm: string): number {
  const [h, m] = String(hhmm || "00:00").split(":").map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) return 0;
  return h * 60 + m;
}

/** Whole minutes between two instants (b - a), floored at 0. */
export function diffMinutes(a: Date, b: Date): number {
  const ms = b.getTime() - a.getTime();
  return Math.max(0, Math.round(ms / 60000));
}

interface TzParts {
  year: number;
  month: number;
  day: number;
  hours: number;
  minutes: number;
}

function getTimeZoneParts(date: Date, tz: string): TzParts {
  try {
    const fmt = new Intl.DateTimeFormat("en-GB", {
      timeZone: tz || "UTC",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
    const parts: Record<string, number> = {};
    for (const p of fmt.formatToParts(date)) {
      if (p.type !== "literal") parts[p.type] = parseInt(p.value, 10);
    }
    // Intl can return 24 for midnight with hour12:false in some locales.
    const hours = parts.hour === 24 ? 0 : parts.hour;
    return {
      year: parts.year,
      month: parts.month,
      day: parts.day,
      hours,
      minutes: parts.minute,
    };
  } catch {
    // Bad timezone - fall back to UTC.
    return {
      year: date.getUTCFullYear(),
      month: date.getUTCMonth() + 1,
      day: date.getUTCDate(),
      hours: date.getUTCHours(),
      minutes: date.getUTCMinutes(),
    };
  }
}
