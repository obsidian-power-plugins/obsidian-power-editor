/* Pure formatting helpers behind the toolbar: heading levels, list detection
 * for active states, and clear-formatting. Covered by tests.ts. */

export function headingLevel(line: string): number {
	const m = line.match(/^(#{1,6})\s/);
	return m ? m[1].length : 0;
}

/** Set (1-6) or remove (0) the heading level of one line, leaving any list or
 *  quote markers alone, headings inside quotes keep their "> " prefix. */
export function setHeading(line: string, level: number): string {
	const m = line.match(/^(\s*(?:>\s*)?)(#{1,6}\s+)?(.*)$/) as RegExpMatchArray;
	const prefix = m[1];
	const rest = m[3];
	return level ? `${prefix}${"#".repeat(level)} ${rest}` : `${prefix}${rest}`;
}

/** The Notion-style placeholder for an empty heading line ("Heading 1"…), or
 *  null when the line has text or isn't a heading. With the hash characters
 *  hidden in WYSIWYG mode an empty heading looks blank; this labels it. */
export function emptyHeadingLabel(line: string): string | null {
	const m = line.match(/^\s*(?:>\s*)?(#{1,6})\s*$/);
	return m ? `Heading ${m[1].length}` : null;
}

/** Where the caret should snap to when it lands before a heading's marker,
 *  or null to leave it. WYSIWYG hides the "# ", so without this a click at
 *  the line's visual start puts the caret at offset 0, and typing there
 *  produces "text# " instead of a heading. Notion makes the marker
 *  unreachable; this does the same. */
export function headingCursorSnap(lineText: string, offsetInLine: number): number | null {
	const m = lineText.match(/^(#{1,6}\s)/);
	if (!m) return null;
	const markerLen = m[1].length;
	return offsetInLine < markerLen && lineText.length >= markerLen ? markerLen : null;
}

const BLOCK_PREFIX = /^(\s*(?:>\s*)?(?:#{1,6}\s+|(?:[-*+]|\d+[.)])\s+(?:\[.\]\s+)?)?)([\s\S]*)$/;

/** Color a whole block line the Notion way: wrap its text in a color span
 *  (mode "text") or a highlight mark (mode "hl"), leaving the structural
 *  prefix (#, -, 1., >, checkbox) untouched. A null hex clears the existing
 *  wrapper; an empty body is returned unchanged (nothing to color). */
export function colorBlockLine(line: string, mode: "text" | "hl", hex: string | null): string {
	const m = line.match(BLOCK_PREFIX) as RegExpMatchArray;
	const prefix = m[1];
	let body = m[2];
	if (!body.trim()) return line;
	if (mode === "text") {
		body = body.replace(/<span style="color:[^"]*">([\s\S]*?)<\/span>/gi, "$1");
		return prefix + (hex ? `<span style="color:${hex}">${body}</span>` : body);
	}
	body = body.replace(/<mark[^>]*>([\s\S]*?)<\/mark>/gi, "$1").replace(/==([\s\S]+?)==/g, "$1");
	return prefix + (hex ? `<mark style="background:${hex}">${body}</mark>` : body);
}

/* ---------------- ordered-list outline numbering (Word-style) ---------------- */

function toAlpha(n: number): string {
	let s = "";
	while (n > 0) {
		n--;
		s = String.fromCharCode(97 + (n % 26)) + s;
		n = Math.floor(n / 26);
	}
	return s;
}

function toRoman(n: number): string {
	const map: [number, string][] = [
		[1000, "m"], [900, "cm"], [500, "d"], [400, "cd"], [100, "c"], [90, "xc"],
		[50, "l"], [40, "xl"], [10, "x"], [9, "ix"], [5, "v"], [4, "iv"], [1, "i"],
	];
	let s = "";
	for (const [v, r] of map) while (n >= v) { s += r; n -= v; }
	return s;
}

/** Render a 1-based counter in a list-style: decimal, lower/upper alpha
 *  (a…z, aa…), or lower/upper roman. Names match CSS list-style-type so the
 *  reading view (real <ol>) and the editor share one config. */
export function formatCounter(n: number, style: string): string {
	if (!Number.isFinite(n) || n < 1) return String(n);
	switch (style) {
		case "lower-alpha":
			return toAlpha(n);
		case "upper-alpha":
			return toAlpha(n).toUpperCase();
		case "lower-roman":
			return toRoman(n);
		case "upper-roman":
			return toRoman(n).toUpperCase();
		default:
			return String(n);
	}
}

export interface OrderedInfo {
	indent: string;
	/** Nesting level: 0 at the margin, +1 per tab (or 4 spaces). */
	depth: number;
	ordinal: number;
	/** Character range of the digits, so the editor can restyle just them. */
	numStart: number;
	numEnd: number;
	delim: string;
}

/** What pressing Enter at the end of `line` should do inside a plain-text list
 *  editor (the tab edit box): continue the list with the next marker, or, on
 *  an empty item, end it by clearing the marker back to its indent. Null when
 *  the line isn't a list item. */
export function continueList(line: string): { insert: string } | { clear: string } | null {
	const om = line.match(/^(\s*)(\d+)([.)])[ \t]+(.*)$/);
	if (om) return om[4].trim() ? { insert: `\n${om[1]}${Number(om[2]) + 1}${om[3]} ` } : { clear: om[1] };
	const um = line.match(/^(\s*)([-*+])[ \t]+(.*)$/);
	if (um) return um[3].trim() ? { insert: `\n${um[1]}${um[2]} ` } : { clear: um[1] };
	return null;
}

/** Parse an ordered-list line ("  2) text"), or null when it isn't one. */
export function orderedListInfo(line: string): OrderedInfo | null {
	const m = line.match(/^(\s*)(\d+)([.)])\s/);
	if (!m) return null;
	const indent = m[1];
	const tabs = (indent.match(/\t/g) || []).length;
	const spaces = indent.length - tabs;
	return {
		indent,
		depth: tabs + Math.floor(spaces / 4),
		ordinal: Number(m[2]),
		numStart: indent.length,
		numEnd: indent.length + m[2].length,
		delim: m[3],
	};
}

/** The link containing ch on this line, so the Link dialog can edit in place. */
export interface LinkInfo {
	start: number;
	end: number;
	text: string;
	url: string;
	wiki: boolean;
}

export function linkAt(line: string, ch: number): LinkInfo | null {
	const wiki = /\[\[([^\]|]+)(?:\|([^\]]*))?\]\]/g;
	let m: RegExpExecArray | null;
	while ((m = wiki.exec(line))) {
		if (ch >= m.index && ch <= m.index + m[0].length)
			return { start: m.index, end: m.index + m[0].length, text: m[2] ?? m[1], url: m[1], wiki: true };
	}
	// group 1 stands in for a lookbehind on "[", so it is skipped when the
	// match is measured
	const md = /(^|[^[])\[([^\]]*)\]\(([^)]*)\)/g;
	while ((m = md.exec(line))) {
		const start = m.index + m[1].length;
		const end = m.index + m[0].length;
		if (ch >= start && ch <= end) return { start, end, text: m[2], url: m[3], wiki: false };
	}
	// bare URLs count too (pasted links have no [text](…) wrapper); trailing
	// sentence punctuation stays outside, and <angle autolinks> swallow their
	// brackets so an edit replaces the whole autolink
	const bare = /https?:\/\/[^\s<>]+/g;
	while ((m = bare.exec(line))) {
		const url = m[0].replace(/[)\]}>.,;:!?"']+$/, "");
		let start = m.index;
		let end = m.index + url.length;
		if (line[start - 1] === "<" && line[end] === ">") {
			start--;
			end++;
		}
		if (ch >= start && ch <= end) return { start, end, text: "", url, wiki: false };
	}
	return null;
}

export type Align = "left" | "center" | "right";

/** The line's alignment marker, if any. Left means "no marker". */
export function alignOf(line: string): Align {
	const m = line.match(/<!--al:(center|right)-->/);
	return m ? (m[1] as Align) : "left";
}

/** Set or clear the line's alignment marker (a hidden HTML comment that both
 *  Live Preview and Reading view translate into text-align). */
export function setAlign(line: string, align: Align): string {
	const stripped = line.replace(/\s*<!--al:(?:center|right)-->/g, "");
	return align === "left" ? stripped : `${stripped}<!--al:${align}-->`;
}

export type ListKind = "bullet" | "ordered" | "task" | null;

export function listKind(line: string): ListKind {
	if (/^\s*(?:[-*+])\s+\[.\]\s/.test(line)) return "task";
	if (/^\s*[-*+]\s/.test(line)) return "bullet";
	if (/^\s*\d+[.)]\s/.test(line)) return "ordered";
	return null;
}

export function isQuote(line: string): boolean {
	return /^\s*>/.test(line);
}

/** The format painter's palette: which inline styles a selection carries. */
export interface Marks {
	bold: boolean;
	italic: boolean;
	underline: boolean;
	strike: boolean;
	highlight: boolean;
	color: string | null;
}

export function detectMarks(text: string): Marks {
	return {
		bold: /\*\*[^*]/.test(text) || /<(?:b|strong)[\s>]/i.test(text),
		italic: /(^|[^*])\*[^*\n]+\*(?!\*)/.test(text) || /<(?:i|em)[\s>]/i.test(text),
		underline: /<u[\s>]/i.test(text),
		strike: /~~[^~]/.test(text) || /<s[\s>]/i.test(text),
		highlight: /==[^=]/.test(text) || /<mark[\s>]/i.test(text),
		color: text.match(/<span style="color:\s*([^";]+)/i)?.[1]?.trim() ?? null,
	};
}

export function hasAnyMark(m: Marks): boolean {
	return m.bold || m.italic || m.underline || m.strike || m.highlight || m.color != null;
}

/** Which HTML wrappers enclose the ch-range on this line, needed because a
 *  WYSIWYG selection contains only the inner text, never the tags around it. */
export function wrapperAt(line: string, chFrom: number, chTo: number): { underline: boolean; color: string | null; highlighted: boolean } {
	const encloses = (re: RegExp): RegExpExecArray | null => {
		re.lastIndex = 0;
		let m: RegExpExecArray | null;
		while ((m = re.exec(line))) {
			if (m.index <= chFrom && m.index + m[0].length >= chTo) return m;
			if (m.index >= chTo) break;
		}
		return null;
	};
	const span = encloses(/<span style="color:\s*([^";]+)[^"]*">[\s\S]*?<\/span>/gi);
	return {
		underline: encloses(/<u>[\s\S]*?<\/u>/gi) != null,
		color: span ? span[1].trim() : null,
		highlighted: encloses(/<mark[^>]*>[\s\S]*?<\/mark>/gi) != null,
	};
}

/** Repaint text with a captured set of marks: existing styling is stripped
 *  first so painting is idempotent. */
export function applyMarks(text: string, m: Marks): string {
	let t = stripFormatting(text);
	if (m.bold) t = `**${t}**`;
	if (m.italic) t = `*${t}*`;
	if (m.strike) t = `~~${t}~~`;
	if (m.highlight) t = `==${t}==`;
	if (m.underline) t = `<u>${t}</u>`;
	if (m.color) t = `<span style="color:${m.color}">${t}</span>`;
	return t;
}

/** The font-size menu: label → em value (null = back to normal). */
export const FONT_SIZES: [string, string | null][] = [
	["Small", "0.85em"],
	["Normal", null],
	["Large", "1.25em"],
	["Huge", "1.6em"],
];

/** Wrap a selection in a font-size span, replacing any outer size wrapper so
 *  re-sizing never nests. Null removes the wrapper. */
export function setFontSize(text: string, em: string | null): string {
	let t = text;
	const m = t.match(/^<span style="font-size:[^"]*">([\s\S]*)<\/span>$/i);
	if (m) t = m[1];
	return em ? `<span style="font-size:${em}">${t}</span>` : t;
}

/** Toggle subscript/superscript on a selection; the two are exclusive. */
export function toggleScript(text: string, tag: "sub" | "sup"): string {
	const self = new RegExp(`^<${tag}>([\\s\\S]*)</${tag}>$`, "i");
	const m = text.match(self);
	if (m) return m[1];
	const other = tag === "sub" ? "sup" : "sub";
	const stripped = text.replace(new RegExp(`^<${other}>([\\s\\S]*)</${other}>$`, "i"), "$1");
	return `<${tag}>${stripped}</${tag}>`;
}

/** The Clear-formatting button: a whole line back to plain text, heading
 *  gone, alignment gone, inline marks and HTML gone. Structure survives:
 *  list markers, quotes, and links keep working. */
export function clearAllFormatting(line: string): string {
	return stripFormatting(setAlign(setHeading(line, 0), "left"));
}

/** Expand a [from,to] character range on one line so it swallows any style
 *  wrapper an endpoint sits inside: ==highlight==, <mark …>…</mark>,
 *  <span style="color…">…</span>, and Markdown emphasis (**bold**, *italic*,
 *  _italic_, ~~strike~~). WYSIWYG hides those markers, so a selection of the
 *  visible text lands INSIDE them, transforming the raw selection would nest
 *  new wrappers or miss the old ones. Swallowing emphasis also means a color
 *  or highlight wraps AROUND the **, keeping it inside the tag (<mark>**x**
 *  </mark>) where the engine can still render it as bold. */
export function expandStyleRange(line: string, from: number, to: number): { from: number; to: number } {
	const spans: [number, number][] = [];
	const res = [
		/==[^=\n]+?==/g,
		/<mark[^>]*>[\s\S]*?<\/mark>/gi,
		/<span style="color:[^"]*">[\s\S]*?<\/span>/gi,
		/\*\*(?:\S|\S[^\n]*?\S)\*\*/g,
		/~~(?:\S|\S[^\n]*?\S)~~/g,
		/(^|[^\w*])\*(?:[^\s*]|[^\s*][^*\n]*?[^\s*])\*(?![\w*])/g,
		/(^|[^\w_])_(?:[^\s_]|[^\s_][^_\n]*?[^\s_])_(?![\w_])/g,
	];
	for (const re of res) {
		let m: RegExpExecArray | null;
		// two patterns above consume the character before their marker, standing
		// in for a lookbehind, so the span starts after it
		while ((m = re.exec(line)))
			spans.push([m.index + (m[1]?.length ?? 0), m.index + m[0].length]);
	}
	let f = from;
	let t = to;
	let changed = true;
	while (changed) {
		changed = false;
		for (const [s, e] of spans) {
			if (s < f && f < e) {
				f = s;
				changed = true;
			}
			if (s < t && t < e) {
				t = e;
				changed = true;
			}
		}
	}
	return { from: f, to: t };
}

/** Sweep ==highlight== markers out of a whole document: remove them
 *  (replacement null) or convert each span to a colored <mark>. Importers
 *  also scatter UNBALANCED == tokens that pair across sentences into giant
 *  bogus highlights, so when removing, stray == tokens go too.
 *
 *  Semantics are deliberately conservative so technical prose survives:
 *  - Pairs match only FLUSH spans (==text==), mirroring Obsidian's renderer
 *    "a == b" is an equality operator, not a highlight, and stays.
 *  - A stray == is removed only when it hugs plain text (letter, digit, or
 *    sentence punctuation). Spaced tokens ( == ), parenthesized (==),
 *    table-cell |==|, and !== are all left alone.
 *  - Longer = runs (===, setext underlines) are never touched, and fenced
 *    code blocks and inline code are skipped entirely. */
export function sweepHighlights(text: string, background: string | null): { text: string; count: number } {
	let count = 0;
	let inFence = false;
	// flush pairs are exactly what Obsidian renders as a highlight; the
	// boundary check refuses operator cross-pairs like "(==) … !==" whose
	// inner text would start by CLOSING a bracket opened before the marker
	const pairs = (seg: string, replace: (inner: string) => string) =>
		seg.replace(
			/==([^=\n\s]|[^=\n\s][^=\n]*?[^=\n\s])==(?!=)/g,
			(m, inner: string, offset: number, whole: string) => {
			if (whole[offset - 1] === "=") return m; // stands in for (?<!=)
			if (/^[)\]]/.test(inner) || /[([]$/.test(inner)) return m;
			count++;
			return replace(inner);
		});
	const spacey = (ch: string | undefined) => ch == null || /\s/.test(ch);
	const swap = (seg: string) => {
		// converting needs real spans: flush pairs only
		if (background) return pairs(seg, (inner) => `<mark style="background:${background}">${inner}</mark>`);
		// removing: first everything that RENDERS yellow (the flush pairs) …
		let out = pairs(seg, (inner) => inner);
		// … then leftover unpaired litter. A token survives only in operator
		// shapes: spaced both sides, (==, ==), |==|, !==, or a spaced token
		// followed by sentence punctuation ("Equality ==,").
		out = out.replace(/==(?!=)/g, (m, offset: number, whole: string) => {
			const left = whole[offset - 1];
			const right = whole[offset + 2];
			if (left === "=" || left === "!") return m; // stands in for (?<![=!])
			if (spacey(left) && spacey(right)) return m;
			if (left === "(" || left === "|" || right === ")" || right === "|") return m;
			if (spacey(left) && right != null && /[.,;:?!]/.test(right)) return m;
			count++;
			return "";
		});
		// adjacent import boundaries collapse into ==== runs embedded in text
		// ("ActionBar====."); a standalone ==== line is a setext underline and
		// stays, so only text-embedded runs are removed
		out = out.replace(/====(?!=)/g, (m, offset: number, whole: string) => {
			const left = whole[offset - 1];
			const right = whole[offset + 4];
			if (left === "=") return m; // stands in for (?<!=)
			if (spacey(left) && spacey(right)) return m;
			count++;
			return "";
		});
		return out;
	};
	const lines = text.split("\n").map((line) => {
		if (/^\s*(```|~~~)/.test(line)) {
			inFence = !inFence;
			return line;
		}
		if (inFence || !line.includes("==")) return line;
		// split around `inline code` so its contents stay literal
		return line
			.split(/(`[^`\n]*`)/)
			.map((part) => (part.startsWith("`") && part.endsWith("`") && part.length > 1 ? part : swap(part)))
			.join("");
	});
	return { text: lines.join("\n"), count };
}

/** Strip inline formatting from text: Markdown emphasis, highlight, code, and
 *  the inline HTML the toolbar can write (u/span/mark…). Links keep their text
 *  and target, clearing style shouldn't destroy where things point. */
export function stripFormatting(text: string): string {
	let t = text;
	for (let i = 0; i < 3; i++) {
		t = t
			.replace(/(\*\*\*|___)([^*_]+?)\1/g, "$2")
			.replace(/(\*\*|__)([^*_]+?)\1/g, "$2")
			.replace(/(^|[^\w*])\*([^*\n]+?)\*(?![\w*])/g, "$1$2")
			.replace(/(^|[^\w_])_([^_\n]+?)_(?![\w_])/g, "$1$2")
			.replace(/~~([^~]+?)~~/g, "$1")
			.replace(/==([^=]+?)==/g, "$1")
			.replace(/`([^`\n]+?)`/g, "$1");
	}
	t = t.replace(/<\/?(?:u|b|i|em|strong|s|small|sub|sup|mark|span|font)(?:\s[^>]*)?>/gi, "");
	return t;
}

const COPY_TAGS = /<\/?(?:u|b|i|em|strong|s|small|sub|sup|mark|span|font)(?:\s[^>]*)?>/gi;

/** Clean a copied Markdown selection for pasting into other apps. "clean"
 *  peels off the inline HTML the toolbar writes (<mark>, color/size <span>,
 *  <u>, <sub>, <sup>, <font>) and unwraps ==highlights==, leaving Markdown
 *  emphasis like **bold** intact, so a highlighted line stops pasting its raw
 *  tags. "plain" strips that emphasis and heading hashes too, for text with no
 *  markup at all. Inline code and fenced blocks pass through verbatim, so an
 *  == operator or a literal tag inside code is never touched. */
export function cleanCopyText(md: string, mode: "clean" | "plain"): string {
	// unwrap only the highlights Obsidian actually renders (guards == operators)
	const unwrapped = sweepHighlights(md, null).text;
	let inFence = false;
	return unwrapped
		.split("\n")
		.map((line) => {
			if (/^\s*(```|~~~)/.test(line)) {
				inFence = !inFence;
				return line;
			}
			if (inFence) return line;
			const body = mode === "plain" ? line.replace(/^(\s*)#{1,6}[ \t]+/, "$1") : line;
			return body
				.split(/(`[^`\n]*`)/)
				.map((part) => {
					if (part.startsWith("`") && part.endsWith("`") && part.length > 1) return part;
					const stripped = part.replace(COPY_TAGS, "");
					return mode === "plain" ? stripFormatting(stripped) : stripped;
				})
				.join("");
		})
		.join("\n");
}

/** Convert Markdown emphasis to the HTML that survives inside a colored
 *  highlight: Obsidian's Live Preview won't format ** inside inline HTML off
 *  the active line, but it draws <strong>/<em>/<s>. Only flush spans convert,
 *  so an == operator or a spaced * is left alone. */
export function mdEmphasisToHtml(text: string): string {
	return text
		.replace(/\*\*(\S|\S[^\n]*?\S)\*\*/g, "<strong>$1</strong>")
		.replace(/~~(\S|\S[^\n]*?\S)~~/g, "<s>$1</s>")
		.replace(/(^|[^\w*])\*([^\s*]|[^\s*][^*\n]*?[^\s*])\*(?![\w*])/g, "$1<em>$2</em>")
		.replace(/(^|[^\w_])_([^\s_]|[^\s_][^_\n]*?[^\s_])_(?![\w_])/g, "$1<em>$2</em>");
}

/** The inverse: HTML emphasis back to Markdown, for when a highlight or color
 *  is removed and the text can go back to portable Markdown. */
export function htmlEmphasisToMd(text: string): string {
	return text
		.replace(/<(strong|b)>([\s\S]*?)<\/\1>/gi, "**$2**")
		.replace(/<(em|i)>([\s\S]*?)<\/\1>/gi, "*$2*")
		.replace(/<(s|del)>([\s\S]*?)<\/\1>/gi, "~~$2~~");
}

/** Convert Markdown emphasis to HTML inside every colored highlight and color
 *  span in a document, leaving text outside them as portable Markdown. Fixes
 *  notes written before highlights carried HTML bold (fenced code is skipped). */
export function convertEmphasisInWrappers(text: string): { text: string; count: number } {
	let count = 0;
	let inFence = false;
	const conv = (inner: string) => {
		const c = mdEmphasisToHtml(inner);
		if (c !== inner) count++;
		return c;
	};
	const lines = text.split("\n").map((line) => {
		if (/^\s*(```|~~~)/.test(line)) {
			inFence = !inFence;
			return line;
		}
		if (inFence || !line.includes("<")) return line;
		return line
			.replace(/(<mark[^>]*>)([\s\S]*?)(<\/mark>)/gi, (_m, o, i, c) => o + conv(i) + c)
			.replace(/(<span style="color:[^"]*">)([\s\S]*?)(<\/span>)/gi, (_m, o, i, c) => o + conv(i) + c);
	});
	return { text: lines.join("\n"), count };
}

/* ---------- rich-text copy (Markdown out to a mail client) ---------- */

/** The list marker an HTML client will show for a nested ordered list. Markdown
 *  writes every level as "1.", and Obsidian styles the depths apart in its own
 *  views; that styling is CSS, so it never reaches the clipboard and a mail
 *  client renumbers every level 1, 2, 3. The `type` attribute is the one lever
 *  Outlook, Gmail, and Word all still honor. The cycle repeats past the third
 *  level, which is where any of them stop having a convention anyway. */
export function olTypeForDepth(depth: number): "1" | "a" | "i" {
	const cycle = ["1", "a", "i"] as const;
	return cycle[Math.max(0, depth) % 3];
}

/** The same thing said in CSS. The `type` attribute alone is not enough: the
 *  current Outlook is the web client in a desktop shell, and its editor
 *  normalizes a pasted list, dropping attributes it did not write while
 *  keeping inline styles. Sending both covers the clients that honor either. */
export function olStyleForDepth(depth: number): "decimal" | "lower-alpha" | "lower-roman" {
	const t = olTypeForDepth(depth);
	return t === "a" ? "lower-alpha" : t === "i" ? "lower-roman" : "decimal";
}

/** A paragraph that exists only to make a gap. Markdown written in an editor
 *  that inserts non-breaking spaces (Word, Outlook, a phone keyboard) carries
 *  lines that look empty and are not; pasted into mail they become a full empty
 *  paragraph, and the "why is there a hole above my list" gap is exactly this. */
export function isBlankBlock(text: string): boolean {
	// escapes rather than the characters themselves: an invisible in the source
	// is one tidy-up away from silently becoming a plain space
	return !text.replace(/[\s\u00a0\u200b\ufeff]+/g, "").length;
}

/** Frontmatter is note plumbing, never part of what gets emailed. */
export function stripFrontmatter(md: string): string {
	return /^---\r?\n/.test(md) ? md.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "") : md;
}

/** The clipboard HTML carries the Markdown it came from, so a copy that leaves
 *  Obsidian rich still arrives back inside it exactly as written. Without this
 *  a round trip goes through the HTML reader: wikilinks flatten, callouts turn
 *  into quotes, and a copy-paste inside one's own vault quietly loses work.
 *  btoa alone cannot hold anything outside Latin-1, and notes are full of
 *  em dashes and emoji, so the bytes go through UTF-8 first. */
export function wrapWithMarkdown(html: string, md: string): string {
	const bytes = new TextEncoder().encode(md);
	let bin = "";
	for (const b of bytes) bin += String.fromCharCode(b);
	return `<div data-ped-md="${btoa(bin)}">${html}</div>`;
}

/** The Markdown a wrapped copy came from, or null when this HTML is not ours.
 *  Anything unreadable reports null: a mangled marker must fall through to the
 *  normal HTML path rather than paste garbage. */
export function markdownFromMarker(html: string | null | undefined): string | null {
	const m = /<div data-ped-md="([A-Za-z0-9+/=]*)"/.exec(html ?? "");
	if (!m) return null;
	try {
		const bin = atob(m[1]);
		const bytes = new Uint8Array(bin.length);
		for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
		const md = new TextDecoder().decode(bytes);
		return md || null;
	} catch {
		return null;
	}
}
