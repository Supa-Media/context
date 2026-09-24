/** iCalendar parsing and recurrence expansion for the calendar sync. Moved verbatim out of `src/index.js`. */

export function parseIcs(ics) {
  // Unfold continuation lines (RFC 5545 §3.1)
  const lines = ics.replace(/\r\n/g, "\n").replace(/\n[ \t]/g, "").split("\n");
  const events = [];
  let cur = null;
  for (const line of lines) {
    if (line === "BEGIN:VEVENT") cur = {};
    else if (line === "END:VEVENT") {
      if (cur) events.push(cur);
      cur = null;
    } else if (cur) {
      const idx = line.indexOf(":");
      if (idx < 0) continue;
      const nameAndParams = line.slice(0, idx);
      const value = line.slice(idx + 1);
      const name = nameAndParams.split(";")[0];
      if (name === "SUMMARY") cur.summary = unescapeIcs(value);
      else if (name === "LOCATION") cur.location = unescapeIcs(value);
      else if (name === "UID") cur.uid = value;
      else if (name === "STATUS") cur.status = value;
      else if (name === "RRULE") cur.rrule = value;
      else if (name === "RECURRENCE-ID") cur.recurrenceId = parseIcsDate(value);
      else if (name === "EXDATE") {
        cur.exdates ||= [];
        cur.exdates.push(...value.split(",").map(parseIcsDate).filter(Boolean));
      } else if (name === "RDATE") {
        cur.rdates ||= [];
        cur.rdates.push(...value.split(",").map((v) => parseIcsDate(v.split("/")[0])).filter(Boolean));
      }
      else if (name === "DTSTART") {
        cur.allDay = nameAndParams.includes("VALUE=DATE") || /^\d{8}$/.test(value);
        cur.start = parseIcsDate(value);
      }
    }
  }
  return events;
}

const WEEKDAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];

export function expandCalendarEvents(events, windowStart, windowEnd) {
  const exceptions = new Map();
  for (const event of events) {
    if (!event.uid || !event.recurrenceId) continue;
    if (!exceptions.has(event.uid)) exceptions.set(event.uid, new Map());
    exceptions.get(event.uid).set(event.recurrenceId.getTime(), event);
  }

  const usedExceptions = new Set();
  const expanded = [];
  for (const event of events) {
    if (!event.start || event.recurrenceId || event.status === "CANCELLED") continue;
    const starts = event.rrule
      ? expandRecurrenceStarts(event, windowStart, windowEnd)
      : [event.start];
    for (const rdate of event.rdates || []) starts.push(rdate);

    const seenStarts = new Set();
    for (const recurrenceStart of starts.sort((a, b) => a - b)) {
      const recurrenceTime = recurrenceStart.getTime();
      if (seenStarts.has(recurrenceTime)) continue;
      seenStarts.add(recurrenceTime);
      if ((event.exdates || []).some((date) => date.getTime() === recurrenceTime)) continue;

      const exception = event.uid ? exceptions.get(event.uid)?.get(recurrenceTime) : null;
      if (exception) usedExceptions.add(exception);
      if (exception?.status === "CANCELLED") continue;

      const actualStart = exception?.start || recurrenceStart;
      if (actualStart < windowStart || actualStart > windowEnd) continue;
      expanded.push({
        ...event,
        ...exception,
        start: actualStart,
        summary: exception?.summary ?? event.summary,
        location: exception?.location ?? event.location,
        allDay: exception?.allDay ?? event.allDay,
        rrule: undefined,
        recurrenceId: undefined,
      });
    }
  }

  // A moved exception can land inside the window even when its original
  // occurrence is outside it, so include any such unconsumed exception.
  for (const event of events) {
    if (
      event.recurrenceId &&
      !usedExceptions.has(event) &&
      event.status !== "CANCELLED" &&
      event.start &&
      event.start >= windowStart &&
      event.start <= windowEnd
    ) {
      expanded.push({ ...event, recurrenceId: undefined });
    }
  }

  return expanded;
}

function expandRecurrenceStarts(event, windowStart, windowEnd) {
  const rule = parseRrule(event.rrule);
  if (!rule || !["DAILY", "WEEKLY", "MONTHLY", "YEARLY"].includes(rule.freq)) {
    return [event.start];
  }

  const start = event.start;
  const until = rule.until || windowEnd;
  const scanEnd = until < windowEnd ? until : windowEnd;
  const cursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()));
  const lastDay = new Date(Date.UTC(scanEnd.getUTCFullYear(), scanEnd.getUTCMonth(), scanEnd.getUTCDate()));
  const matches = [];

  while (cursor <= lastDay) {
    const candidate = new Date(Date.UTC(
      cursor.getUTCFullYear(),
      cursor.getUTCMonth(),
      cursor.getUTCDate(),
      start.getUTCHours(),
      start.getUTCMinutes(),
      start.getUTCSeconds(),
      start.getUTCMilliseconds()
    ));
    if (candidate >= start && candidate <= until && matchesRecurrenceDate(candidate, start, rule)) {
      matches.push(candidate);
    }
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  const positioned = applyBySetPos(matches, rule);
  const counted = rule.count ? positioned.slice(0, rule.count) : positioned;
  return counted.filter((date) => date >= windowStart && date <= windowEnd);
}

function parseRrule(text) {
  if (!text) return null;
  const values = {};
  for (const part of text.split(";")) {
    const idx = part.indexOf("=");
    if (idx > 0) values[part.slice(0, idx)] = part.slice(idx + 1);
  }
  if (!values.FREQ) return null;
  const until = values.UNTIL ? parseIcsDate(values.UNTIL) : null;
  if (until && /^\d{8}$/.test(values.UNTIL)) until.setUTCHours(23, 59, 59, 999);
  const weekStart = WEEKDAYS.indexOf(values.WKST || "MO");
  return {
    freq: values.FREQ,
    interval: Math.max(1, Number.parseInt(values.INTERVAL || "1", 10) || 1),
    count: Math.max(0, Number.parseInt(values.COUNT || "0", 10) || 0),
    until,
    byday: parseByDay(values.BYDAY),
    bymonthday: parseNumberList(values.BYMONTHDAY),
    bymonth: parseNumberList(values.BYMONTH),
    bysetpos: parseNumberList(values.BYSETPOS),
    wkst: weekStart < 0 ? 1 : weekStart,
  };
}

function parseNumberList(value) {
  if (!value) return [];
  return value.split(",").map((item) => Number.parseInt(item, 10)).filter(Number.isFinite);
}

function parseByDay(value) {
  if (!value) return [];
  return value.split(",").map((item) => {
    const match = item.match(/^([+-]?\d+)?(SU|MO|TU|WE|TH|FR|SA)$/);
    return match
      ? { ordinal: Number.parseInt(match[1] || "0", 10), weekday: WEEKDAYS.indexOf(match[2]) }
      : null;
  }).filter(Boolean);
}

function matchesRecurrenceDate(candidate, start, rule) {
  const dayMs = 24 * 3600 * 1000;
  const dayDiff = Math.floor((startOfUtcDay(candidate) - startOfUtcDay(start)) / dayMs);
  const monthDiff =
    (candidate.getUTCFullYear() - start.getUTCFullYear()) * 12 +
    candidate.getUTCMonth() - start.getUTCMonth();
  const yearDiff = candidate.getUTCFullYear() - start.getUTCFullYear();

  if (rule.bymonth.length && !rule.bymonth.includes(candidate.getUTCMonth() + 1)) return false;
  if (rule.bymonthday.length && !matchesMonthDay(candidate, rule.bymonthday)) return false;
  if (rule.byday.length && !matchesByDay(candidate, rule.byday, rule.freq, rule.bymonth.length > 0)) return false;

  if (rule.freq === "DAILY") return dayDiff % rule.interval === 0;
  if (rule.freq === "WEEKLY") {
    const weekDiff = Math.floor(
      (startOfWeek(candidate, rule.wkst) - startOfWeek(start, rule.wkst)) / (7 * dayMs)
    );
    const allowedDays = rule.byday.length
      ? rule.byday.map((item) => item.weekday)
      : [start.getUTCDay()];
    return weekDiff % rule.interval === 0 && allowedDays.includes(candidate.getUTCDay());
  }
  if (rule.freq === "MONTHLY") {
    if (monthDiff % rule.interval !== 0) return false;
    if (!rule.bymonthday.length && !rule.byday.length) {
      return candidate.getUTCDate() === start.getUTCDate();
    }
    return true;
  }
  if (rule.freq === "YEARLY") {
    if (yearDiff % rule.interval !== 0) return false;
    if (!rule.bymonth.length && candidate.getUTCMonth() !== start.getUTCMonth()) return false;
    if (!rule.bymonthday.length && !rule.byday.length) {
      return candidate.getUTCDate() === start.getUTCDate();
    }
    return true;
  }
  return false;
}

function matchesMonthDay(date, values) {
  const day = date.getUTCDate();
  const daysInMonth = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  return values.some((value) => value > 0 ? day === value : day === daysInMonth + value + 1);
}

function matchesByDay(date, values, frequency, hasByMonth) {
  return values.some(({ ordinal, weekday }) => {
    if (date.getUTCDay() !== weekday) return false;
    if (!ordinal || frequency === "DAILY" || frequency === "WEEKLY") return true;
    if (frequency === "MONTHLY" || (frequency === "YEARLY" && hasByMonth)) {
      const ordinals = weekdayOrdinalsInMonth(date);
      return ordinal > 0 ? ordinal === ordinals.positive : ordinal === ordinals.negative;
    }
    if (frequency === "YEARLY") {
      const ordinals = weekdayOrdinalsInYear(date);
      return ordinal > 0 ? ordinal === ordinals.positive : ordinal === ordinals.negative;
    }
    return true;
  });
}

function weekdayOrdinalsInMonth(date) {
  const daysInMonth = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  return {
    positive: Math.ceil(date.getUTCDate() / 7),
    negative: -Math.ceil((daysInMonth - date.getUTCDate() + 1) / 7),
  };
}

function weekdayOrdinalsInYear(date) {
  const yearStart = Date.UTC(date.getUTCFullYear(), 0, 1);
  const nextYear = Date.UTC(date.getUTCFullYear() + 1, 0, 1);
  const dayOfYear = Math.floor((startOfUtcDay(date) - yearStart) / (24 * 3600 * 1000)) + 1;
  const daysInYear = Math.floor((nextYear - yearStart) / (24 * 3600 * 1000));
  return {
    positive: Math.ceil(dayOfYear / 7),
    negative: -Math.ceil((daysInYear - dayOfYear + 1) / 7),
  };
}

function applyBySetPos(matches, rule) {
  if (!rule.bysetpos.length) return matches;
  const groups = new Map();
  for (const date of matches) {
    const key = recurrencePeriodKey(date, rule);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(date);
  }
  const selected = [];
  for (const dates of groups.values()) {
    for (const position of rule.bysetpos) {
      const index = position > 0 ? position - 1 : dates.length + position;
      if (dates[index]) selected.push(dates[index]);
    }
  }
  return [...new Map(selected.map((date) => [date.getTime(), date])).values()].sort((a, b) => a - b);
}

function recurrencePeriodKey(date, rule) {
  if (rule.freq === "YEARLY") return `${date.getUTCFullYear()}`;
  if (rule.freq === "MONTHLY") return `${date.getUTCFullYear()}-${date.getUTCMonth()}`;
  if (rule.freq === "WEEKLY") return `${startOfWeek(date, rule.wkst)}`;
  return `${startOfUtcDay(date)}`;
}

function startOfUtcDay(date) {
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

function startOfWeek(date, weekStart) {
  const dayStart = startOfUtcDay(date);
  const offset = (date.getUTCDay() - weekStart + 7) % 7;
  return dayStart - offset * 24 * 3600 * 1000;
}

function parseIcsDate(v) {
  let mm = v.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/);
  if (mm) {
    // Treat non-UTC (TZID) timestamps as UTC — approximate but predictable.
    return new Date(Date.UTC(+mm[1], +mm[2] - 1, +mm[3], +mm[4], +mm[5], +mm[6]));
  }
  mm = v.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (mm) return new Date(Date.UTC(+mm[1], +mm[2] - 1, +mm[3]));
  return null;
}

function unescapeIcs(s) {
  return s.replace(/\\n/g, " · ").replace(/\\([,;\\])/g, "$1");
}
