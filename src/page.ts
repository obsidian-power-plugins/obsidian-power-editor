/* Pure logic for the Notion-style page features: covers (a banner image or
 * gradient declared in frontmatter), inline comments (%%💬 …%% markers, plain
 * markdown that reading view naturally omits), and page verification (a
 * frontmatter date with an optional expiry). No Obsidian imports — all of
 * this is covered by tests.ts. */

/* ---------------- covers ---------------- */

export type CoverHeight = "short" | "standard" | "tall";

export interface CoverSpec {
	kind: "gradient" | "solid" | "url" | "path";
	value: string;
	/** Vertical focus 0-100 (percent), from the `cover-y` property. */
	y: number;
	/** Banner height, from the `cover-h` property. */
	height: CoverHeight;
}

/** Read `cover` / `cover-y` / `cover-h` out of a note's frontmatter. */
export function parseCover(fm: Record<string, unknown> | undefined): CoverSpec | null {
	const raw = fm?.["cover"];
	if (typeof raw !== "string" || !raw.trim()) return null;
	const value = raw.trim();
	const yRaw = fm?.["cover-y"];
	const y = Math.max(0, Math.min(100, typeof yRaw === "number" ? yRaw : 50));
	const hRaw = typeof fm?.["cover-h"] === "string" ? (fm["cover-h"] as string).trim().toLowerCase() : "";
	const height: CoverHeight = hRaw === "short" || hRaw === "tall" ? hRaw : "standard";
	if (/^gradient:\d+$/.test(value)) return { kind: "gradient", value, y, height };
	const solid = value.match(/^solid:(.+)$/i);
	if (solid) return { kind: "solid", value: solid[1].trim(), y, height };
	if (/^#[0-9a-fA-F]{3,8}$/.test(value)) return { kind: "solid", value, y, height };
	if (/^https?:\/\//i.test(value)) return { kind: "url", value, y, height };
	const wiki = value.match(/^\[\[([^\]|]+?)(?:\|[^\]]*)?\]\]$/);
	if (wiki) return { kind: "path", value: wiki[1].trim(), y, height };
	return { kind: "path", value, y, height };
}

/** The cover gallery: Notion-flavored gradients, no assets needed. */
export const GRADIENTS = [
	"linear-gradient(120deg, #f6d365 0%, #fda085 100%)",
	"linear-gradient(120deg, #a1c4fd 0%, #c2e9fb 100%)",
	"linear-gradient(120deg, #d4fc79 0%, #96e6a1 100%)",
	"linear-gradient(120deg, #cfd9df 0%, #e2ebf0 100%)",
	"linear-gradient(120deg, #fbc2eb 0%, #a6c1ee 100%)",
	"linear-gradient(120deg, #fdcbf1 0%, #fdcbf1 1%, #e6dee9 100%)",
	"linear-gradient(120deg, #667eea 0%, #764ba2 100%)",
	"linear-gradient(120deg, #2c3e50 0%, #4ca1af 100%)",
	"linear-gradient(120deg, #ff9a9e 0%, #fecfef 100%)",
	"linear-gradient(120deg, #84fab0 0%, #8fd3f4 100%)",
	"linear-gradient(120deg, #f093fb 0%, #f5576c 100%)",
	"linear-gradient(120deg, #4facfe 0%, #00f2fe 100%)",
	"linear-gradient(120deg, #fa709a 0%, #fee140 100%)",
	"linear-gradient(120deg, #30cfd0 0%, #330867 100%)",
	"linear-gradient(120deg, #ffecd2 0%, #fcb69f 100%)",
	"radial-gradient(circle at 30% 20%, #6a11cb 0%, #2575fc 100%)",
];

export const GRADIENT_NAMES = [
	"Peach",
	"Sky",
	"Meadow",
	"Fog",
	"Blossom",
	"Lilac",
	"Twilight",
	"Deep sea",
	"Coral",
	"Mint",
	"Sunset",
	"Azure",
	"Guava",
	"Cosmos",
	"Apricot",
	"Nebula",
];

/** Soft page tints, Notion-style, for a plain solid-color cover. */
export const SOLIDS = ["#EAE6DF", "#EDE7F6", "#E3F2FD", "#E8F5E9", "#FFF8E1", "#FCE4EC", "#E0F2F1", "#EEF2F5", "#37474F", "#4A3B52"];

export const SOLID_NAMES = ["Sand", "Lavender", "Sky", "Sage", "Cream", "Blush", "Teal", "Slate", "Charcoal", "Plum"];

/** "gradient:3" → its css; indexes wrap so old notes never break. */
export function gradientCss(value: string): string | null {
	const m = value.match(/^gradient:(\d+)$/);
	if (!m) return null;
	const i = (Number(m[1]) - 1) % GRADIENTS.length;
	return GRADIENTS[(i + GRADIENTS.length) % GRADIENTS.length];
}

/* ---------------- page layout ---------------- */

export interface PageLayout {
	/** Drop the readable-line-width constraint for this note. */
	fullWidth: boolean;
	/** Body font override, or null for the theme default. */
	font: "serif" | "mono" | null;
	/** Float the page icon and title onto the bottom of the cover image. */
	overlayTitle: boolean;
}

/** Read the per-note page options from frontmatter: `full-width`, `font`
 *  (serif / monospace), and `cover-overlay`. */
export function parsePageLayout(fm: Record<string, unknown> | undefined): PageLayout {
	const flag = (v: unknown) => v === true || v === "true";
	const f = typeof fm?.["font"] === "string" ? (fm["font"] as string).trim().toLowerCase() : "";
	const font = f === "serif" ? "serif" : f === "mono" || f === "monospace" ? "mono" : null;
	return { fullWidth: flag(fm?.["full-width"]), font, overlayTitle: flag(fm?.["cover-overlay"]) };
}

/** The page's emoji icon from frontmatter, Notion-style. */
export function parseIcon(fm: Record<string, unknown> | undefined): string | null {
	const raw = fm?.["icon"];
	if (typeof raw !== "string") return null;
	const v = raw.trim();
	return v ? v : null;
}

/* ---------------- comments ---------------- */

export interface NoteComment {
	line: number;
	/** Character offset of the opening %% on that line. */
	ch: number;
	text: string;
	stamp: string | null;
}

const COMMENT_RE = /%%💬\s*(.*?)%%/g;

/** A serialized comment marker: `%%💬 text · YYYY-MM-DD%%`. */
export function makeComment(text: string, date: string): string {
	return `%%💬 ${text.trim()} · ${date}%%`;
}

/** Split a marker's inner text into the comment body and its date stamp. */
export function commentParts(inner: string): { text: string; stamp: string | null } {
	const m = inner.match(/^(.*?)\s*·\s*(\d{4}-\d{2}-\d{2})$/);
	return m ? { text: m[1].trim(), stamp: m[2] } : { text: inner.trim(), stamp: null };
}

/** Every comment marker in the note, with its line and column. */
export function parseComments(lines: string[]): NoteComment[] {
	const out: NoteComment[] = [];
	lines.forEach((line, i) => {
		COMMENT_RE.lastIndex = 0;
		let m: RegExpExecArray | null;
		while ((m = COMMENT_RE.exec(line))) {
			out.push({ line: i, ch: m.index, ...commentParts(m[1]) });
		}
	});
	return out;
}

/** Rewrite a single marker with new text and a fresh stamp. */
export function replaceCommentText(raw: string, newText: string, date: string): string {
	return raw.replace(COMMENT_RE, () => makeComment(newText, date));
}

/* ---------------- verification ---------------- */

export type VerifyState =
	| { state: "none" }
	| { state: "verified"; since: string; until: string | null }
	| { state: "expired"; since: string; until: string };

const asDateStr = (v: unknown): string | null => {
	if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v.trim())) return v.trim().slice(0, 10);
	return null;
};

/** Notion-style verification: `verified` date plus optional `verified-until`.
 *  A past expiry demotes the badge instead of silently staying green. */
export function verificationState(fm: Record<string, unknown> | undefined, today: string): VerifyState {
	const since = asDateStr(fm?.["verified"]);
	if (!since) return { state: "none" };
	const until = asDateStr(fm?.["verified-until"]);
	if (until && until < today) return { state: "expired", since, until };
	return { state: "verified", since, until: until ?? null };
}

/* ---------- last-edited stamp ---------- */

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** "Edited 3 minutes ago", 1Password-style. Coarse on purpose: the point is
 *  a glanceable sense of age, not a stopwatch. Anything older than a month
 *  reads as a date, because "37 days ago" is harder to place than "Jun 18".
 *  Clock skew (a file stamped in the future by a sync) reads as "just now"
 *  rather than a negative. */
export function relativeEdited(then: number, now: number): string {
	const d = now - then;
	if (!Number.isFinite(then) || then <= 0) return "";
	if (d < 45 * 1000) return "just now";
	if (d < 90 * 1000) return "a minute ago";
	if (d < HOUR) return `${Math.round(d / MIN)} minutes ago`;
	if (d < 2 * HOUR) return "an hour ago";
	if (d < DAY) return `${Math.round(d / HOUR)} hours ago`;
	if (d < 2 * DAY) return "yesterday";
	if (d < 30 * DAY) return `${Math.round(d / DAY)} days ago`;
	return new Date(then).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

/** The full stamp for the tooltip and for the click-to-expand form. */
export function absoluteEdited(then: number): string {
	if (!Number.isFinite(then) || then <= 0) return "";
	return new Date(then).toLocaleString(undefined, {
		weekday: "short",
		month: "short",
		day: "numeric",
		year: "numeric",
		hour: "numeric",
		minute: "2-digit",
	});
}

/** When the note was last edited. Frontmatter wins over the file's own mtime:
 *  a synced vault can have mtime rewritten by the sync client on download, so
 *  a note edited on another device would otherwise claim to be edited the
 *  moment it arrived here. A hand-maintained `updated:` is the truth when it
 *  exists. Returns 0 when there is nothing to show. */
export function editedAt(fm: Record<string, unknown> | undefined, mtime: number): number {
	for (const key of ["updated", "modified", "last-edited"]) {
		const v = fm?.[key];
		if (typeof v === "string" || typeof v === "number") {
			const t = new Date(v as string).getTime();
			if (Number.isFinite(t) && t > 0) return t;
		}
	}
	return Number.isFinite(mtime) && mtime > 0 ? mtime : 0;
}
