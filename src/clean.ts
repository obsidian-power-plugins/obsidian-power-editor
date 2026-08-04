/* Pure halves of clean-Markdown pasting. The HTML→Markdown conversion itself
 * is Obsidian's htmlToMarkdown; these strip Word/Outlook/web sludge before it,
 * convert every <table> ourselves (htmlToMarkdown only keeps a table when its
 * first row is a real heading row, so tables copied out of ChatGPT, Claude, or
 * Grok flatten into one run-on paragraph), and tidy the Markdown after it. */

/* Word/Outlook write lists as flat MsoListParagraph paragraphs whose visible
 * marker ("· ", "1.") hides inside an mso-list:Ignore span or a
 * [if !supportLists] comment. Rebuild real nested ul/ol BEFORE the comment and
 * class strips destroy the evidence, so htmlToMarkdown sees genuine lists. */
export function convertWordLists(html: string): string {
	const pRe = /<p\b[^>]*MsoListParagraph[^>]*>([\s\S]*?)<\/p>/gi;
	type Item = { level: number; ordered: boolean; inner: string };
	let out = "";
	let last = 0;
	let run: Item[] = [];
	const flush = () => {
		if (!run.length) return;
		out += buildNestedList(run);
		run = [];
	};
	let m: RegExpExecArray | null;
	while ((m = pRe.exec(html))) {
		const between = html.slice(last, m.index);
		if (between.trim()) {
			flush();
			out += between;
		}
		last = m.index + m[0].length;
		const open = m[0].slice(0, m[0].indexOf(">") + 1);
		const level = Number(/level(\d+)/i.exec(open)?.[1] ?? "1");
		let marker = "";
		let inner = m[1]
			.replace(/<!--\[if !supportLists\]-->([\s\S]*?)<!--\[endif\]-->/gi, (_s, g: string) => {
				marker += g;
				return "";
			})
			.replace(/<span[^>]*mso-list:\s*Ignore[^>]*>([\s\S]*?)<\/span>/gi, (_s, g: string) => {
				marker += g;
				return "";
			});
		const plain = marker.replace(/<[^>]*>/g, "").replace(/&nbsp;/gi, " ").trim();
		const ordered = /^(\d+|[a-z]|[ivxlc]+)[.)]/i.test(plain);
		run.push({ level: Math.max(1, level), ordered, inner: inner.trim() });
	}
	flush();
	return out + html.slice(last);
}

function buildNestedList(items: { level: number; ordered: boolean; inner: string }[]): string {
	let html = "";
	const stack: string[] = [];
	for (const it of items) {
		while (stack.length > it.level) html += `</li></${stack.pop()}>`;
		if (stack.length === it.level && stack.length) html += "</li>";
		while (stack.length < it.level) {
			const tag = it.ordered ? "ol" : "ul";
			html += `<${tag}>`;
			stack.push(tag);
		}
		html += `<li>${it.inner}`;
	}
	while (stack.length) html += `</li></${stack.pop()}>`;
	return html;
}

export function preCleanHtml(html: string): string {
	return convertWordLists(html)
		.replace(/<!--[\s\S]*?-->/g, "")
		.replace(/<xml[\s\S]*?<\/xml>/gi, "")
		.replace(/<style[\s\S]*?<\/style>/gi, "")
		.replace(/<script[\s\S]*?<\/script>/gi, "")
		.replace(/<\/?o:p[^>]*>/gi, "")
		.replace(/<\/?(?:w|m|v):[^>]*>/gi, "")
		.replace(/<meta[^>]*>/gi, "")
		.replace(/\s(?:class|style|lang|dir|id|align|width|height|valign|face|color|size)="[^"]*"/gi, "")
		.replace(/&nbsp;/gi, " ");
}

/* ---------------- tables ---------------- */

type Span = { attrs: string; inner: string };

/** The outermost <name>…</name> stretches of `html`, one entry each. Depth is
 *  counted across the whole family so a table nested inside a cell stays part
 *  of that cell instead of being read as another row. */
function topLevelTags(html: string, names: string[]): Span[] {
	const re = new RegExp(`<(/?)(?:${names.join("|")})\\b([^>]*?)(/?)>`, "gi");
	const out: Span[] = [];
	let depth = 0;
	let start = 0;
	let attrs = "";
	let m: RegExpExecArray | null;
	while ((m = re.exec(html))) {
		if (m[3] === "/") continue; // <td/>, self-closed, nothing to collect
		if (!m[1]) {
			if (depth++ === 0) {
				start = re.lastIndex;
				attrs = m[2];
			}
		} else if (depth && --depth === 0) {
			out.push({ attrs, inner: html.slice(start, m.index) });
		}
	}
	if (depth) out.push({ attrs, inner: html.slice(start) }); // clipboard fragment cut mid-table
	return out;
}

/** The outermost <table>…</table> ranges, so the caller can convert them and
 *  hand everything around them to htmlToMarkdown untouched. */
function tableRanges(html: string): { start: number; end: number }[] {
	const re = /<(\/?)table\b[^>]*>/gi;
	const out: { start: number; end: number }[] = [];
	let depth = 0;
	let start = 0;
	let m: RegExpExecArray | null;
	while ((m = re.exec(html))) {
		if (!m[1]) {
			if (depth++ === 0) start = m.index;
		} else if (depth && --depth === 0) {
			out.push({ start, end: re.lastIndex });
		}
	}
	if (depth) out.push({ start, end: html.length });
	return out;
}

const spanCount = (attrs: string, name: string): number => {
	const n = Number(new RegExp(`${name}\\s*=\\s*"?(\\d+)`, "i").exec(attrs)?.[1] ?? "1");
	return n > 0 && n < 100 ? n : 1;
};

/** One cell's Markdown: block structure inside a cell has nowhere to go in a
 *  Markdown table, so paragraphs and list items fold onto one line with <br>. */
function cellMarkdown(inner: string, toMd: (html: string) => string): string {
	return toMd(inner)
		.replace(/\r/g, "")
		.trim()
		.replace(/\\?\|/g, "\\|")
		.replace(/\n+/g, "<br>")
		.replace(/(?:<br>)+$/, "")
		.trim();
}

/** A <table> as a Markdown table. Colspans and rowspans have no Markdown
 *  equivalent, so a spanned cell keeps its text in the first slot and pads the
 *  rest, which is what keeps the columns lined up. The first row becomes the
 *  header whether or not the source bothered with <thead> or <th>. */
export function tableToMarkdown(html: string, toMd: (html: string) => string): string {
	const caption = topLevelTags(html, ["caption"])[0];
	const title = caption ? cellMarkdown(caption.inner, toMd) : "";
	const grid: string[][] = [];
	topLevelTags(html, ["tr"]).forEach((row, r) => {
		if (!grid[r]) grid[r] = [];
		let c = 0;
		for (const cell of topLevelTags(row.inner, ["td", "th"])) {
			while (grid[r][c] !== undefined) c++;
			const text = cellMarkdown(cell.inner, toMd);
			const down = spanCount(cell.attrs, "rowspan");
			const across = spanCount(cell.attrs, "colspan");
			for (let i = 0; i < down; i++) {
				const line = (grid[r + i] ||= []);
				for (let j = 0; j < across; j++) line[c + j] = i === 0 && j === 0 ? text : "";
			}
			c += across;
		}
	});
	const rows = grid.filter((row) => row?.some((cell) => cell?.trim()));
	if (!rows.length) return title;
	const width = Math.max(...rows.map((row) => row.length));
	const cells = (row: string[]) => `| ${Array.from({ length: width }, (_, i) => row[i] ?? "").join(" | ")} |`;
	const table = [cells(rows[0]), `| ${Array.from({ length: width }, () => "---").join(" | ")} |`, ...rows.slice(1).map(cells)].join("\n");
	return title ? `${title}\n\n${table}` : table;
}

/** Pasted HTML as Markdown: tables converted here, everything between them by
 *  htmlToMarkdown, so a table never loses its shape on the way in. */
export function cleanPastedHtml(html: string, toMd: (html: string) => string): string {
	const pre = preCleanHtml(html);
	const parts: string[] = [];
	let last = 0;
	for (const range of tableRanges(pre)) {
		parts.push(toMd(pre.slice(last, range.start)));
		parts.push(tableToMarkdown(pre.slice(range.start, range.end), toMd));
		last = range.end;
	}
	parts.push(toMd(pre.slice(last)));
	return postCleanMarkdown(
		parts
			.map((p) => p.trim())
			.filter(Boolean)
			.join("\n\n")
	);
}

/** Tab-separated rows as a Markdown table, or null when the text is not a
 *  grid. Claude.ai (like Excel and Sheets) copies a table as tab-separated
 *  plain text, which pastes as tab-run lines unless it is rebuilt here.
 *  Tabs that only ever indent are code, not columns, so those stay text. */
export function tabbedTextToMarkdown(text: string): string | null {
	const lines = text.replace(/\r\n?/g, "\n").replace(/\n+$/, "").split("\n");
	if (lines.length < 2 || lines.some((l) => !l.includes("\t")) || lines.every((l) => !/[^\t]\t/.test(l))) return null;
	const rows = lines.map((l) => l.split("\t").map((c) => c.trim().replace(/\|/g, "\\|")));
	const width = rows[0].length;
	if (width < 2 || rows.some((r) => r.length !== width)) return null;
	const cells = (row: string[]) => `| ${row.join(" | ")} |`;
	return [cells(rows[0]), `| ${Array.from({ length: width }, () => "---").join(" | ")} |`, ...rows.slice(1).map(cells)].join("\n");
}

/** True when text already carries a Markdown table (a |---|---| divider row).
 *  Chat apps put their own Markdown on the clipboard as plain text, and that
 *  original always beats anything converted back out of the rendered HTML. */
export function looksLikeMarkdownTable(text: string): boolean {
	return /^[ \t]*\|?[ \t]*:?-{3,}:?[ \t]*(?:\|[ \t]*:?-{3,}:?[ \t]*)+\|?[ \t]*$/m.test(text);
}

/** True when the Markdown is one whole table and nothing else. Converted HTML
 *  that breaks into a run of one-row tables (ChatGPT copies a table row by
 *  row) fails this, which is the cue to rebuild from the plain text instead. */
export function isOneMarkdownTable(md: string): boolean {
	const lines = md.trim().split("\n");
	return lines.length > 1 && lines.every((l) => /^[ \t]*\|/.test(l)) && lines.filter(looksLikeMarkdownTable).length === 1 && looksLikeMarkdownTable(lines[1]);
}

/* ---------------- where a paste lands ---------------- */

/** A list item's opening: its indent, then the marker and the spaces after it,
 *  with a task checkbox counted as part of the marker. */
const LIST_ITEM = /^([ \t]*)((?:[-*+]|\d+[.)])[ \t]+(?:\[.\][ \t]+)?)/;

/** A fenced block's opening line: the indent, an optional list marker, the
 *  backticks, then the info string. The marker is part of it because a step
 *  whose content is code opens its fence on the marker's own line, so the block
 *  sits beside the number the way the step's words would. A backtick fence's
 *  info string may hold no backticks of its own, which is what keeps a bullet
 *  reading like "- ```js``` means JavaScript" a sentence and not a block. */
export const FENCE_LINE = /^([ \t]*)((?:[-*+]|\d+[.)])[ \t]+(?:\[.\][ \t]+)?)?(`{3,}(?!.*`)|~{3,})(.*)$/;

/** The whitespace every line of a fenced block sits at, given its opening line:
 *  past the list marker when there is one, so the body lines up with the step's
 *  words rather than with its number. */
export const fenceIndent = (openLine: string): string => {
	const m = FENCE_LINE.exec(openLine);
	return m ? m[1] + " ".repeat(m[2]?.length ?? 0) : "";
};

const opensTable = (md: string) => /^[ \t]*\|/.test(md);
const closesTable = (md: string) => /\|[ \t]*$/.test(md);
const opensFence = (md: string) => /^[ \t]*(?:```|~~~)/.test(md);
const closesFence = (md: string) => /(?:```|~~~)[ \t]*$/.test(md);

/** What a line says once its list marker is discounted. An item holding nothing
 *  but its marker says nothing, which is what tells an empty step apart from a
 *  step whose words a block has to clear. */
export const textBesideMarker = (line: string) => line.replace(LIST_ITEM, "").trim();

/** The column an item's own content starts at, as the whitespace that puts a
 *  following line there. Only the marker widens into spaces; the indent is
 *  copied as it stands, so a vault that indents with tabs stays tabbed. */
const contentIndent = (item: RegExpExecArray) => item[1] + " ".repeat(item[2].length);

/** The whitespace that puts a line at the content column of the list item this
 *  line starts, or "" when it is not a list item. Every line of a block written
 *  inside an item sits here: written where the cursor stands, the block's second
 *  line goes back to column 0, which ends the list and leaves the block outside
 *  the step it was meant for, its closing fence reading as the start of another
 *  block rather than the end of this one. */
export function listContentIndent(line: string): string {
	const m = LIST_ITEM.exec(line);
	return m ? contentIndent(m) : "";
}

/** The break between whatever the cursor's line already holds and a block
 *  landing on it. A table wants a blank line, since its rows only read as a
 *  table at the start of a block; a fence only wants the line to itself. Inside
 *  a list the marker keeps its line either way, so the step stays numbered and
 *  the block sits under it: a step whose whole content is code still reads as a
 *  step, and the number is the thing the reader is following. */
function blockHead(md: string, before: string): string {
	if (!opensTable(md) && !opensFence(md)) return "";
	// an empty step: a fence opens on the marker's own line, so the block sits
	// beside the number; a table's rows have to start a line of their own
	if (!textBesideMarker(before)) return LIST_ITEM.test(before) && opensTable(md) ? "\n" : "";
	return opensTable(md) ? "\n\n" : "\n";
}

/** Markdown pasted mid-line needs a break around it, or the table rows read as
 *  more words in the paragraph they landed in and the text either side of a
 *  fence swallows the fence. */
export function padPastedMarkdown(md: string, before: string, after: string): string {
	const tail = closesTable(md) ? "\n\n" : closesFence(md) ? "\n" : "";
	return `${blockHead(md, before)}${md}${after.trim() ? tail : ""}`;
}

/** The next item of the list a fenced block sits in, indent and marker, ready
 *  to type into: what a line written after the block should be. Walks up from
 *  the opening fence, so a line inside the code that reads like a list item
 *  ("- name: x" in YAML) is never mistaken for the step. "" when the block is
 *  not in a list, where a plain new line is all there is to write. */
export function nextItemAfterFence(lineAt: (n: number) => string, openLine: number): string {
	// the fence may open on the step's own line, and then that step is the one
	const own = FENCE_LINE.exec(lineAt(openLine));
	if (own?.[2]) return own[1] + nextMarker(own[2]);
	const fence = /^[ \t]*/.exec(lineAt(openLine))?.[0] ?? "";
	for (let n = openLine - 1; n >= 0; n--) {
		const text = lineAt(n);
		if (!text.trim()) continue;
		const m = LIST_ITEM.exec(text);
		if (m) return contentIndent(m).length <= fence.length ? m[1] + nextMarker(m[2]) : "";
		if (!/^[ \t]/.test(text)) return ""; // a line at the left margin: no list around this
	}
	return "";
}

/** The marker after this one: numbers count on, bullets repeat, and a ticked
 *  task starts the next one unticked. */
const nextMarker = (marker: string) => marker.replace(/^\d+/, (n) => String(Number(n) + 1)).replace(/\[.\]/, "[ ]");

/** True when the cursor sits inside a fenced code block, given everything above
 *  it. A paste there is code, and code lands exactly as it was copied: a line
 *  that reads like a list item ("- name: x" in YAML) is not one. Counted from
 *  the top of the note, which is the only place a fence's state can be read. */
export function insideFence(textAbove: string): boolean {
	let fenced = false;
	for (const line of textAbove.split("\n")) if (FENCE_LINE.test(line)) fenced = !fenced;
	return fenced;
}

/** What a paste should insert: the Markdown, broken clear of whatever it landed
 *  on, and held inside the list item it landed in. The first line is left where
 *  it is, since it either continues the line already there or is the break that
 *  puts the block below it. */
export function planPastedMarkdown(md: string, before: string, after: string): string {
	const padded = padPastedMarkdown(md, before, after);
	const indent = listContentIndent(before);
	if (!indent || !padded.includes("\n")) return padded;
	return padded
		.split("\n")
		.map((line, i) => (!i || !line.trim() ? line : indent + line))
		.join("\n");
}

/* ---------------- placeholder tags ---------------- */

/* Every element Obsidian or the toolbar might legitimately write. Anything
 * else in angle brackets is a placeholder someone typed, <AppFeature>,
 * <ModuleORFeature>, which Obsidian reads as an unclosed HTML tag, and from
 * that point Live Preview stops parsing Markdown for the rest of the note:
 * headings, emphasis and links downstream of it all render as raw source. */
const HTML_TAGS = new Set(
	(
		"a abbr address area article aside audio b base bdi bdo big blockquote body br button canvas caption cite code col " +
		"colgroup data datalist dd del details dfn dialog div dl dt em embed fieldset figcaption figure footer form h1 h2 " +
		"h3 h4 h5 h6 head header hgroup hr html i iframe img input ins kbd label legend li link main map mark menu meta " +
		"meter nav noscript object ol optgroup option output p param picture pre progress q rp rt ruby s samp script " +
		"section select slot small source span strong style sub summary sup table tbody td template textarea tfoot th " +
		"thead time title tr track u ul var video wbr svg path circle rect polygon polyline defs use"
	).split(" ")
);

export type PlaceholderTag = { line: number; tag: string };

/** Visit the parts of `md` that are not code, line by line. Placeholders
 *  inside a fence or a code span are already inert and are what a careful
 *  writer types on purpose, so they must survive untouched. */
function outsideCode(md: string, fn: (s: string, lineNo: number) => string): string {
	let fenced = false;
	return md
		.split("\n")
		.map((line, i) => {
			if (FENCE_LINE.test(line)) {
				fenced = !fenced;
				return line;
			}
			if (fenced) return line;
			// A link destination is not inline-parsed, so a placeholder inside
			// one is already harmless, and escaping it would push backslashes
			// into the URL itself. Only the link text is scanned.
			return line
				.split(/(`+[^`]*`+|\]\([^)]*\))/)
				.map((part) => (part.startsWith("`") || part.startsWith("](") ? part : fn(part, i)))
				.join("");
		})
		.join("\n");
}

/** Anything shaped like a tag. Autolinks (<https://…>) and comments never
 *  match this, so they need no special case. */
const TAG_SHAPE = /<\/?[A-Za-z][A-Za-z0-9-]*(?:\s[^<>]*)?\/?>/g;

/** True when this tag is a placeholder rather than real HTML, and is not
 *  already escaped. */
function isPlaceholder(tag: string, offset: number, whole: string): boolean {
	if (offset > 0 && whole[offset - 1] === "\\") return false; // already escaped
	const name = /^<\/?([A-Za-z][A-Za-z0-9-]*)/.exec(tag)?.[1].toLowerCase() ?? "";
	return !HTML_TAGS.has(name);
}

/** Escape angle-bracket placeholders so they stay literal text. Only the "<"
 *  needs escaping; a bare ">" is already harmless. */
export function escapePlaceholderTags(md: string): string {
	return outsideCode(md, (seg) => seg.replace(TAG_SHAPE, (tag, offset: number, whole: string) => (isPlaceholder(tag, offset, whole) ? `\\${tag}` : tag)));
}

/** Where the placeholders are, for a sweep that shows its work before it
 *  writes. Same walk as the escape, so the preview can never disagree with
 *  what the rewrite goes on to do. */
export function findPlaceholderTags(md: string): PlaceholderTag[] {
	const out: PlaceholderTag[] = [];
	outsideCode(md, (seg, lineNo) => {
		seg.replace(TAG_SHAPE, (tag, offset: number, whole: string) => {
			if (isPlaceholder(tag, offset, whole)) out.push({ line: lineNo, tag });
			return tag;
		});
		return seg;
	});
	return out;
}

export function postCleanMarkdown(md: string): string {
	const tidied = md
		.replace(/\u00A0/g, " ")
		.replace(/[ \t]+$/gm, "")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
	return escapePlaceholderTags(tidied);
}
