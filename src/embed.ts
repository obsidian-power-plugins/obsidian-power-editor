/* Pure logic behind the image-resize handles: find the embed on a line whose
 * target matches the rendered image, and write a pixel width into it (or take
 * it back out). Covered by tests.ts. */

const SIZE = /^\d+(x\d+)?$/;

/** Rewrite the embed of `target` on this line with the given width, or strip
 *  the width when null. Understands ![[file|300]], ![[file|300x200]],
 *  ![[file|alias|300]], and ![alt|300](url). Returns null when the line has
 *  no matching embed. */
export function resizeEmbed(line: string, target: string, width: number | null): string | null {
	const wiki = /!\[\[([^\]]+)\]\]/g;
	let m: RegExpExecArray | null;
	while ((m = wiki.exec(line))) {
		const parts = m[1].split("|");
		if (!sameTarget(parts[0], target)) continue;
		const kept = [parts[0], ...parts.slice(1).filter((p) => !SIZE.test(p.trim()))];
		if (width != null) kept.push(String(width));
		return line.slice(0, m.index) + `![[${kept.join("|")}]]` + line.slice(m.index + m[0].length);
	}
	const md = /!\[([^\]]*)\]\(([^)]*)\)/g;
	while ((m = md.exec(line))) {
		if (!sameTarget(m[2], target)) continue;
		const alt = m[1]
			.split("|")
			.filter((p) => !SIZE.test(p.trim()))
			.join("|");
		const next = width != null ? (alt ? `${alt}|${width}` : String(width)) : alt;
		return line.slice(0, m.index) + `![${next}](${m[2]})` + line.slice(m.index + m[0].length);
	}
	return null;
}

/** What one edit may change; an undefined field keeps what's there.
 *  width: null strips the size. alt: null strips the alias/alt. file swaps
 *  the target (pre-encode it yourself for the ![](…) form). */
export interface EmbedEdit {
	width?: number | null;
	alt?: string | null;
	file?: string;
}

/** Rewrite the embed of `target` on this line per the edit; null = no match. */
export function editEmbed(line: string, target: string, edit: EmbedEdit): string | null {
	const wiki = /!\[\[([^\]]+)\]\]/g;
	let m: RegExpExecArray | null;
	while ((m = wiki.exec(line))) {
		const parts = m[1].split("|").map((p) => p.trim());
		if (!sameTarget(parts[0], target)) continue;
		const file = edit.file !== undefined ? edit.file : parts[0];
		let alias = parts.slice(1).filter((p) => !SIZE.test(p)).join("|");
		if (edit.alt !== undefined) alias = edit.alt ?? "";
		let size = parts.slice(1).find((p) => SIZE.test(p)) ?? "";
		if (edit.width !== undefined) size = edit.width == null ? "" : String(edit.width);
		const kept = [file, ...(alias ? [alias] : []), ...(size ? [size] : [])];
		return line.slice(0, m.index) + `![[${kept.join("|")}]]` + line.slice(m.index + m[0].length);
	}
	const md = /!\[([^\]]*)\]\(([^)]*)\)/g;
	while ((m = md.exec(line))) {
		if (!sameTarget(m[2], target)) continue;
		const bits = m[1].split("|").map((p) => p.trim()).filter(Boolean);
		let alias = bits.filter((p) => !SIZE.test(p)).join("|");
		if (edit.alt !== undefined) alias = edit.alt ?? "";
		let size = bits.find((p) => SIZE.test(p)) ?? "";
		if (edit.width !== undefined) size = edit.width == null ? "" : String(edit.width);
		const src = edit.file !== undefined ? edit.file : m[2];
		const label = [alias, size].filter(Boolean).join("|");
		return line.slice(0, m.index) + `![${label}](${src})` + line.slice(m.index + m[0].length);
	}
	return null;
}

/** Read an embed's current alias/alt, width, and syntax form. */
export function embedInfo(line: string, target: string): { alt: string; width: number | null; kind: "wiki" | "md" } | null {
	const wiki = /!\[\[([^\]]+)\]\]/g;
	let m: RegExpExecArray | null;
	while ((m = wiki.exec(line))) {
		const parts = m[1].split("|").map((p) => p.trim());
		if (!sameTarget(parts[0], target)) continue;
		const size = parts.slice(1).find((p) => SIZE.test(p));
		return {
			alt: parts.slice(1).filter((p) => !SIZE.test(p)).join("|"),
			width: size ? Number(size.split("x")[0]) : null,
			kind: "wiki",
		};
	}
	const md = /!\[([^\]]*)\]\(([^)]*)\)/g;
	while ((m = md.exec(line))) {
		if (!sameTarget(m[2], target)) continue;
		const bits = m[1].split("|").map((p) => p.trim()).filter(Boolean);
		const size = bits.find((p) => SIZE.test(p));
		return {
			alt: bits.filter((p) => !SIZE.test(p)).join("|"),
			width: size ? Number(size.split("x")[0]) : null,
			kind: "md",
		};
	}
	return null;
}

/** Cut the embed out of the line entirely; null = no match. */
export function removeEmbed(line: string, target: string): string | null {
	for (const re of [/!\[\[([^\]]+)\]\]/g, /!\[([^\]]*)\]\(([^)]*)\)/g]) {
		let m: RegExpExecArray | null;
		while ((m = re.exec(line))) {
			const written = m[0].startsWith("![[") ? m[1].split("|")[0] : m[2];
			if (!sameTarget(written, target)) continue;
			return (line.slice(0, m.index) + line.slice(m.index + m[0].length)).replace(/\s{2,}/g, " ");
		}
	}
	return null;
}

/** The embed target as written vs. the src the renderer reports, equal, or
 *  equal ignoring a folder prefix / URL-encoding / a #subpath. */
function sameTarget(written: string, rendered: string): boolean {
	const a = written.trim().split("#")[0];
	const b = rendered.trim().split("#")[0];
	if (!a || !b) return false;
	if (a === b) return true;
	const an = basename(a);
	const bn = basename(b);
	return an === bn && an !== "";
}

function basename(p: string): string {
	try {
		p = decodeURIComponent(p);
	} catch {
		/* keep raw */
	}
	return p.split(/[/\\]/).pop() ?? p;
}
