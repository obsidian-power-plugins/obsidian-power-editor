/* Pure helpers behind the Dictate button. The wire format matches Power
 * Capture's transcription calls: any OpenAI-compatible /audio/transcriptions
 * endpoint (Groq, OpenAI, self-hosted Whisper). Covered by tests.ts. */

/** Encode a multipart/form-data body by hand — Obsidian's requestUrl takes an
 *  ArrayBuffer, not FormData. */
export function buildMultipart(
	fields: Record<string, string>,
	fileField: string,
	filename: string,
	mime: string,
	file: ArrayBuffer,
	boundary = "----powereditor" + Date.now().toString(36)
): { contentType: string; body: ArrayBuffer } {
	const enc = new TextEncoder();
	const chunks: Uint8Array[] = [];
	for (const [k, v] of Object.entries(fields)) {
		chunks.push(enc.encode(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
	}
	chunks.push(
		enc.encode(
			`--${boundary}\r\nContent-Disposition: form-data; name="${fileField}"; filename="${filename}"\r\nContent-Type: ${mime}\r\n\r\n`
		)
	);
	chunks.push(new Uint8Array(file));
	chunks.push(enc.encode(`\r\n--${boundary}--\r\n`));
	const total = chunks.reduce((n, c) => n + c.byteLength, 0);
	const body = new Uint8Array(total);
	let at = 0;
	for (const c of chunks) {
		body.set(c, at);
		at += c.byteLength;
	}
	return { contentType: `multipart/form-data; boundary=${boundary}`, body: body.buffer };
}

/** Dictated text lands as its own block: in place on an empty line, otherwise
 *  after the current line with a blank line between. */
export function planDictationInsert(line: string, text: string): { atEnd: boolean; insert: string } {
	const t = text.trim();
	if (!line.trim()) return { atEnd: false, insert: t };
	return { atEnd: true, insert: "\n\n" + t };
}
