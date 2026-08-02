/* An embeddable Obsidian markdown editor for tab panes: the same internal
 * editor class the app uses in notes, resolved at runtime the way Kanban and
 * Meta Bind do it. This is an internal API (not officially public), so every
 * touch point is guarded, when the shape isn't what we expect, callers get
 * null and fall back to the plain-textarea pane editor.
 *
 * What using the real editor buys inside a pane: live-preview rendering,
 * Obsidian's native list continuation and Tab indenting, the plugin's own
 * editor extensions (outline numbering, WYSIWYG hiding, heading placeholders),
 * slash commands, and, because the pane registers itself as the workspace's
 * active editor while focused, the formatting toolbar and core editor
 * commands act on the pane just like on a note. */

import { App, Editor, TFile } from "obsidian";
import { EditorView } from "@codemirror/view";

export interface PaneEditor {
	/** The pane's Obsidian Editor, for toolbar/command interop. */
	editor(): Editor | null;
	value(): string;
	hasFocus(): boolean;
	focus(): void;
	destroy(): void;
}

export interface PaneEditorOptions {
	value: string;
	/** Host note path, so links resolve and commands see a file. */
	sourcePath: string;
	/** Any document change (used for dirty tracking / deferred saves). */
	onChange(): void;
	/** Focus left the pane, a good moment to flush. */
	onBlur(): void;
	/** Escape pressed, flush and settle. */
	onEscape(): void;
}

/** Owners created by this module, so the plugin can recognize a pane editor
 *  when it shows up as workspace.activeEditor. */
const paneOwners = new WeakSet<object>();

export function isPaneOwner(o: unknown): boolean {
	return typeof o === "object" && o != null && paneOwners.has(o);
}

/** Resolve the internal embeddable markdown editor class from a throwaway
 *  markdown embed. Returns null when Obsidian's internals have moved. */
function resolveEditorClass(app: App): (new (...args: unknown[]) => Record<string, unknown>) | null {
	try {
		const registry = (app as unknown as { embedRegistry?: { embedByExtension?: Record<string, unknown> } }).embedRegistry;
		const mdEmbed = registry?.embedByExtension?.["md"];
		if (typeof mdEmbed !== "function") return null;
		const temp = (mdEmbed as (info: unknown, file: unknown, subpath: string) => Record<string, unknown>)(
			{ app, containerEl: createDiv() },
			null,
			""
		);
		if (!temp || typeof temp["showEditor"] !== "function") return null;
		temp["editable"] = true;
		(temp["showEditor"] as () => void).call(temp);
		const editMode = temp["editMode"];
		if (!editMode) return null;
		const proto = Object.getPrototypeOf(Object.getPrototypeOf(editMode)) as { constructor?: unknown } | null;
		(temp["unload"] as (() => void) | undefined)?.call(temp);
		return typeof proto?.constructor === "function" ? (proto.constructor as new (...args: unknown[]) => Record<string, unknown>) : null;
	} catch {
		return null;
	}
}

let cachedClass: (new (...args: unknown[]) => Record<string, unknown>) | null | undefined;

/** Build a live markdown editor inside `container`, or null when the internal
 *  editor can't be resolved (callers then use the textarea fallback). */
export function createPaneEditor(app: App, container: HTMLElement, opts: PaneEditorOptions): PaneEditor | null {
	try {
		if (cachedClass === undefined) cachedClass = resolveEditorClass(app);
		const EditorClass = cachedClass;
		if (!EditorClass) return null;

		const hostFile = app.vault.getAbstractFileByPath(opts.sourcePath);
		const owner: Record<string, unknown> = {
			app,
			file: hostFile instanceof TFile ? hostFile : null,
			getMode: () => "source",
			onMarkdownScroll: () => {},
			requestSave: () => {},
		};
		paneOwners.add(owner);

		// subclass so document changes surface without polling
		const PaneClass = class extends (EditorClass as new (...args: unknown[]) => Record<string, unknown>) {
			onUpdate(update: unknown, changed: boolean) {
				const base = (Object.getPrototypeOf(Object.getPrototypeOf(this)) as Record<string, unknown>)["onUpdate"];
				if (typeof base === "function") (base as (u: unknown, c: boolean) => void).call(this, update, changed);
				if (changed) opts.onChange();
			}
		};

		const ed = new PaneClass(app, container, owner) as Record<string, unknown>;
		owner["editMode"] = ed;
		Object.defineProperty(owner, "editor", {
			get: () => ed["editor"],
			configurable: true,
		});

		(ed["set"] as (text: string, clear: boolean) => void).call(ed, opts.value, true);

		const cm =
			(ed["cm"] as EditorView | undefined) ??
			((ed["editor"] as { cm?: EditorView } | undefined)?.cm as EditorView | undefined);
		if (!cm) {
			(ed["destroy"] as (() => void) | undefined)?.call(ed);
			container.empty();
			return null;
		}

		// dress the container as a source view so the plugin's WYSIWYG and
		// theme CSS apply inside the pane exactly like in a note
		container.addClass("markdown-source-view", "mod-cm6", "ped-tab-cm");

		cm.dom.addEventListener("focusin", () => {
			(app.workspace as unknown as { activeEditor: unknown }).activeEditor = owner;
		});
		cm.dom.addEventListener("focusout", () => opts.onBlur());
		cm.dom.addEventListener(
			"keydown",
			(e: KeyboardEvent) => {
				if (e.key === "Escape") {
					e.stopPropagation();
					opts.onEscape();
				}
			},
			{ capture: true }
		);

		return {
			editor: () => (ed["editor"] as Editor | undefined) ?? null,
			value: () => cm.state.doc.toString(),
			hasFocus: () => cm.hasFocus,
			focus: () => cm.focus(),
			destroy: () => {
				try {
					const ws = app.workspace as unknown as { activeEditor: unknown };
					if (ws.activeEditor === owner) ws.activeEditor = null;
					(ed["destroy"] as (() => void) | undefined)?.call(ed);
				} catch {
					/* already torn down */
				}
				container.empty();
			},
		};
	} catch {
		return null;
	}
}
