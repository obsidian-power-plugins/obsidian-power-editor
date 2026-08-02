/* Pure to-do logic: parsing Tasks-format checklist lines (📅 due, ⏳ scheduled,
 * 🛫 start, 🔁 recurrence, ✅ done, priority arrows), completing them (done-date
 * stamping plus spawning the next occurrence of recurring items), and the
 * little query language behind `todo` dashboard blocks. No Obsidian imports —
 * all of this is covered by tests.ts. Dates are local YYYY-MM-DD strings. */

export interface TodoItem {
	indent: string;
	marker: string;
	checked: boolean;
	/** The text with all metadata tokens removed. */
	body: string;
	due?: string;
	scheduled?: string;
	start?: string;
	doneDate?: string;
	/** Optional time of day, ⏰ HH:MM. */
	time?: string;
	/** The raw rule after 🔁, e.g. "every 6 months when done". */
	recurrence?: string;
	/** 0 highest … 5 lowest; 3 = none. */
	priority: number;
	/** Attached by the vault indexer, not the parser. */
	path?: string;
	line?: number;
}

const PRIORITY_EMOJI = ["🔺", "⏫", "🔼", "", "🔽", "⏬"];
const DATE_TOKENS: [keyof TodoItem, string][] = [
	["due", "📅"],
	["scheduled", "⏳"],
	["start", "🛫"],
	["doneDate", "✅"],
];

/** Parse one line; null when it isn't a checklist item. */
export function parseTodo(line: string): TodoItem | null {
	const m = line.match(/^(\s*)([-*+]|\d+[.)])\s+\[(.)\]\s+(.*)$/);
	if (!m) return null;
	const t: TodoItem = { indent: m[1], marker: m[2], checked: m[3] !== " ", body: "", priority: 3 };
	let rest = m[4];
	for (const [key, emoji] of DATE_TOKENS) {
		const dm = rest.match(new RegExp(emoji + "\\uFE0F?\\s*(\\d{4}-\\d{2}-\\d{2})"));
		if (dm) {
			(t as unknown as Record<string, unknown>)[key] = dm[1];
			rest = rest.replace(dm[0], " ");
		}
	}
	const tm = rest.match(/⏰️?\s*(\d{1,2}:\d{2})/);
	if (tm) {
		t.time = tm[1];
		rest = rest.replace(tm[0], " ");
	}
	for (let p = 0; p < PRIORITY_EMOJI.length; p++) {
		if (PRIORITY_EMOJI[p] && rest.includes(PRIORITY_EMOJI[p])) {
			t.priority = p;
			rest = rest.replace(PRIORITY_EMOJI[p], " ");
			break;
		}
	}
	const rm = rest.match(/🔁️?\s*([^\n]*?)\s*$/);
	if (rm && rm[1]) {
		// keep only the longest valid rule — trailing words that aren't part
		// of it (tags, stray text) belong to the body, not the recurrence
		let cand = rm[1].trim();
		while (cand && !parseRecurrence(cand)) cand = cand.replace(/\s*,?\s*\S+$/, "");
		if (cand) {
			t.recurrence = cand;
			const tail = rm[1].trim().slice(cand.length);
			rest = rest.slice(0, rm.index) + " " + tail;
		}
	}
	t.body = rest.replace(/\s+/g, " ").trim();
	return t;
}

/** Reserialize with tokens in canonical order: priority, ⏰, 🔁, 🛫, ⏳, 📅, ✅. */
export function formatTodo(t: TodoItem): string {
	const parts = [t.body];
	if (t.priority !== 3) parts.push(PRIORITY_EMOJI[t.priority]);
	if (t.time) parts.push("⏰ " + t.time);
	if (t.recurrence) parts.push("🔁 " + t.recurrence);
	if (t.start) parts.push("🛫 " + t.start);
	if (t.scheduled) parts.push("⏳ " + t.scheduled);
	if (t.due) parts.push("📅 " + t.due);
	if (t.doneDate) parts.push("✅ " + t.doneDate);
	return `${t.indent}${t.marker} [${t.checked ? "x" : " "}] ` + parts.filter(Boolean).join(" ");
}

/* ---------------- date arithmetic (string in, string out) ---------------- */

const pad = (n: number) => String(n).padStart(2, "0");
const fmt = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;
const parts = (s: string) => s.split("-").map(Number) as [number, number, number];
const daysInMonth = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();

function addDays(date: string, n: number): string {
	const [y, m, d] = parts(date);
	const t = new Date(Date.UTC(y, m - 1, d + n));
	return fmt(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}

function addMonths(date: string, n: number): string {
	const [y, m, d] = parts(date);
	const total = y * 12 + (m - 1) + n;
	const ny = Math.floor(total / 12);
	const nm = (total % 12) + 1;
	return fmt(ny, nm, Math.min(d, daysInMonth(ny, nm)));
}

const diffDays = (a: string, b: string) => {
	const [ay, am, ad] = parts(a);
	const [by, bm, bd] = parts(b);
	return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86400000);
};

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

/** "mon", "tues", "friday" → 0-6 day index; null when it isn't a weekday. */
function weekdayIndex(word: string): number | null {
	const w = word.trim().toLowerCase();
	if (w.length < 3) return null;
	const i = WEEKDAYS.findIndex((full) => full.startsWith(w) || w.startsWith(full));
	return i === -1 ? null : i;
}

const dayOfWeek = (date: string) => {
	const [y, m, d] = parts(date);
	return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
};

interface Recurrence {
	n: number;
	unit: "day" | "week" | "month" | "year";
	/** e.g. [1,3,5] for "every mon, wed, fri"; [1..5] for "every weekday". */
	weekdays: number[] | null;
	/** "every month on the 15th". */
	dayOfMonth: number | null;
	/** "every last friday". */
	lastWeekday: number | null;
	whenDone: boolean;
}

export function parseRecurrence(rule: string): Recurrence | null {
	let r = rule.trim().toLowerCase().replace(/\s+/g, " ");
	const whenDone = / when done$/.test(r);
	r = r.replace(/ when done$/, "");
	const base: Recurrence = { n: 1, unit: "week", weekdays: null, dayOfMonth: null, lastWeekday: null, whenDone };
	let m = r.match(/^every(?: (\d+))? (day|week|month|year)s?$/);
	if (m) return { ...base, n: m[1] ? Number(m[1]) : 1, unit: m[2] as Recurrence["unit"] };
	m = r.match(/^every(?: (\d+))? months? on the (\d+)(?:st|nd|rd|th)?$/);
	if (m) return { ...base, n: m[1] ? Number(m[1]) : 1, unit: "month", dayOfMonth: Number(m[2]) };
	m = r.match(/^every last ([a-z]+)$/);
	if (m) {
		const wd = weekdayIndex(m[1]);
		return wd == null ? null : { ...base, unit: "month", lastWeekday: wd };
	}
	if (/^every weekdays?$/.test(r)) return { ...base, weekdays: [1, 2, 3, 4, 5] };
	m = r.match(/^every ([a-z]{3,9}(?: ?, ?[a-z]{3,9})*)$/);
	if (m) {
		const days = m[1].split(",").map((w) => weekdayIndex(w));
		if (days.every((d): d is number => d != null)) return { ...base, weekdays: [...new Set(days)].sort() };
	}
	return null;
}

/** The last date in `date`'s month that falls on weekday `wd`. */
function lastWeekdayOfMonth(date: string, wd: number): string {
	const [y, m] = parts(date);
	let cur = fmt(y, m, daysInMonth(y, m));
	while (dayOfWeek(cur) !== wd) cur = addDays(cur, -1);
	return cur;
}

function nextDate(base: string, rec: Recurrence): string {
	if (rec.weekdays) {
		let cur = base;
		for (let i = 0; i < 7; i++) {
			cur = addDays(cur, 1);
			if (rec.weekdays.includes(dayOfWeek(cur))) return cur;
		}
		return cur;
	}
	if (rec.lastWeekday != null) return lastWeekdayOfMonth(addMonths(fmt(parts(base)[0], parts(base)[1], 1), 1), rec.lastWeekday);
	if (rec.dayOfMonth != null) {
		const moved = addMonths(base, rec.n);
		const [y, m] = parts(moved);
		return fmt(y, m, Math.min(rec.dayOfMonth, daysInMonth(y, m)));
	}
	if (rec.unit === "day") return addDays(base, rec.n);
	if (rec.unit === "week") return addDays(base, rec.n * 7);
	if (rec.unit === "month") return addMonths(base, rec.n);
	return addMonths(base, rec.n * 12);
}

/** Replace (or add, or with null remove) the 📅 due date on a checklist line. */
export function setDueDate(line: string, date: string | null): string | null {
	const t = parseTodo(line);
	if (!t) return null;
	if (date == null) delete t.due;
	else t.due = date;
	return formatTodo(t);
}

/** Rewrite a checklist line's priority (0 highest … 5 lowest, 3 = none). */
export function setPriority(line: string, priority: number): string | null {
	const t = parseTodo(line);
	if (!t) return null;
	t.priority = Math.max(0, Math.min(5, Math.round(priority)));
	return formatTodo(t);
}

/** Sweep completed items (with their indented children) into a `## Done`
 *  section at the end of the note. Items sheltering an unchecked child stay,
 *  and everything already inside the Done section is left alone. `moved`
 *  counts items, not lines. */
export function archiveCompleted(lines: string[]): { lines: string[]; moved: number } {
	const isDoneHeading = (l: string) => /^##\s+Done\s*$/.test(l);
	// the Done section spans from its heading to the next H1/H2 (or the end)
	let doneStart = lines.findIndex(isDoneHeading);
	let doneEnd = lines.length;
	if (doneStart !== -1) {
		for (let i = doneStart + 1; i < lines.length; i++) {
			if (/^#{1,2}\s/.test(lines[i])) {
				doneEnd = i;
				break;
			}
		}
	}
	const keep: string[] = [];
	const movedLines: string[] = [];
	let moved = 0;
	let i = 0;
	while (i < lines.length) {
		if (doneStart !== -1 && i >= doneStart && i < doneEnd) {
			keep.push(lines[i]);
			i++;
			continue;
		}
		const t = parseTodo(lines[i]);
		if (t?.checked) {
			const indent = (lines[i].match(/^\s*/) as RegExpMatchArray)[0].length;
			let j = i + 1;
			let openChild = false;
			while (j < lines.length && lines[j].trim() && (lines[j].match(/^\s*/) as RegExpMatchArray)[0].length > indent) {
				const c = parseTodo(lines[j]);
				if (c && !c.checked) openChild = true;
				j++;
			}
			if (!openChild) {
				movedLines.push(...lines.slice(i, j));
				moved++;
				i = j;
				continue;
			}
			keep.push(...lines.slice(i, j));
			i = j;
			continue;
		}
		keep.push(lines[i]);
		i++;
	}
	if (!moved) return { lines, moved: 0 };
	// re-find the section in the kept lines, then append inside it or create it
	let out: string[];
	const keptDone = keep.findIndex(isDoneHeading);
	if (keptDone !== -1) {
		let end = keep.length;
		for (let k = keptDone + 1; k < keep.length; k++) {
			if (/^#{1,2}\s/.test(keep[k])) {
				end = k;
				break;
			}
		}
		while (end > keptDone + 1 && !keep[end - 1].trim()) end--;
		out = [...keep.slice(0, end), ...movedLines, ...keep.slice(end)];
	} else {
		while (keep.length && !keep[keep.length - 1].trim()) keep.pop();
		out = [...keep, "", "## Done", "", ...movedLines];
	}
	while (out.length && !out[out.length - 1].trim()) out.pop();
	return { lines: out, moved };
}

/** Flip a checklist line. Completing stamps ✅ (when stampDone) and, for
 *  recurring items, returns the next occurrence to insert as `spawned`:
 *  an unchecked clone with its dates advanced (from today for "when done"
 *  rules and for items that had no dates at all). Unchecking removes ✅. */
export function toggleTodo(
	line: string,
	today: string,
	stampDone: boolean
): { line: string; spawned: string | null } | null {
	const t = parseTodo(line);
	if (!t) return null;
	if (t.checked) {
		t.checked = false;
		delete t.doneDate;
		return { line: formatTodo(t), spawned: null };
	}
	t.checked = true;
	if (stampDone) t.doneDate = today;
	let spawned: string | null = null;
	const rec = t.recurrence ? parseRecurrence(t.recurrence) : null;
	if (rec) {
		const anchor = t.due ?? t.scheduled ?? t.start;
		const base = rec.whenDone || !anchor ? today : anchor;
		const next = nextDate(base, rec);
		const clone: TodoItem = { ...t, checked: false };
		delete clone.doneDate;
		if (anchor) {
			const shift = diffDays(anchor, next);
			if (clone.due) clone.due = addDays(clone.due, shift);
			if (clone.scheduled) clone.scheduled = addDays(clone.scheduled, shift);
			if (clone.start) clone.start = addDays(clone.start, shift);
		} else {
			clone.due = next;
		}
		spawned = formatTodo(clone);
	}
	return { line: formatTodo(t), spawned };
}

/* ---------------- the `todo` block query language ---------------- */

type FilterKind =
	| "done"
	| "notDone"
	| "overdue"
	| "hasDue"
	| "noDue"
	| "recurring"
	| "notRecurring"
	| "dueBefore"
	| "dueAfter"
	| "dueIn"
	| "pathIncludes"
	| "pathExcludes"
	| "textIncludes"
	| "textExcludes"
	| "tagIncludes"
	| "tagExcludes"
	| "priorityIs";

interface Filter {
	kind: FilterKind;
	arg?: string;
}

export interface TodoQuery {
	filters: Filter[];
	sortBy: "due" | "text" | "path" | "priority" | null;
	sortDesc: boolean;
	groupBy: "file" | "due" | "priority" | null;
	limit: number | null;
	view: "list" | "week" | "board";
}

/** One directive per line, ANDed. Unknown lines land in `errors`. */
export function parseQuery(source: string): { query: TodoQuery; errors: string[] } {
	const query: TodoQuery = { filters: [], sortBy: null, sortDesc: false, groupBy: null, limit: null, view: "list" };
	const errors: string[] = [];
	for (const raw of source.split("\n")) {
		const line = raw.trim();
		if (!line || line.startsWith("#")) continue;
		const l = line.toLowerCase();
		let m: RegExpMatchArray | null;
		if (l === "done") query.filters.push({ kind: "done" });
		else if (l === "not done" || l === "hide done") query.filters.push({ kind: "notDone" });
		else if (l === "overdue") query.filters.push({ kind: "overdue" });
		else if (l === "has due date") query.filters.push({ kind: "hasDue" });
		else if (l === "no due date") query.filters.push({ kind: "noDue" });
		else if (l === "is recurring") query.filters.push({ kind: "recurring" });
		else if (l === "is not recurring") query.filters.push({ kind: "notRecurring" });
		else if ((m = l.match(/^due before (.+)$/))) query.filters.push({ kind: "dueBefore", arg: m[1] });
		else if ((m = l.match(/^due after (.+)$/))) query.filters.push({ kind: "dueAfter", arg: m[1] });
		else if ((m = l.match(/^due (?:on )?(.+)$/))) query.filters.push({ kind: "dueIn", arg: m[1] });
		else if ((m = line.match(/^path does not include (.+)$/i))) query.filters.push({ kind: "pathExcludes", arg: m[1] });
		else if ((m = line.match(/^path includes (.+)$/i))) query.filters.push({ kind: "pathIncludes", arg: m[1] });
		else if ((m = line.match(/^text does not include (.+)$/i))) query.filters.push({ kind: "textExcludes", arg: m[1] });
		else if ((m = line.match(/^text includes (.+)$/i))) query.filters.push({ kind: "textIncludes", arg: m[1] });
		else if ((m = line.match(/^tag does not include (.+)$/i))) query.filters.push({ kind: "tagExcludes", arg: m[1] });
		else if ((m = line.match(/^tag includes (.+)$/i))) query.filters.push({ kind: "tagIncludes", arg: m[1] });
		else if ((m = l.match(/^priority is (highest|high|medium|none|low|lowest)$/)))
			query.filters.push({ kind: "priorityIs", arg: m[1] });
		else if ((m = l.match(/^sort by (due|text|path|priority)( desc)?$/))) {
			query.sortBy = m[1] as TodoQuery["sortBy"];
			query.sortDesc = !!m[2];
		} else if ((m = l.match(/^group by (file|due|priority)$/))) query.groupBy = m[1] as TodoQuery["groupBy"];
		else if ((m = l.match(/^view (list|week|board)$/))) query.view = m[1] as TodoQuery["view"];
		else if ((m = l.match(/^limit (\d+)$/))) query.limit = Number(m[1]);
		else errors.push(`Unknown filter: "${line}"`);
	}
	return { query, errors };
}

/** Does the body carry `#tag` as a whole tag (not a prefix of a longer one)? */
function hasTag(body: string, tag: string): boolean {
	const t = tag.startsWith("#") ? tag : "#" + tag;
	const esc = t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(esc + "(?![\\w/-])", "i").test(body);
}

/** "today", "tomorrow", "this week"… → an inclusive [from, to] date range. */
function resolveRange(phrase: string, today: string): [string, string] | null {
	const p = phrase.trim().toLowerCase();
	if (/^\d{4}-\d{2}-\d{2}$/.test(p)) return [p, p];
	if (p === "today") return [today, today];
	if (p === "tomorrow") return [addDays(today, 1), addDays(today, 1)];
	if (p === "yesterday") return [addDays(today, -1), addDays(today, -1)];
	const [y, m, d] = parts(today);
	const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
	const monday = addDays(today, dow === 0 ? -6 : 1 - dow);
	if (p === "this week") return [monday, addDays(monday, 6)];
	if (p === "next week") return [addDays(monday, 7), addDays(monday, 13)];
	if (p === "this month") return [fmt(y, m, 1), fmt(y, m, daysInMonth(y, m))];
	return null;
}

const PRIORITY_NAMES: Record<string, number> = { highest: 0, high: 1, medium: 2, none: 3, low: 4, lowest: 5 };

function matches(t: TodoItem, f: Filter, today: string): boolean {
	switch (f.kind) {
		case "done":
			return t.checked;
		case "notDone":
			return !t.checked;
		case "overdue":
			return !t.checked && t.due != null && t.due < today;
		case "hasDue":
			return t.due != null;
		case "noDue":
			return t.due == null;
		case "recurring":
			return t.recurrence != null;
		case "notRecurring":
			return t.recurrence == null;
		case "dueBefore": {
			const r = resolveRange(f.arg ?? "", today);
			return r != null && t.due != null && t.due < r[0];
		}
		case "dueAfter": {
			const r = resolveRange(f.arg ?? "", today);
			return r != null && t.due != null && t.due > r[1];
		}
		case "dueIn": {
			const r = resolveRange(f.arg ?? "", today);
			return r != null && t.due != null && t.due >= r[0] && t.due <= r[1];
		}
		case "pathIncludes":
			return (t.path ?? "").toLowerCase().includes((f.arg ?? "").toLowerCase());
		case "pathExcludes":
			return !(t.path ?? "").toLowerCase().includes((f.arg ?? "").toLowerCase());
		case "textIncludes":
			return t.body.toLowerCase().includes((f.arg ?? "").toLowerCase());
		case "textExcludes":
			return !t.body.toLowerCase().includes((f.arg ?? "").toLowerCase());
		case "tagIncludes":
			return hasTag(t.body, f.arg ?? "");
		case "tagExcludes":
			return !hasTag(t.body, f.arg ?? "");
		case "priorityIs":
			return t.priority === PRIORITY_NAMES[f.arg ?? "none"];
	}
}

export interface TodoGroup {
	heading: string;
	items: TodoItem[];
}

export const PRIORITY_LABELS = ["Highest", "High", "Medium", "Normal", "Low", "Lowest"];

/** Filter, sort, cap, and group. Ungrouped results come back as one group
 *  with an empty heading; due-sorts and due-groups put dateless items last. */
export function runQuery(query: TodoQuery, items: TodoItem[], today: string): TodoGroup[] {
	let hits = items.filter((t) => query.filters.every((f) => matches(t, f, today)));
	const byDue = (a: TodoItem, b: TodoItem) => (a.due ?? "9999").localeCompare(b.due ?? "9999");
	const byPath = (a: TodoItem, b: TodoItem) => (a.path ?? "").localeCompare(b.path ?? "") || (a.line ?? 0) - (b.line ?? 0);
	const primary: Record<string, (a: TodoItem, b: TodoItem) => number> = {
		due: byDue,
		text: (a, b) => a.body.localeCompare(b.body),
		path: byPath,
		priority: (a, b) => a.priority - b.priority,
	};
	const key = query.sortBy ?? "due";
	const dir = query.sortDesc ? -1 : 1;
	hits = [...hits].sort((a, b) => dir * primary[key](a, b) || byDue(a, b) || byPath(a, b));
	if (query.limit != null) hits = hits.slice(0, query.limit);
	if (!query.groupBy) return hits.length ? [{ heading: "", items: hits }] : [];
	// each group carries a sort key so dates order chronologically ("No date"
	// last) and priorities order by urgency rather than label text
	const meta = (t: TodoItem): [string, string] =>
		query.groupBy === "file"
			? [t.path ?? "", (t.path ?? "").replace(/\.md$/, "")]
			: query.groupBy === "due"
				? [t.due ?? "9999", t.due ?? "No date"]
				: [String(t.priority), PRIORITY_LABELS[t.priority]];
	const groups = new Map<string, { heading: string; items: TodoItem[] }>();
	for (const t of hits) {
		const [k, h] = meta(t);
		const g = groups.get(k) ?? { heading: h, items: [] };
		g.items.push(t);
		groups.set(k, g);
	}
	return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, g]) => g);
}

/* ---------------- natural-language quick capture ---------------- */

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

function monthIndex(word: string): number | null {
	const w = word.trim().toLowerCase();
	if (w.length < 3) return null;
	const i = MONTHS.findIndex((full) => full.startsWith(w));
	return i === -1 ? null : i + 1;
}

/** "tomorrow", "friday", "next friday", "aug 1", "in 3 days" → YYYY-MM-DD,
 *  or null when the phrase isn't a date. Month-day forms without a year roll
 *  forward to the next occurrence. */
export function parseDatePhrase(phrase: string, today: string): string | null {
	const p = phrase.trim().toLowerCase().replace(/\s+/g, " ");
	if (/^\d{4}-\d{2}-\d{2}$/.test(p)) return p;
	if (p === "today") return today;
	if (p === "tomorrow") return addDays(today, 1);
	if (p === "yesterday") return addDays(today, -1);
	if (p === "next week") {
		const dow = dayOfWeek(today);
		return addDays(today, ((1 - dow + 7) % 7) || 7);
	}
	let m = p.match(/^(next )?([a-z]{3,9})$/);
	if (m) {
		const wd = weekdayIndex(m[2]);
		if (wd != null) {
			const ahead = ((wd - dayOfWeek(today) + 7) % 7) || 7;
			return addDays(today, ahead + (m[1] ? 7 : 0));
		}
	}
	m = p.match(/^in (\d+) (day|week|month)s?$/);
	if (m) {
		const n = Number(m[1]);
		return m[2] === "day" ? addDays(today, n) : m[2] === "week" ? addDays(today, n * 7) : addMonths(today, n);
	}
	m = p.match(/^([a-z]{3,9}) (\d{1,2})(?:st|nd|rd|th)?(?: (\d{4}))?$/) ?? p.match(/^(\d{1,2})(?:st|nd|rd|th)? ([a-z]{3,9})(?: (\d{4}))?$/);
	if (m) {
		const monWord = /^\d/.test(m[1]) ? m[2] : m[1];
		const dayWord = /^\d/.test(m[1]) ? m[1] : m[2];
		const mon = monthIndex(monWord);
		const day = Number(dayWord);
		if (mon != null && day >= 1 && day <= 31) {
			const [ty] = parts(today);
			if (m[3]) return fmt(Number(m[3]), mon, Math.min(day, daysInMonth(Number(m[3]), mon)));
			const cand = fmt(ty, mon, Math.min(day, daysInMonth(ty, mon)));
			return cand >= today ? cand : fmt(ty + 1, mon, Math.min(day, daysInMonth(ty + 1, mon)));
		}
	}
	m = p.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?$/);
	if (m) {
		const mon = Number(m[1]);
		const day = Number(m[2]);
		if (mon >= 1 && mon <= 12 && day >= 1 && day <= 31) {
			const [ty] = parts(today);
			if (m[3]) return fmt(Number(m[3]), mon, Math.min(day, daysInMonth(Number(m[3]), mon)));
			const cand = fmt(ty, mon, Math.min(day, daysInMonth(ty, mon)));
			return cand >= today ? cand : fmt(ty + 1, mon, Math.min(day, daysInMonth(ty + 1, mon)));
		}
	}
	return null;
}

/** "rotate tires every 6 months starting aug 1" → body, 🔁 rule, 📅 date.
 *  Dates ride connectors (by / due / on / starting / from) or sit bare at the
 *  end; the recurrence is any valid trailing "every …" clause. */
export function parseQuickTodo(text: string, today: string): { body: string; due?: string; recurrence?: string } {
	let rest = text.trim().replace(/\s+/g, " ");
	let due: string | undefined;
	let recurrence: string | undefined;
	const cm = rest.match(/^(.*)\s+(?:by|due|on|starting|from)\s+(.+)$/i);
	if (cm) {
		const d = parseDatePhrase(cm[2], today);
		if (d) {
			due = d;
			rest = cm[1];
		}
	}
	const rm = rest.match(/(?:^|\s)(every\s.+)$/i);
	if (rm) {
		let cand = rm[1].trim();
		while (cand && !parseRecurrence(cand)) cand = cand.replace(/\s*,?\s*\S+$/, "");
		if (cand) {
			recurrence = cand.toLowerCase();
			rest = (rest.slice(0, rm.index ?? 0) + " " + rm[1].trim().slice(cand.length)).trim();
		}
	}
	if (!due) {
		const words = rest.split(" ");
		for (let take = Math.min(4, words.length - 1); take >= 1; take--) {
			const d = parseDatePhrase(words.slice(-take).join(" "), today);
			if (d) {
				due = d;
				rest = words.slice(0, -take).join(" ");
				break;
			}
		}
	}
	const body = rest
		.replace(/\s+(?:by|due|on|starting|from)$/i, "")
		.replace(/[,;]+\s*$/, "")
		.replace(/\s+/g, " ")
		.trim();
	const out: { body: string; due?: string; recurrence?: string } = { body };
	if (due) out.due = due;
	if (recurrence) out.recurrence = recurrence;
	return out;
}
