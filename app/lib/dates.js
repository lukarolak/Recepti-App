// Calendar-date and week-navigation helpers shared by routes/plan.js and
// routes/shoppingList.js -- both key data off actual calendar dates ('YYYY-MM-DD',
// local time, never UTC -- avoids off-by-one days near midnight), not repeating
// day-of-week labels, so different weeks can have different plans, and both read/
// write the same "selectedWeek" cookie so changing the week on either page follows
// through to the other.
const { getCookie } = require('./cookies');

const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

// Always set explicitly (rather than relying on SQL defaults) so recipes/ingredients'
// updated_at is a plain ISO 8601 UTC string on both the pg and sqlite adapters -- that
// makes it directly string-comparable for the Android build's last-write-wins sync
// (see app/sync/centralSync.js), with no dialect-specific timestamp parsing needed.
function nowIso() {
  return new Date().toISOString();
}

function toDateKey(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function parseDateKey(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function isValidDateKey(key) {
  return typeof key === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(key);
}

function addDays(date, n) {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
}

// Maps JS Date.getDay() (0=Sun..6=Sat) onto our DAYS array order (0=Monday..6=Sunday)
function getDayIndex(date) {
  return (date.getDay() + 6) % 7;
}

function getMondayOf(date) {
  return addDays(date, -getDayIndex(date));
}

function isValidMondayKey(key) {
  return isValidDateKey(key) && toDateKey(getMondayOf(parseDateKey(key))) === key;
}

// ISO 8601 week number, for display only ("Week 38"). The actual identifier used
// everywhere else is the week's Monday date, which sidesteps ISO week-numbering edge
// cases (week 1 vs. 53, year boundaries) entirely.
function getIsoWeekNumber(date) {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  d.setDate(d.getDate() - getDayIndex(d) + 3); // nearest Thursday
  const firstThursday = new Date(d.getFullYear(), 0, 4);
  firstThursday.setDate(firstThursday.getDate() - getDayIndex(firstThursday) + 3);
  return 1 + Math.round((d - firstThursday) / (7 * 24 * 3600 * 1000));
}

// The plan-page week navigator (see index.ejs) never allows going before the current
// week; this both resolves which week is selected AND persists it as a cookie so the
// Shopping List page (which has no week selector of its own) can follow along.
function resolveWeekMonday(req, res) {
  const currentMonday = toDateKey(getMondayOf(new Date()));
  let weekMonday = req.query.week || getCookie(req, 'selectedWeek') || currentMonday;
  if (!isValidMondayKey(weekMonday) || weekMonday < currentMonday) {
    weekMonday = currentMonday;
  }
  res.cookie('selectedWeek', weekMonday, { maxAge: 400 * 24 * 3600 * 1000, path: '/' });
  return weekMonday;
}

// Read-only variant for routes that need to know the selected week but shouldn't
// themselves establish/persist a selection (only the plan page's own navigation does).
function getSelectedWeekMonday(req) {
  const currentMonday = toDateKey(getMondayOf(new Date()));
  const cookieWeek = getCookie(req, 'selectedWeek');
  return isValidMondayKey(cookieWeek) && cookieWeek >= currentMonday ? cookieWeek : currentMonday;
}

// Just for the human-readable "Jul 20 – 26" caption under the week-nav badge -- the
// week number alone doesn't tell most people which actual calendar dates it covers,
// which is the whole point of clarifying this isn't necessarily "this week" (see
// partials/week-nav.ejs).
// Hand-rolled instead of Intl.DateTimeFormat.formatRange: nodejs-mobile's embedded
// Node build has no ICU support, so the global Intl object doesn't exist at all
// there, and an uncaught ReferenceError aborts the whole process on the Android build.
const WEEK_RANGE_MONTHS = {
  en: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
  de: ['Jan.', 'Feb.', 'März', 'Apr.', 'Mai', 'Juni', 'Juli', 'Aug.', 'Sep.', 'Okt.', 'Nov.', 'Dez.'],
  hr: ['sij', 'velj', 'ožu', 'tra', 'svi', 'lip', 'srp', 'kol', 'ruj', 'lis', 'stu', 'pro'],
};

function formatDateRangeLabel(start, end, lang) {
  const months = WEEK_RANGE_MONTHS[lang] || WEEK_RANGE_MONTHS.en;
  const startMonth = months[start.getMonth()];
  const endMonth = months[end.getMonth()];
  const d1 = start.getDate();
  const d2 = end.getDate();
  const sameMonth = start.getMonth() === end.getMonth() && start.getFullYear() === end.getFullYear();

  if (lang === 'de') {
    return sameMonth ? `${d1}.–${d2}. ${endMonth}` : `${d1}. ${startMonth} – ${d2}. ${endMonth}`;
  }
  if (lang === 'hr') {
    return sameMonth ? `${d1}. – ${d2}. ${endMonth}` : `${d1}. ${startMonth} – ${d2}. ${endMonth}`;
  }
  return sameMonth ? `${startMonth} ${d1} – ${d2}` : `${startMonth} ${d1} – ${endMonth} ${d2}`;
}

function formatWeekRangeLabel(weekMonday, lang) {
  const start = parseDateKey(weekMonday);
  const end = addDays(start, 6);
  return formatDateRangeLabel(start, end, lang);
}

// Shared by every page that shows the week navigator (see partials/week-nav.ejs) --
// currently the plan page and the shopping list, both of which read/write the same
// "selectedWeek" cookie, so changing the week on either one propagates to the other.
function getWeekNavData(weekMonday, lang) {
  const monday = parseDateKey(weekMonday);
  const currentMonday = toDateKey(getMondayOf(new Date()));
  return {
    weekMonday,
    weekNumber: getIsoWeekNumber(monday),
    weekRangeLabel: formatWeekRangeLabel(weekMonday, lang),
    isCurrentWeek: weekMonday === currentMonday,
    prevWeekMonday: toDateKey(addDays(monday, -7)),
    nextWeekMonday: toDateKey(addDays(monday, 7)),
  };
}

module.exports = {
  DAYS,
  nowIso,
  toDateKey,
  parseDateKey,
  isValidDateKey,
  addDays,
  getDayIndex,
  getMondayOf,
  isValidMondayKey,
  getIsoWeekNumber,
  formatDateRangeLabel,
  formatWeekRangeLabel,
  getWeekNavData,
  resolveWeekMonday,
  getSelectedWeekMonday,
};
