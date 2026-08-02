/* Pure block logic for the drag handles and move commands: given the note as
 * lines, work out what "the block under this line" is, where blocks begin, and
 * what the document looks like after moving one. No Obsidian imports: all of
 * this is covered by tests.ts. */

export interface BlockRange {
	from: number;
	to: number; // inclusive line indexes
}

const isBlank = (l: string) => !l.trim();
const isFenceMark = (l: string) => /^\s*(```|~~~)/.test(l);
const isHeading = (l: string) => /^#{1,6}\s/.test(l);
const isTableLine = (l: string) => /^\s*\|/.test(l);
const isQuoteLine = (l: string) => /^\s*>/.test(l);
const listMatch = (l: string) => l.match(/^(\s*)(?:[-*+]|\d+[.)])\s/);
const indentOf = (l: string) => (l.match(/^\s*/) as RegExpMatchArray)[0].length;

/** The exclusive end of a leading frontmatter block, or 0 when there is none. */
export function frontmatterEnd(lines: string[]): number {
	if (lines[0] !== "---") return 0;
	for (let i = 1; i < lines.length; i++) {
		if (lines[i] === "---" || lines[i] === "...") return i + 1;
	}
	return lines.length;
}

/** Fence ranges, so a hover inside a code block grabs the whole block. */
function fenceRangeAt(lines: string[], line: number, fmEnd: number): BlockRange | null {
	let open = -1;
	for (let i = fmEnd; i <= line; i++) {
		if (isFenceMark(lines[i])) {
			if (open < 0) open = i;
			else if (i < line) open = -1; // a fence closed before our line
			else return { from: open, to: i }; // our line IS the closing mark
		}
	}
	if (open < 0) return null;
	for (let i = line + 1; i < lines.length; i++) {
		if (isFenceMark(lines[i])) return { from: open, to: i };
	}
	return { from: open, to: lines.length - 1 }; // unclosed fence runs out
}

/** The draggable block containing `line`, or null on blanks/frontmatter.
 *  Fences, tables, and quotes travel whole; a list item carries its indented
 *  children; headings travel alone; paragraphs are contiguous plain lines. */
export function blockRangeAt(lines: string[], line: number): BlockRange | null {
	if (line < 0 || line >= lines.length) return null;
	const fmEnd = frontmatterEnd(lines);
	if (line < fmEnd) return null;
	const l = lines[line];
	if (isBlank(l)) return null;
	const fence = fenceRangeAt(lines, line, fmEnd);
	if (fence) return fence;
	if (isTableLine(l)) {
		let from = line;
		let to = line;
		while (from > fmEnd && isTableLine(lines[from - 1])) from--;
		while (to < lines.length - 1 && isTableLine(lines[to + 1])) to++;
		return { from, to };
	}
	if (isQuoteLine(l)) {
		let from = line;
		let to = line;
		while (from > fmEnd && isQuoteLine(lines[from - 1])) from--;
		while (to < lines.length - 1 && isQuoteLine(lines[to + 1])) to++;
		return { from, to };
	}
	if (isHeading(l)) return { from: line, to: line };
	const lm = listMatch(l);
	if (lm) {
		const indent = lm[1].length;
		let to = line;
		for (let i = line + 1; i < lines.length; i++) {
			const cur = lines[i];
			if (isBlank(cur)) {
				// a blank belongs to the item only if deeper content follows
				const next = lines[i + 1];
				if (next !== undefined && !isBlank(next) && indentOf(next) > indent) continue;
				break;
			}
			if (indentOf(cur) > indent) {
				to = i;
				continue;
			}
			break;
		}
		return { from: line, to };
	}
	// an indented continuation under a list item drags the owning item
	if (indentOf(l) > 0) {
		for (let k = line - 1; k >= fmEnd; k--) {
			if (isBlank(lines[k])) continue;
			const pm = listMatch(lines[k]);
			if (pm && pm[1].length < indentOf(l)) return blockRangeAt(lines, k);
			if (indentOf(lines[k]) === 0) break;
		}
	}
	// paragraph: contiguous plain lines, stopping at structural neighbors
	const structural = (s: string) =>
		isBlank(s) || isHeading(s) || isFenceMark(s) || isTableLine(s) || isQuoteLine(s) || listMatch(s) != null;
	let from = line;
	let to = line;
	while (from > fmEnd && !structural(lines[from - 1])) from--;
	while (to < lines.length - 1 && !structural(lines[to + 1])) to++;
	return { from, to };
}

/** True when `line` sits inside a `> [!transcript]` callout: it must itself be
 *  a quote line, and the top of its contiguous quote run must carry the
 *  transcript header. Power Assistant renders the meeting transcript as one of
 *  these and owns its own speaker/comment interactions, so Power Editor keeps
 *  its block grip and callout menu off it. Narrow by design, the header type
 *  must be exactly `transcript`, so every other callout is untouched. */
export function isTranscriptCalloutAt(lines: string[], line: number): boolean {
	if (line < 0 || line >= lines.length || !isQuoteLine(lines[line])) return false;
	let i = line;
	while (i > 0 && isQuoteLine(lines[i - 1])) i--;
	return /^\s*>\s*\[!transcript\]/i.test(lines[i]);
}

/** True when `line` is a migrated transcript turn: a plain `**Name:**` /
 *  `**Name [m:ss]:**` speaker line sitting under a `## Transcript` heading.
 *  Power Assistant moved the meeting transcript off the `> [!transcript]`
 *  callout (see isTranscriptCalloutAt) onto always-editable plain lines, badging
 *  each turn with a speaker avatar in Live Preview. Those turns own their own
 *  interactions and are never individually reordered, so Power Editor keeps its
 *  block grip and callout menu off them. Narrow by design: the line must BOTH
 *  look like a speaker turn AND live in the Transcript section, the nearest
 *  heading above it must be exactly `## Transcript` (the section runs to the next
 *  heading of any level), so ordinary prose, even a bold `**Note:**` lead-in
 *  elsewhere, keeps its affordances. Mirrors Power Assistant's own section scan
 *  and speaker-line shape. */
export function isTranscriptTurnAt(lines: string[], line: number): boolean {
	if (line < 0 || line >= lines.length) return false;
	if (!/^\*\*.+?:\*\*/.test(lines[line])) return false; // not a speaker turn
	for (let i = line - 1; i >= 0; i--) {
		if (/^#{1,6}\s/.test(lines[i])) return /^##\s+Transcript\s*$/.test(lines[i]);
	}
	return false; // no heading above → not in a Transcript section
}

/** First lines of every block, in order, the valid drop boundaries (plus the
 *  end of the document, which callers represent as lines.length). */
export function blockStarts(lines: string[]): number[] {
	const starts: number[] = [];
	let i = frontmatterEnd(lines);
	while (i < lines.length) {
		if (isBlank(lines[i])) {
			i++;
			continue;
		}
		const r = blockRangeAt(lines, i);
		if (!r) {
			i++;
			continue;
		}
		starts.push(r.from);
		i = r.to + 1;
	}
	return starts;
}

const isListy = (l: string | undefined) => l !== undefined && (listMatch(l) != null || (!isBlank(l) && indentOf(l) > 0));

/** A heading's whole section: the heading plus everything until the next
 *  heading of the same or higher level (fence contents never end a section).
 *  Non-headings just get their normal block. */
export function sectionRangeAt(lines: string[], line: number): BlockRange | null {
	const base = blockRangeAt(lines, line);
	if (!base) return null;
	const hm = lines[base.from].match(/^(#{1,6})\s/);
	if (!hm) return base;
	const level = hm[1].length;
	let to = base.to;
	let inFence = false;
	for (let i = base.from + 1; i < lines.length; i++) {
		if (isFenceMark(lines[i])) inFence = !inFence;
		if (!inFence) {
			const m = lines[i].match(/^(#{1,6})\s/);
			if (m && m[1].length <= level) break;
		}
		to = i;
	}
	while (to > base.from && isBlank(lines[to])) to--;
	return { from: base.from, to };
}

/** The union of the blocks touched by lines a..b, how a selection spanning
 *  several blocks becomes one draggable unit. */
export function unionBlockRange(lines: string[], a: number, b: number, sections = false): BlockRange | null {
	let lo = Math.min(a, b);
	let hi = Math.max(a, b);
	while (lo <= hi && (lines[lo] === undefined || isBlank(lines[lo]))) lo++;
	while (hi >= lo && (lines[hi] === undefined || isBlank(lines[hi]))) hi--;
	if (lo > hi) return null;
	const get = sections ? sectionRangeAt : blockRangeAt;
	const r1 = get(lines, lo);
	const r2 = get(lines, hi);
	if (!r1 || !r2) return null;
	return { from: Math.min(r1.from, r2.from), to: Math.max(r1.to, r2.to) };
}

export type BlockKind = "paragraph" | "h1" | "h2" | "h3" | "bullet" | "ordered" | "task" | "quote" | "callout" | "toggleList";

/** Widen a list item's range to the whole contiguous list at its indent, so a
 *  "turn into toggle" converts the list, first item as the title, the rest as
 *  children, instead of wrapping one bullet and stranding its siblings.
 *  Non-list ranges pass through unchanged. */
export function listStretchRange(lines: string[], range: BlockRange): BlockRange {
	const lm = listMatch(lines[range.from] ?? "");
	if (!lm) return range;
	const indent = lm[1].length;
	const fmEnd = frontmatterEnd(lines);
	let from = range.from;
	for (let i = range.from - 1; i >= fmEnd; i--) {
		const cur = lines[i];
		if (isBlank(cur)) {
			// a blank stays inside only between a sibling's deeper children
			const prev = lines[i - 1];
			if (prev !== undefined && !isBlank(prev) && indentOf(prev) > indent) continue;
			break;
		}
		const m = listMatch(cur);
		if (m && m[1].length === indent) {
			from = i;
			continue;
		}
		if (indentOf(cur) > indent) continue; // deeper lines belong to a sibling above
		break;
	}
	let to = range.to;
	for (let i = range.to + 1; i < lines.length; i++) {
		const cur = lines[i];
		if (isBlank(cur)) {
			// mirror blockRangeAt: a blank stays inside only when deeper content follows
			const next = lines[i + 1];
			if (next !== undefined && !isBlank(next) && indentOf(next) > indent) continue;
			break;
		}
		const m = listMatch(cur);
		if ((m && m[1].length === indent) || indentOf(cur) > indent) {
			to = i;
			continue;
		}
		break;
	}
	return { from, to };
}

function stripLinePrefixes(l: string): string {
	let t = l;
	for (let i = 0; i < 6; i++) {
		const before = t;
		t = t
			.replace(/^\s*>\s?/, "")
			.replace(/^\s*\[!\w+\][+-]?\s*/, "")
			.replace(/^\s*(?:[-*+]|\d+[.)])\s+\[.\]\s+/, "")
			.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "")
			.replace(/^#{1,6}\s+/, "");
		if (t === before) break;
	}
	return t;
}

/** Which callout to become: type ("note", "tip", "warning"…) and whether it
 *  starts folded, a folded callout is a Notion-style toggle block, so the
 *  block's first line becomes its always-visible title. */
export interface CalloutSpec {
	type: string;
	folded?: boolean;
	/** Notion-style leading emoji, written into the title text. */
	emoji?: string;
}

/** A callout flavor as the pickers present it: the Obsidian type, its menu
 *  label and Lucide icon, and the Notion-style emoji written into the title.
 *  Tip leads because it is the one people reach for most; styles.css pins the
 *  matching icon on the rendered callout so a hand-typed header looks the same. */
export interface CalloutFlavor {
	type: string;
	label: string;
	icon: string;
	emoji: string;
}

export const CALLOUT_FLAVORS: CalloutFlavor[] = [
	{ type: "tip", label: "Tip", icon: "lightbulb", emoji: "💡" },
	{ type: "note", label: "Note", icon: "pencil", emoji: "📝" },
	{ type: "info", label: "Info", icon: "info", emoji: "ℹ️" },
	{ type: "success", label: "Success", icon: "check", emoji: "✅" },
	{ type: "question", label: "Question", icon: "help-circle", emoji: "❓" },
	{ type: "warning", label: "Warning", icon: "alert-triangle", emoji: "⚠️" },
	{ type: "danger", label: "Danger", icon: "zap", emoji: "🚨" },
	{ type: "example", label: "Example", icon: "list", emoji: "🧪" },
	{ type: "quote", label: "Quote", icon: "quote", emoji: "💬" },
];

/** Lead-in labels people hand-type ahead of the sentence, "Tip:", "**Note:**".
 *  Turning such a line into that same callout drops the label, because the
 *  callout's own icon, color, and title already say it. Aliases are listed per
 *  type so "Caution:" reads as a warning and "Hint:" as a tip.
 *
 *  "Important:" goes to warning, not tip. Obsidian aliases the [!important]
 *  TYPE onto tip, but someone who writes "IMPORTANT:" ahead of a sentence is
 *  flagging a thing that bites, not offering a shortcut. */
const CALLOUT_LEADS: Record<string, string[]> = {
	tip: ["tip", "pro tip", "hint"],
	note: ["note", "nb"],
	info: ["info", "fyi"],
	success: ["success", "done", "check"],
	question: ["question", "faq", "q"],
	warning: ["warning", "caution", "careful", "heads up", "important"],
	danger: ["danger", "error", "stop"],
	example: ["example", "for example", "e.g."],
	quote: ["quote"],
};

/** Matches a "Label:" lead-in, with or without bold/italic around it, in either
 *  `**Tip:**` or `**Tip**:` placement. Group 2 is the bare label. */
const CALLOUT_LEAD_RE = /^\s*(\*\*|__|\*|_)?\s*([A-Za-z][A-Za-z. ]{0,15}?)\s*(?::\s*\1|\1\s*:)\s+/;

/** Drop a lead-in label from `text` when it names the callout type it is
 *  becoming. Anything else, a different label, or a line that is only the
 *  label, comes back untouched. */
export function stripCalloutLead(text: string, type: string): string {
	const leads = CALLOUT_LEADS[type];
	if (!leads) return text;
	const m = CALLOUT_LEAD_RE.exec(text);
	if (!m) return text;
	if (!leads.includes(m[2].trim().toLowerCase())) return text;
	const rest = text.slice(m[0].length);
	return rest.trim() ? rest : text;
}

/* ---------- converting notes written before callouts ---------- */

/** label → type, so a line can be read back to the flavor it meant. */
const LEAD_TO_TYPE = new Map<string, string>(
	Object.entries(CALLOUT_LEADS).flatMap(([type, leads]) => leads.map((l): [string, string] => [l, type]))
);

const EMOJI_FOR_TYPE = new Map(CALLOUT_FLAVORS.map((f): [string, string] => [f.type, f.emoji]));

/** A lead-in at the head of a line: g1 indent, g2 the `>` of a quote, g3 the
 *  emphasis around the label, g4 the label itself. The colon may sit inside
 *  the emphasis (`**Tip:**`) or outside it (`**Tip**:`), and text must follow. */
const LEAD_LINE_RE = /^([ \t]*)(>[ \t]*)?(\*\*|__|\*|_)?[ \t]*([A-Za-z][A-Za-z. ]{0,15}?)[ \t]*(?::[ \t]*\3|\3[ \t]*:)[ \t]+(?=\S)/;

/** A line that ends the paragraph a plain lead-in belongs to: anything with
 *  structure of its own, which must not be swallowed into the callout body. */
const PARA_BREAK = /^\s*(?:$|#{1,6}\s|>|```|~~~|---|\*\*\*|___|\||(?:[-*+]|\d+[.)])\s)/;

export interface CalloutLead {
	/** 0-based line the lead-in sits on. */
	line: number;
	/** the callout type it will become. */
	type: string;
	/** the label as written, for the preview. */
	label: string;
	/** true when the label carried no bold/italic, the riskier form, since
	 *  plain prose can open with a word and a colon. */
	bare: boolean;
}

/** Every "Tip:"-style lead-in in a note that could become a real callout.
 *  Code fences, frontmatter, list items, and lines already inside a callout
 *  are skipped, so a scan never proposes rewriting something structural. */
export function findCalloutLeads(lines: string[]): CalloutLead[] {
	const out: CalloutLead[] = [];
	let fence: string | null = null;
	// frontmatter is data, never prose
	for (let i = frontmatterEnd(lines); i < lines.length; i++) {
		const text = lines[i];
		const f = /^\s*(```|~~~)/.exec(text);
		if (f) {
			if (!fence) fence = f[1];
			else if (text.trim().startsWith(fence)) fence = null;
			continue;
		}
		if (fence) continue;
		const m = LEAD_LINE_RE.exec(text);
		if (!m) continue;
		const type = LEAD_TO_TYPE.get(m[4].trim().toLowerCase());
		if (!type) continue;
		// a quote that is already a callout keeps what it has
		if (m[2] && /^\s*>\s*\[!/.test(lines[quoteBlockStart(lines, i)])) continue;
		out.push({ line: i, type, label: m[4].trim(), bare: !m[3] });
	}
	return out;
}

/** The first line of the run of quote lines containing `line`. */
function quoteBlockStart(lines: string[], line: number): number {
	let i = line;
	while (i > 0 && /^\s*>/.test(lines[i - 1])) i--;
	return i;
}

/** Rewrite the given lead-ins as callouts. A quoted lead-in keeps its
 *  blockquote and only gains the `[!type]` header; a plain paragraph is pulled
 *  into one, body lines and all. Lines are edited from the bottom up so
 *  earlier positions stay valid. */
export function convertCalloutLeads(lines: string[], leads: CalloutLead[]): string[] {
	const out = [...lines];
	for (const lead of [...leads].sort((a, b) => b.line - a.line)) {
		const text = out[lead.line];
		const m = LEAD_LINE_RE.exec(text);
		if (!m) continue;
		const indent = m[1];
		const rest = text.slice(m[0].length);
		if (!rest.trim()) continue;
		const emoji = EMOJI_FOR_TYPE.get(lead.type);
		const header = `${indent}> [!${lead.type}]${emoji ? " " + emoji : ""} ${rest}`;
		if (m[2]) {
			// already a blockquote: only the first line changes
			out[lead.line] = header;
			continue;
		}
		// a bare paragraph: the header plus every line of the same paragraph
		let end = lead.line;
		while (end + 1 < out.length && !PARA_BREAK.test(out[end + 1])) end++;
		const body = out.slice(lead.line + 1, end + 1).map((l) => `${indent}> ${l.trim()}`);
		out.splice(lead.line, end - lead.line + 1, header, ...body);
	}
	return out;
}

/** Rewrite a block as another kind, stripping its old structural markers. */
export function transformBlock(lines: string[], range: BlockRange, kind: BlockKind, callout?: CalloutSpec): string[] {
	const kept = lines
		.slice(range.from, range.to + 1)
		.map((raw) => ({ raw, core: stripLinePrefixes(raw) }))
		.filter((p, i, a) => p.core.trim() !== "" || (i > 0 && i < a.length - 1));
	const core = kept.map((p) => p.core);
	const raw = kept.map((p) => p.raw);
	// the block's own indent, a nested list converts in place, not at column 0
	const base = raw[0]?.match(/^\s*/)?.[0] ?? "";
	let out: string[];
	switch (kind) {
		case "paragraph":
			out = core;
			break;
		case "h1":
		case "h2":
		case "h3": {
			const n = Number(kind[1]);
			out = core.map((l) => (l.trim() ? "#".repeat(n) + " " + l.trim() : l));
			break;
		}
		case "bullet":
			out = core.map((l) => (l.trim() ? "- " + l.trim() : l));
			break;
		case "ordered": {
			let i = 0;
			out = core.map((l) => (l.trim() ? `${++i}. ` + l.trim() : l));
			break;
		}
		case "task":
			out = core.map((l) => (l.trim() ? "- [ ] " + l.trim() : l));
			break;
		case "quote":
			out = core.map((l) => "> " + l);
			break;
		case "toggleList": {
			// Notion's toggle list: a bullet whose indented children fold under
			// it natively. A short first line rides the bullet as the title
			// even alone, matching Notion's empty toggle, while a blob leaves
			// the bullet empty to type into. Body list items keep their own
			// markers: former siblings shift one level deeper, and anything
			// already indented under the first line is a child that stays put.
			const first = core[0]?.trim() ?? "";
			const titled = first.length > 0 && first.length <= 100;
			const bodyRaw = titled ? raw.slice(1) : raw;
			const bodyCore = titled ? core.slice(1) : core;
			let sibling = false;
			const body = bodyRaw.map((l, i) => {
				if (!l.trim()) return l;
				if (indentOf(l) <= base.length) sibling = true;
				if (!sibling) return l;
				return listMatch(l) ? "    " + l : base + "    " + bodyCore[i].trim();
			});
			out = [base + "- " + (titled ? first : ""), ...body];
			break;
		}
		case "callout": {
			const c = callout ?? { type: "note" };
			// "Tip: do the thing" becoming a tip callout says "tip" twice; the
			// label goes, the sentence stays.
			if (core.length) core[0] = stripCalloutLead(core[0], c.type);
			// The first line becomes the toggle's title only when it reads like
			// one: a short line. A one-line blob (a pasted transcript) must fold
			// as BODY under an empty title, otherwise the whole thing lands in
			// the always-visible bold title and there is nothing left to collapse.
			const em = c.emoji ? c.emoji + " " : "";
			const title = core[0]?.trim() ?? "";
			const firstAsTitle = !!c.folded && title.length > 0 && title.length <= 100;
			// Body list items keep their markers and nesting, rebased into the
			// callout; a former child of the title line rises one level, since
			// its parent became the header. Other lines strip as before.
			let sibling = false;
			const bodyLine = (l: string, coreL: string): string => {
				if (!l.trim()) return coreL;
				if (indentOf(l) <= base.length) sibling = true;
				if (!listMatch(l)) return coreL;
				let t = l.startsWith(base) ? l.slice(base.length) : l.replace(/^\s*/, "");
				if (!sibling) t = t.replace(/^(?: {1,4}|\t)/, "");
				return t;
			};
			if (firstAsTitle) {
				out = [`${base}> [!${c.type}]- ${em}${title}`, ...raw.slice(1).map((l, i) => `${base}> ` + bodyLine(l, core[i + 1]))];
			} else if (!c.folded && em && core.length === 1 && title) {
				// Notion single-line callout: emoji + the text, one row
				out = [`${base}> [!${c.type}] ${em}${title}`];
			} else {
				out = [`${base}> [!${c.type}]${c.folded ? "-" : ""}${em ? " " + em.trim() : ""}`, ...raw.map((l, i) => `${base}> ` + bodyLine(l, core[i]))];
			}
			break;
		}
	}
	return [...lines.slice(0, range.from), ...out, ...lines.slice(range.to + 1)];
}

export interface TabPane {
	title: string;
	body: string;
}

/** Split a `tabs` code block into panes on `--- Title` lines; content before
 *  the first marker becomes "Tab 1". */
export function parseTabs(source: string): TabPane[] {
	const panes: TabPane[] = [];
	let cur: TabPane | null = null;
	const pre: string[] = [];
	for (const l of source.split("\n")) {
		const m = /^---\s+(.+?)\s*$/.exec(l);
		if (m) {
			if (cur) panes.push(cur);
			else if (pre.join("").trim()) panes.push({ title: "Tab 1", body: pre.join("\n").trim() });
			cur = { title: m[1], body: "" };
		} else if (cur) {
			cur.body += (cur.body ? "\n" : "") + l;
		} else {
			pre.push(l);
		}
	}
	if (cur) panes.push(cur);
	if (!panes.length && pre.join("").trim()) panes.push({ title: "Tab 1", body: pre.join("\n").trim() });
	return panes.map((p) => ({ title: p.title, body: p.body.trim() }));
}

/** Serialize panes back into a `tabs` block body (inverse of parseTabs, so
 *  editing a pane can be written straight back to the source). */
export function serializeTabs(panes: TabPane[]): string {
	return panes.map((p) => `--- ${p.title}` + (p.body.trim() ? "\n" + p.body.trim() : "")).join("\n");
}

export interface ColumnPane {
	ratio: number;
	body: string;
}

/** Split a `columns` code block on bare `---` lines (optionally `--- 2` for a
 *  flex ratio); content before the first marker is the first column. Once any
 *  marker is present, an empty column (even the first) is kept, so live editing
 *  can round-trip a column you have not typed into yet. */
export function parseColumns(source: string): ColumnPane[] {
	const panes: ColumnPane[] = [];
	let cur: ColumnPane = { ratio: 1, body: "" };
	let sawMarker = false;
	for (const l of source.split("\n")) {
		const m = /^---(?:\s+(\d+(?:\.\d+)?))?\s*$/.exec(l);
		if (m) {
			panes.push({ ratio: cur.ratio, body: cur.body.trim() });
			cur = { ratio: m[1] ? Number(m[1]) : 1, body: "" };
			sawMarker = true;
		} else {
			cur.body += (cur.body ? "\n" : "") + l;
		}
	}
	if (sawMarker || cur.body.trim()) panes.push({ ratio: cur.ratio, body: cur.body.trim() });
	return panes;
}

/** Serialize columns back into a `columns` block body (inverse of parseColumns).
 *  Ratios are normalized to the first column, which carries no marker, so any
 *  column can be resized even though the format anchors on column one. */
export function serializeColumns(panes: ColumnPane[]): string {
	if (!panes.length) return "";
	const r0 = panes[0].ratio || 1;
	const out: string[] = [panes[0].body.trim()];
	for (let i = 1; i < panes.length; i++) {
		const n = Math.round((panes[i].ratio / r0) * 100) / 100;
		out.push(n === 1 ? "---" : `--- ${n}`);
		out.push(panes[i].body.trim());
	}
	return out.join("\n");
}

export type ColumnLayout = "two" | "three" | "sidebar-left" | "sidebar-right";

/** A ready-made `columns` block for a chosen layout, so multi-column pages are
 *  one click instead of hand-writing the fence and its `---` separators. */
export function columnsSnippet(layout: ColumnLayout): string {
	const body = {
		two: "Left column\n---\nRight column",
		three: "First column\n---\nSecond column\n---\nThird column",
		"sidebar-left": "Sidebar\n--- 2\nMain content",
		"sidebar-right": "Main content\n--- 0.5\nSidebar",
	}[layout];
	return "```columns\n" + body + "\n```";
}

/** Swap (or add) the Notion-style leading emoji on a callout header line. */
export function setCalloutEmoji(line: string, emoji: string): string | null {
	const m = /^(\s*>\s*\[!\w+\][+-]?\s*)((?:\p{Extended_Pictographic}|\p{Emoji_Presentation})️?\s*)?/u.exec(line);
	if (!m) return null;
	return m[1] + emoji + " " + line.slice(m[0].length);
}

/** A blank cols × rows Markdown table (the first row is the header). */
export function tableSnippet(cols: number, rows: number): string {
	const c = Math.max(1, cols);
	const row = "|" + "     |".repeat(c);
	const sep = "|" + " --- |".repeat(c);
	return [row, sep, ...Array.from({ length: Math.max(0, rows - 1) }, () => row)].join("\n");
}

/** A copy of the block right after itself (list items glue; prose gets a gap). */
export function duplicateBlock(lines: string[], range: BlockRange): { lines: string[]; newStart: number } {
	const block = lines.slice(range.from, range.to + 1);
	const insertAt = range.to + 1;
	const sep = listMatch(block[0]) ? [] : [""];
	return {
		lines: [...lines.slice(0, insertAt), ...sep, ...block, ...lines.slice(insertAt)],
		newStart: insertAt + sep.length,
	};
}

export function deleteBlock(lines: string[], range: BlockRange): string[] {
	let toEx = range.to + 1;
	while (toEx < lines.length && isBlank(lines[toEx])) toEx++;
	let from = range.from;
	if (toEx === lines.length) while (from > 0 && isBlank(lines[from - 1])) from--;
	return [...lines.slice(0, from), ...lines.slice(toEx)];
}

/** The block's ^id for linking, creating one if needed. Tables and fences take
 *  the id on their own following line, everything else appends to the last line. */
export function ensureBlockId(
	lines: string[],
	range: BlockRange,
	fresh: string
): { lines: string[]; id: string; changed: boolean } {
	const afterLine = lines[range.to + 1] ?? "";
	const own = lines[range.to].match(/\^([A-Za-z0-9-]+)\s*$/);
	if (own) return { lines, id: own[1], changed: false };
	const following = afterLine.match(/^\s*\^([A-Za-z0-9-]+)\s*$/);
	if (following) return { lines, id: following[1], changed: false };
	const structural = isTableLine(lines[range.to]) || isFenceMark(lines[range.to]) || isQuoteLine(lines[range.to]);
	if (structural) {
		return {
			lines: [...lines.slice(0, range.to + 1), `^${fresh}`, ...lines.slice(range.to + 1)],
			id: fresh,
			changed: true,
		};
	}
	const out = [...lines];
	out[range.to] = out[range.to] + ` ^${fresh}`;
	return { lines: out, id: fresh, changed: true };
}

/** Move a block so it starts at the boundary `insertBefore` (a block start
 *  from blockStarts, or lines.length for the end). Returns the new document
 *  lines and where the block landed, or null for a no-op. Spacing rule: a
 *  blank line separates the block from non-list neighbors; list items dropped
 *  against other list lines glue directly so lists stay lists. */
export function moveBlock(
	lines: string[],
	range: BlockRange,
	insertBefore: number
): { lines: string[]; newStart: number } | null {
	if (insertBefore >= range.from && insertBefore <= range.to + 1) return null;
	const block = lines.slice(range.from, range.to + 1);
	// swallow the blank run after the block (or before, at the end of the doc)
	let removeFrom = range.from;
	let removeToEx = range.to + 1;
	while (removeToEx < lines.length && isBlank(lines[removeToEx])) removeToEx++;
	if (removeToEx === lines.length) {
		while (removeFrom > 0 && isBlank(lines[removeFrom - 1])) removeFrom--;
	}
	const rest = [...lines.slice(0, removeFrom), ...lines.slice(removeToEx)];
	let at = insertBefore - (removeToEx <= insertBefore ? removeToEx - removeFrom : 0);
	if (at < 0) at = 0;
	if (at > rest.length) at = rest.length;
	const blockIsList = listMatch(block[0]) != null;
	const above = at > 0 ? rest[at - 1] : undefined;
	const below = at < rest.length ? rest[at] : undefined;
	const glueTop = blockIsList && isListy(above);
	const glueBottom = blockIsList && isListy(below);
	const gapTop = above !== undefined && !isBlank(above) && !glueTop;
	const gapBottom = below !== undefined && !isBlank(below) && !glueBottom;
	const insert = [...(gapTop ? [""] : []), ...block, ...(gapBottom ? [""] : [])];
	const out = [...rest.slice(0, at), ...insert, ...rest.slice(at)];
	return { lines: out, newStart: at + (gapTop ? 1 : 0) };
}

/** A cheap read of what a fenced block probably is, from its opening lines.
 *  Only used to float the likely answer to the top of the picker, nothing is
 *  written without a choice. */
export function guessLanguage(lines: string[]): string | null {
	const head = lines.join("\n");
	const shebang = /^#!.*\b(bash|sh|zsh)\b/m.test(head) ? "bash" : /^#!.*\bpython/m.test(head) ? "python" : null;
	if (shebang) return shebang;
	if (/^\s*(defaults write|brew |sudo |chmod |echo "|export |killall )/m.test(head)) return "bash";
	if (/^\s*(Get-|Set-|New-|\$PSVersionTable)/m.test(head)) return "powershell";
	if (/^\s*(SELECT|INSERT INTO|UPDATE |CREATE TABLE)\b/im.test(head)) return "sql";
	if (/^\s*[{[]/.test(head.trim()) && /["']\s*:/.test(head)) return "json";
	if (/^\s*(import |export |const |let |function |=>)/m.test(head)) return "javascript";
	if (/^\s*(def |class |import |from .* import)/m.test(head)) return "python";
	if (/^\s*<[a-zA-Z!]/.test(head.trim())) return "html";
	return null;
}

/** The smallest line range that actually differs between two versions of a
 *  document, as a replacement for `from`..`to` (inclusive) with `text`.
 *
 *  Block operations rebuild the note as an array of lines, and writing that
 *  whole array back is one transaction spanning the entire document. Every
 *  fold, and anything else anchored to a position, dies with it, collapse a
 *  dozen headings, delete one block, and all twelve spring open. Narrowing
 *  the edit to the lines that changed leaves every position outside it alone.
 *
 *  `from > to` with empty `text` means the two versions are identical. */
export function narrowEdit(prev: string[], next: string[]): { from: number; to: number; text: string[] } {
	let start = 0;
	const min = Math.min(prev.length, next.length);
	while (start < min && prev[start] === next[start]) start++;
	let endPrev = prev.length - 1;
	let endNext = next.length - 1;
	while (endPrev >= start && endNext >= start && prev[endPrev] === next[endNext]) {
		endPrev--;
		endNext--;
	}
	return { from: start, to: endPrev, text: next.slice(start, endNext + 1) };
}

/** A fenced block's info string: the language, and an optional filename shown
 *  in the block's header the way Claude and GitHub label a file.
 *
 *  Three spellings are accepted because there is no standard and people have
 *  muscle memory for different ones:
 *      ```bash mac-bootstrap.sh
 *      ```bash:mac-bootstrap.sh
 *      ```bash title="mac-bootstrap.sh"
 *  All three round-trip through `formatFenceInfo`, which writes the first. */
export function parseFenceInfo(info: string): { lang: string; file: string } {
	const t = info.trim();
	if (!t) return { lang: "", file: "" };
	const titled = /^([A-Za-z0-9+#_-]*)\s+title\s*=\s*["']([^"']+)["']\s*$/.exec(t);
	if (titled) return { lang: titled[1].toLowerCase(), file: titled[2].trim() };
	const colon = /^([A-Za-z0-9+#_-]*):(.+)$/.exec(t);
	if (colon) return { lang: colon[1].toLowerCase(), file: colon[2].trim() };
	const spaced = /^([A-Za-z0-9+#_-]*)\s+(.+)$/.exec(t);
	if (spaced) return { lang: spaced[1].toLowerCase(), file: spaced[2].trim() };
	return { lang: t.toLowerCase(), file: "" };
}

/** The info string to write back for a language and filename. */
export function formatFenceInfo(lang: string, file: string): string {
	const f = file.trim();
	if (!f) return lang;
	return lang ? `${lang} ${f}` : f;
}

/** An item's text with inline HTML tags removed, for deciding whether it is
 *  really empty. A line that is nothing but a hidden `<mark></mark>` pair looks
 *  blank on screen and should behave like a blank item. */
export function stripTags(s: string): string {
	return s.replace(/<[^>]*>/g, "").trim();
}

/** Insert an empty item directly above the one on `line`, renumbering the run
 *  it belongs to.
 *
 *  Pressing Enter at the visual start of an item normally splits it, and in
 *  WYSIWYG mode "the visual start" sits inside hidden inline HTML, a `<mark>`
 *  from the highlighter, a `<strong>` from bold. Worse, clicking there yields a
 *  selection covering that hidden tag rather than a cursor, so Enter replaces
 *  it and takes the item's content with it. What people mean by that keystroke
 *  is "give me a new item above this one", so that is what this does, leaving
 *  the existing line untouched.
 *
 *  Only the contiguous run at the same indent is renumbered, so a nested list
 *  or a separate list further down keeps its own numbering. */
export function insertItemAbove(lines: string[], line: number): { lines: string[]; caret: number } | null {
	const m = /^(\s*)((?:[-*+])|(\d+)([.)]))\s+/.exec(lines[line] ?? "");
	if (!m) return null;
	const indent = m[1];
	const ordered = m[3] !== undefined;
	const blank = ordered ? `${indent}${m[3]}${m[4]} ` : `${indent}${m[2]} `;
	const out = [...lines.slice(0, line), blank, ...lines.slice(line)];
	if (!ordered) return { lines: out, caret: line };
	const sameRun = (s: string | undefined) => {
		if (s === undefined) return null;
		const mm = /^(\s*)(\d+)([.)])\s+/.exec(s);
		return mm && mm[1] === indent ? mm : null;
	};
	let first = line;
	while (first > 0 && sameRun(out[first - 1])) first--;
	let last = line;
	while (last + 1 < out.length && sameRun(out[last + 1])) last++;
	const start = Number(sameRun(out[first])?.[2] ?? "1");
	for (let i = first, n = start; i <= last; i++, n++) {
		out[i] = out[i].replace(/^(\s*)(\d+)([.)])/, `$1${n}$3`);
	}
	return { lines: out, caret: line };
}
