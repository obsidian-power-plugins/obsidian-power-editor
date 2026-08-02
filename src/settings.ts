/* Pure settings logic. No Obsidian imports, so it runs under Node for tests;
 * main.ts supplies the loadData/saveData glue. */

/**
 * Merge our settings over what is on disk RIGHT NOW, for a save.
 *
 * data.json is synced. Other devices write it, and a device that has been idle
 * still holds whatever it read when its plugin loaded, so writing that whole
 * object back reverts every change made anywhere else since. Settings that are
 * set once and never touched again are the casualty: nothing rewrites them
 * afterwards, so a single revert loses them for good and without a sound.
 *
 * A save may only carry the keys we changed. `baseline` is the state we last
 * read from or wrote to disk, so anything differing from it is ours: those
 * overwrite. Every untouched key takes the disk's value. A key absent from disk
 * was written by a version that did not know it, and keeps ours rather than
 * resetting to a default.
 */
export function mergeForSave<T extends object>(ours: T, baseline: T, disk: Partial<T> | null): T {
	const out = { ...ours };
	if (!disk) return out;
	for (const k of Object.keys(ours) as (keyof T)[]) {
		if (!(k in disk)) continue; // disk has never heard of this key; ours stands
		const o = ours[k];
		const b = baseline[k];
		const d = disk[k];
		if (isRecord(o) && isRecord(b) && isRecord(d)) {
			out[k] = mergeEntries(o, b, d) as T[keyof T];
			continue;
		}
		const changedByUs = JSON.stringify(o) !== JSON.stringify(b);
		if (!changedByUs) out[k] = d as T[keyof T];
	}
	return out;
}

/** A per-item map, as opposed to a value that means something whole. Arrays are
 *  values here: a list's order and membership are the thing itself. */
function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * The same three-way rule, entry by entry.
 *
 * A key holding one value per item (per folder, per field, per speaker) is a
 * whole vault's worth of settings behind a single name, and merging it whole
 * meant changing ONE of them published all of them. Every item another device
 * configured since this one last read was erased by a device that had never
 * seen it.
 *
 * Start from the disk, so anything another device set survives; drop only what
 * we deliberately removed (present in the baseline, gone from ours); then lay
 * our own changed entries over the top. Two devices editing the SAME item still
 * settles last-writer-wins, but that is one item losing a race rather than
 * everything losing it.
 */
function mergeEntries(
	ours: Record<string, unknown>,
	baseline: Record<string, unknown>,
	disk: Record<string, unknown>
): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const k of Object.keys(disk)) {
		const removedByUs = k in baseline && !(k in ours);
		if (!removedByUs) out[k] = disk[k];
	}
	for (const k of Object.keys(ours)) {
		const changedByUs = JSON.stringify(ours[k]) !== JSON.stringify(baseline[k]);
		if (changedByUs || !(k in disk)) out[k] = ours[k];
	}
	return out;
}

/**
 * Move `from` so it sits immediately before position `insertBefore`, as a
 * drag-and-drop drop expresses it.
 *
 * The subtlety is that `insertBefore` is measured against the list as the user
 * SEES it, before the dragged item is lifted out. Once it is removed, every
 * position after it shifts down by one, so dropping an item further down the
 * list needs the target decremented, miss that and every downward drag lands
 * one row short.
 */
export function moveItem<T>(list: T[], from: number, insertBefore: number): T[] {
	if (from < 0 || from >= list.length) return list.slice();
	const out = list.slice();
	const [item] = out.splice(from, 1);
	const at = Math.max(0, Math.min(out.length, from < insertBefore ? insertBefore - 1 : insertBefore));
	out.splice(at, 0, item);
	return out;
}
