import { mergeForSave, moveItem } from "./settings";
import Anthropic from "@anthropic-ai/sdk";
import { syntaxTree } from "@codemirror/language";
import { EditorSelection, EditorState, RangeSetBuilder } from "@codemirror/state";
import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate, WidgetType } from "@codemirror/view";
import {
	Editor,
	EditorPosition,
	EditorSuggest,
	FuzzySuggestModal,
	EditorSuggestContext,
	EditorSuggestTriggerInfo,
	ItemView,
	MarkdownPostProcessorContext,
	MarkdownView,
	Menu,
	MenuItem,
	Modal,
	Notice,
	Platform,
	Plugin,
	PluginSettingTab,
	Setting,
	type ExtraButtonComponent,
	type SettingDefinitionItem,
	type SettingDefinitionPage,
	type SettingDefinitionRender,
	TFile,
	TFolder,
	WorkspaceLeaf,
	htmlToMarkdown,
	requestUrl,
	setIcon,
} from "obsidian";
import {
	BlockKind,
	BlockRange,
	CalloutSpec,
	blockRangeAt,
	blockStarts,
	deleteBlock,
	duplicateBlock,
	ensureBlockId,
	guessLanguage,
	indentedTables,
	insertItemAbove,
	removeItemAt,
	isTranscriptCalloutAt,
	isTranscriptTurnAt,
	listStretchRange,
	moveBlock,
	formatFenceInfo,
	narrowEdit,
	parseFenceInfo,
	sectionRangeAt,
	stripTags,
	tableSnippet,
	transformBlock,
	unionBlockRange,
} from "./blocks";
import { cleanPastedHtml, escapePlaceholderTags, FENCE_LINE, fenceIndent, findPlaceholderTags, insideFence, isOneMarkdownTable, listContentIndent, looksLikeMarkdownTable, nextItemAfterFence, planPastedMarkdown, tabbedTextToMarkdown, textBesideMarker, type PlaceholderTag } from "./clean";
import { buildMultipart, planDictationInsert } from "./dictate";
import { editEmbed, embedInfo, removeEmbed, resizeEmbed } from "./embed";
import {
	CALLOUT_FLAVORS,
	CalloutLead,
	ColumnLayout,
	columnsSnippet,
	convertCalloutLeads,
	findCalloutLeads,
	parseColumns,
	parseTabs,
	serializeColumns,
	serializeTabs,
	setCalloutEmoji,
} from "./blocks";
import { createPaneEditor, isPaneOwner, PaneEditor } from "./paneeditor";
import {
	archiveCompleted,
	formatTodo,
	parseDatePhrase,
	parseQuery,
	parseQuickTodo,
	parseTodo,
	PRIORITY_LABELS,
	runQuery,
	setDueDate,
	setPriority,
	TodoGroup,
	TodoItem,
	toggleTodo,
} from "./tasks";
import {
	absoluteEdited,
	commentParts,
	CoverHeight,
	editedAt,
	GRADIENTS,
	GRADIENT_NAMES,
	gradientCss,
	makeComment,
	NoteComment,
	parseComments,
	parseCover,
	parseIcon,
	parsePageLayout,
	relativeEdited,
	replaceCommentText,
	SOLIDS,
	SOLID_NAMES,
	verificationState,
} from "./page";
import { MarkdownRenderChild, MarkdownRenderer } from "obsidian";
import {
	Align,
	FONT_SIZES,
	Marks,
	alignOf,
	applyMarks,
	cleanCopyText,
	clearAllFormatting,
	mdEmphasisToHtml,
	htmlEmphasisToMd,
	convertEmphasisInWrappers,
	colorBlockLine,
	continueList,
	detectMarks,
	emptyHeadingLabel,
	expandStyleRange,
	formatCounter,
	sweepHighlights,
	hasAnyMark,
	headingCursorSnap,
	headingLevel,
	isQuote,
	isBlankBlock,
	linkAt,
	markdownFromMarker,
	listKind,
	olStyleForDepth,
	olTypeForDepth,
	orderedListInfo,
	setAlign,
	setFontSize,
	setHeading,
	stripFrontmatter,
	stripFormatting,
	wrapWithMarkdown,
	toggleScript,
	wrapperAt,
} from "./format";

/** The WYSIWYG decoration engine. Three jobs, all cursor-position-independent
 *  so the note never "opens up" while editing:
 *  1. collapse the inline-HTML wrappers the toolbar writes (<u>, <span style>,
 *     <mark>) with atomic ranges, so arrow keys hop over them;
 *  2. style the wrapped content directly (underline / color / highlight)
 *     Live Preview won't render inline HTML while the cursor is inside it, so
 *     without this the formatting would vanish at the cursor;
 *  3. hide alignment markers and apply their text-align to the line. */
function wysiwygDecorations(plugin: PowerEditorPlugin) {
	interface Pending {
		from: number;
		to: number;
		deco: Decoration;
		order: number;
	}
	const WRAPPERS: [RegExp, (m: RegExpExecArray) => string][] = [
		[/<u>([\s\S]*?)<\/u>/gi, () => "text-decoration: underline"],
		[/<span style="color:\s*([^";]+)[^"]*">([\s\S]*?)<\/span>/gi, (m) => `color: ${m[1].trim()}`],
		[/<span style="font-size:\s*([^";]+)[^"]*">([\s\S]*?)<\/span>/gi, (m) => `font-size: ${m[1].trim()}`],
		[/<mark style="background:\s*([^";]+)[^"]*">([\s\S]*?)<\/mark>/gi, (m) => `background: ${m[1].trim()}`],
		[/<sub>([\s\S]*?)<\/sub>/gi, () => "vertical-align: sub; font-size: 0.8em"],
		[/<sup>([\s\S]*?)<\/sup>/gi, () => "vertical-align: super; font-size: 0.8em"],
		// bold / italic / strike stored as HTML, which is how emphasis survives
		// inside a colored highlight (Obsidian won't format ** inside inline HTML)
		[/<(strong|b)>([\s\S]*?)<\/\1>/gi, () => "font-weight: var(--font-bold, 700)"],
		[/<(em|i)>([\s\S]*?)<\/\1>/gi, () => "font-style: italic"],
		[/<(s|del)>([\s\S]*?)<\/\1>/gi, () => "text-decoration: line-through"],
	];
	return ViewPlugin.fromClass(
		class {
			decorations: DecorationSet;
			// atomic ranges cover ONLY the hidden markers, so styled inner text
			// (a highlight, a color span) stays selectable a character at a time
			atomics: DecorationSet;
			constructor(view: EditorView) {
				const r = this.build(view);
				this.decorations = r.decorations;
				this.atomics = r.atomics;
			}
			update(u: ViewUpdate) {
				if (u.docChanged || u.viewportChanged || u.selectionSet) {
					const r = this.build(u.view);
					this.decorations = r.decorations;
					this.atomics = r.atomics;
				}
			}
			private inCode(view: EditorView, at: number): boolean {
				try {
					const node = syntaxTree(view.state).resolveInner(at, 1).name.toLowerCase();
					return node.includes("code") || node.includes("math");
				} catch {
					return false;
				}
			}
			build(view: EditorView): { decorations: DecorationSet; atomics: DecorationSet } {
				if (!plugin.settings.wysiwygMarks) return { decorations: Decoration.none, atomics: Decoration.none };
				const pending: Pending[] = [];
				const hidden: [number, number][] = [];
				const hide = (from: number, to: number, order: number) => {
					hidden.push([from, to]);
					pending.push({ from, to, deco: Decoration.replace({}), order });
				};
				// Obsidian's Live Preview won't format Markdown emphasis that sits
				// inside inline HTML, so <mark>**x**</mark> shows literal ** and
				// never goes bold. The engine already owns the wrapper's inside, so
				// it renders the emphasis too: split the inner text into segments
				// (base style, plus bold / italic / strike where marked) and hide
				// the markers. All ranges stay non-overlapping and adjacent.
				const EMPH: [RegExp, number, string][] = [
					[/\*\*(?:\S|\S[^\n]*?\S)\*\*/g, 2, "font-weight:var(--font-bold,700)"],
					[/~~(?:\S|\S[^\n]*?\S)~~/g, 2, "text-decoration:line-through"],
					[/(^|[^\w*])\*(?:[^\s*]|[^\s*][^*\n]*?[^\s*])\*(?![\w*])/g, 1, "font-style:italic"],
					[/(^|[^\w_])_(?:[^\s_]|[^\s_][^_\n]*?[^\s_])_(?![\w_])/g, 1, "font-style:italic"],
				];
				const styleInner = (from: number, to: number, base: string) => {
					const inner = view.state.doc.sliceString(from, to);
					const spans: { from: number; to: number; mlen: number; style: string }[] = [];
					for (const [re, mlen, st] of EMPH) {
						re.lastIndex = 0;
						let em: RegExpExecArray | null;
						while ((em = re.exec(inner))) {
							// the italic patterns consume the character before their marker,
							// standing in for a lookbehind, so the span starts after it
							const s = from + em.index + (em[1]?.length ?? 0);
							const e = from + em.index + em[0].length;
							if (spans.some((sp) => s < sp.to && e > sp.from)) continue; // no overlap/nesting
							spans.push({ from: s, to: e, mlen, style: st });
						}
					}
					spans.sort((a, b) => a.from - b.from);
					const seg = (f: number, t: number, style: string) => {
						if (t > f) pending.push({ from: f, to: t, deco: Decoration.mark({ attributes: { style } }), order: 1 });
					};
					let cur = from;
					for (const sp of spans) {
						seg(cur, sp.from, base);
						hide(sp.from, sp.from + sp.mlen, 1);
						seg(sp.from + sp.mlen, sp.to - sp.mlen, `${base};${sp.style}`);
						hide(sp.to - sp.mlen, sp.to, 1);
						cur = sp.to;
					}
					seg(cur, to, base);
				};
				for (const range of view.visibleRanges) {
					const text = view.state.doc.sliceString(range.from, range.to);
					// paired wrappers: hide both tags, style the inside live
					for (const [re, style] of WRAPPERS) {
						re.lastIndex = 0;
						let m: RegExpExecArray | null;
						while ((m = re.exec(text))) {
							const start = range.from + m.index;
							if (this.inCode(view, start)) continue;
							const openEnd = start + m[0].indexOf(">") + 1;
							const closeStart = start + m[0].length - (m[0].length - m[0].lastIndexOf("<"));
							hide(start, openEnd, 0);
							if (closeStart > openEnd) styleInner(openEnd, closeStart, style(m));
							hide(closeStart, start + m[0].length, 0);
						}
					}
					// alignment markers: hide the comment, align the whole line
					const al = /<!--al:(center|right)-->/g;
					let am: RegExpExecArray | null;
					while ((am = al.exec(text))) {
						const start = range.from + am.index;
						if (this.inCode(view, start)) continue;
						hide(start, start + am[0].length, 0);
						const line = view.state.doc.lineAt(start);
						pending.push({
							from: line.from,
							to: line.from,
							deco: Decoration.line({ attributes: { style: `text-align: ${am[1]}` } }),
							order: -1,
						});
					}
					// any stray wrapper tags not consumed by a pair still hide
					const stray = /<\/?(?:strong|span|mark|sub|sup|del|em|u|b|i|s)(?:\s[^>]*)?>/gi;
					let sm: RegExpExecArray | null;
					while ((sm = stray.exec(text))) {
						const start = range.from + sm.index;
						const end = start + sm[0].length;
						if (hidden.some(([f, t]) => start >= f && end <= t)) continue;
						if (this.inCode(view, start)) continue;
						hide(start, end, 0);
					}
				}
				pending.sort((a, b) => a.from - b.from || a.order - b.order || a.to - b.to);
				const b = new RangeSetBuilder<Decoration>();
				let lastFrom = -1;
				let lastTo = -1;
				for (const p of pending) {
					if (p.from === lastFrom && p.to === lastTo && p.order === 0) continue; // dedupe double-hides
					b.add(p.from, p.to, p.deco);
					lastFrom = p.from;
					lastTo = p.to;
				}
				// atomics = just the hidden marker spans (arrow keys hop them);
				// the inner style marks are deliberately left out so a highlight
				// can be selected part of a word at a time
				const ab = new RangeSetBuilder<Decoration>();
				let atEnd = -1;
				for (const [f, t] of hidden.sort((x, y) => x[0] - y[0] || x[1] - y[1])) {
					if (t <= f || f < atEnd) continue; // skip empties and any overlap
					ab.add(f, t, Decoration.replace({}));
					atEnd = t;
				}
				return { decorations: b.finish(), atomics: ab.finish() };
			}
		},
		{
			decorations: (v) => v.decorations,
			provide: (p) => EditorView.atomicRanges.of((view) => view.plugin(p)?.atomics ?? Decoration.none),
		}
	);
}

/** Word-style multilevel numbering. Nested ordered-list numbers are
 *  restyled per a per-depth config (1 → a → i …). Live Preview shows the
 *  number as literal text, so we replace just the digits with a widget; the
 *  raw number is revealed on the active line so editing/renumbering is normal.
 *  Depth-0 decimal items are left entirely alone. Reading view is handled
 *  separately with CSS list-style-type (see applyOutlineCss). */
function orderedListOutline(plugin: PowerEditorPlugin) {
	class NumWidget extends WidgetType {
		constructor(private text: string) {
			super();
		}
		eq(other: NumWidget) {
			return other.text === this.text;
		}
		toDOM() {
			return createSpan({ cls: "ped-ol-num", text: this.text });
		}
	}
	return ViewPlugin.fromClass(
		class {
			decorations: DecorationSet;
			constructor(view: EditorView) {
				this.decorations = this.build(view);
			}
			update(u: ViewUpdate) {
				if (u.docChanged || u.viewportChanged || u.selectionSet) this.decorations = this.build(u.view);
			}
			build(view: EditorView): DecorationSet {
				const b = new RangeSetBuilder<Decoration>();
				if (!plugin.settings.numberedOutline) return b.finish();
				const styles = plugin.settings.outlineStyles;
				for (const range of view.visibleRanges) {
					let pos = range.from;
					while (pos <= range.to) {
						const line = view.state.doc.lineAt(pos);
						const info = orderedListInfo(line.text);
						if (info) {
							const style = styles[Math.min(info.depth, styles.length - 1)] ?? "decimal";
							// leave decimal levels as the literal number; other levels show
							// the styled counter ALWAYS (even on the active line) so it never
							// flips back to a digit while you're typing into the item
							if (style !== "decimal") {
								// replace the digits AND the delimiter as one unit, so the
								// letter and its "." sit flush (Word-style) instead of the
								// "." keeping the wide digit-alignment cell's spacing
								b.add(
									line.from + info.numStart,
									line.from + info.numEnd + 1,
									Decoration.replace({ widget: new NumWidget(formatCounter(info.ordinal, style) + info.delim) })
								);
							}
						}
						pos = line.to + 1;
					}
				}
				return b.finish();
			}
		},
		{ decorations: (v) => v.decorations }
	);
}

/** Keep a task's checkbox rendered even on the line you are editing. Obsidian's
 *  Live Preview reveals the raw `- [ ]` on the active line (most visible when a
 *  note opens with a task on the first line and the cursor lands there), which
 *  reads as a broken checkbox. Off the active line Obsidian draws the box
 *  itself, so this only fills the active line, where Obsidian shows none, no
 *  double box. The rendered input carries Obsidian's own task-checkbox class,
 *  so the existing capture-phase click handler toggles it like any other. */
function liveTaskCheckbox(plugin: PowerEditorPlugin) {
	class BoxWidget extends WidgetType {
		constructor(
			private checked: boolean,
			private mark: string
		) {
			super();
		}
		eq(o: BoxWidget) {
			return o.checked === this.checked && o.mark === this.mark;
		}
		toDOM() {
			// mirror Obsidian's own editor checkbox DOM (label > input, both with
			// its classes) so its task-list-label CSS aligns ours to the others
			const label = createEl("label", { cls: "task-list-label ped-live-task" });
			const box = label.createEl("input", { cls: "task-list-item-checkbox", attr: { type: "checkbox", "data-task": this.mark } });
			box.checked = this.checked;
			return label;
		}
	}
	return ViewPlugin.fromClass(
		class {
			decorations: DecorationSet;
			constructor(view: EditorView) {
				this.decorations = this.build(view);
			}
			update(u: ViewUpdate) {
				if (u.docChanged || u.viewportChanged || u.selectionSet) this.decorations = this.build(u.view);
			}
			build(view: EditorView): DecorationSet {
				const b = new RangeSetBuilder<Decoration>();
				if (!plugin.settings.liveCheckboxes) return b.finish();
				const sel = view.state.selection;
				for (const range of view.visibleRanges) {
					let pos = range.from;
					while (pos <= range.to) {
						const line = view.state.doc.lineAt(pos);
						// stop at the "]"; the space after it is Obsidian's gap between
						// box and text, and off the active line Obsidian keeps it, so we
						// must too or the text sits a space closer while editing the line
						const m = line.text.match(/^(\s*)(?:[-*+]|\d+[.)])\s+\[(.)\](?=\s|$)/);
						const active = sel.ranges.some((r) => r.from <= line.to && r.to >= line.from);
						if (m && active) {
							b.add(
								line.from + m[1].length,
								line.from + m[0].length,
								Decoration.replace({ widget: new BoxWidget(m[2] !== " ", m[2]) })
							);
						}
						pos = line.to + 1;
					}
				}
				return b.finish();
			}
		},
		{ decorations: (v) => v.decorations }
	);
}

/** Inline comments: each %%💬 …%% marker renders as a small chip; the cursor
 *  entering the marker reveals the plain source. Clicking the chip opens the
 *  read/edit/resolve popover. Reading view never shows the marker at all
 *  (Obsidian strips %% comments%%), which matches "comments don't print". */
function commentChips(plugin: PowerEditorPlugin) {
	class ChipWidget extends WidgetType {
		constructor(
			private text: string,
			private stamp: string | null
		) {
			super();
		}
		eq(other: ChipWidget) {
			return other.text === this.text && other.stamp === this.stamp;
		}
		toDOM(view: EditorView) {
			const el = createSpan({ cls: "ped-comment-chip", attr: { "aria-label": this.text } });
			setIcon(el, "message-circle");
			el.addEventListener("mousedown", (e) => {
				e.preventDefault();
				e.stopPropagation();
				plugin.openCommentPopover(view, el);
			});
			return el;
		}
		ignoreEvent() {
			return true;
		}
	}
	return ViewPlugin.fromClass(
		class {
			decorations: DecorationSet;
			constructor(view: EditorView) {
				this.decorations = this.build(view);
			}
			update(u: ViewUpdate) {
				if (u.docChanged || u.viewportChanged || u.selectionSet) this.decorations = this.build(u.view);
			}
			build(view: EditorView): DecorationSet {
				const b = new RangeSetBuilder<Decoration>();
				const sel = view.state.selection.main;
				for (const range of view.visibleRanges) {
					const text = view.state.doc.sliceString(range.from, range.to);
					const re = /%%💬\s*(.*?)%%/g;
					let m: RegExpExecArray | null;
					while ((m = re.exec(text))) {
						const from = range.from + m.index;
						const to = from + m[0].length;
						if (sel.from <= to && sel.to >= from) continue;
						const parts = commentParts(m[1]);
						b.add(from, to, Decoration.replace({ widget: new ChipWidget(parts.text, parts.stamp) }));
					}
				}
				return b.finish();
			}
		},
		{ decorations: (v) => v.decorations }
	);
}

interface PowerEditorSettings {
	showToolbar: boolean;
	showOnMobile: boolean;
	blockHandles: boolean;
	showBubble: boolean;
	cleanPaste: boolean;
	/** How copied text lands in other apps: strip the toolbar's highlight/color
	 *  HTML ("clean", keeps Markdown), strip all formatting ("plain"), or leave
	 *  Obsidian's copy alone ("off"). */
	copyMode: "clean" | "plain" | "off";
	headingSections: boolean;
	hiddenButtons: string[];
	/** Toolbar order, "|" for a divider. Empty means the built-in order, so a
	 *  button added in a later version still lands where it was designed to. */
	buttonOrder: string[];
	anthropicKey: string;
	aiModel: string;
	/** Dictation's own transcription endpoint. Empty borrows Power Assistant's,
	 *  so a vault running both needs no second setup, but dictation does not
	 *  depend on that plugin being installed. */
	transcriptionEndpoint: string;
	transcriptionKey: string;
	transcriptionModel: string;
	wysiwygMarks: boolean;
	liveCheckboxes: boolean;
	aiActions: { name: string; prompt: string }[];
	dictationMode: "raw" | "tidy" | "bullets";
	lineSpacing: "compact" | "normal" | "relaxed";
	/** Height, in px, of the blank line between a heading and what follows it.
	 *  "off" leaves Obsidian's full line-height alone. Any other value is a px
	 *  number as a string, so the dropdown's presets and a hand-typed override
	 *  share one path. */
	headingGap: string;
	/** Ordinary Ctrl+C also puts rich text on the clipboard, so a copy pasted
	 *  into mail arrives formatted. The Markdown rides inside that HTML, so a
	 *  paste back into Obsidian is still the Markdown that was copied. */
	richCopy: boolean;
	/** Drop the vertical indent guide from numbered lists, editing and reading
	 *  views. A numbered list already shows its nesting through the numbering
	 *  itself; bullets keep theirs, having nothing else to show it with. */
	/** Which lists lose Obsidian's vertical indent rule: none, numbered
	 *  lists only, or every list. Was a boolean meaning "numbered only". */
	indentGuides: "all" | "no-ordered" | "none";
	/** The "Edited 3 minutes ago" line. "labeled" carries the word Edited,
	 *  "bare" is the time alone, "off" hides it. */
	showEdited: "off" | "labeled" | "bare";
	/** Under the note's title, at the end of the note, or both. "rule" is the
	 *  title placement pulled tight to the title with a hairline between the
	 *  two, so the pair reads as one page header. */
	editedPosition: "title" | "rule" | "bottom" | "both";
	/** "3 minutes ago", the full date, or the relative time with the date
	 *  after it. Clicking the stamp shows both whatever this is set to. */
	editedFormat: "relative" | "exact" | "both";
	/** Which syntax palette fenced code blocks use. "default" leaves them to
	 *  your Obsidian theme; the rest are real editor themes, four of them dark
	 *  the way Claude and ChatGPT render code. */
	codeTheme: "default" | "vivid" | "one-dark" | "dracula" | "monokai" | "github-dark";
	/** Line numbers down the left of a fenced block, the way Claude and GitHub
	 *  show them. */
	codeLineNumbers: boolean;
	/** The same, for the blank lines on either side of a table (Markdown needs
	 *  both, so neither can simply be deleted). Separate from headingGap
	 *  because a table wants different breathing room than a heading. */
	tableGap: string;
	recentEmoji: string[];
	/** The quick-capture mobile toolbar (legacy key name, kept so saved settings survive). */
	onenoteMobileToolbar: boolean;
	/** The user's own mobile toolbar arrangement, restored on toggle-off.
	 *  Superseded by the localStorage copy (see TOOLBAR_BACKUP_KEY): this key
	 *  stays so a device that saved one here before still restores it, and so
	 *  turning the toolbar off clears it. Nothing writes it any more. */
	mobileToolbarBackup: string[] | null;
	stampDoneDates: boolean;
	inboxNote: string;
	todoReminders: boolean;
	numberedOutline: boolean;
	/** Number style per nesting level (index 0 = top level). Names are CSS
	 *  list-style-type values: decimal, lower-alpha, upper-alpha, lower-roman,
	 *  upper-roman. */
	outlineStyles: string[];
}

const DEFAULT_SETTINGS: PowerEditorSettings = {
	showToolbar: true,
	showOnMobile: false,
	blockHandles: true,
	showBubble: true,
	cleanPaste: true,
	copyMode: "clean",
	headingSections: true,
	hiddenButtons: [],
	buttonOrder: [],
	anthropicKey: "",
	aiModel: "claude-haiku-4-5",
	transcriptionEndpoint: "",
	transcriptionKey: "",
	transcriptionModel: "",
	wysiwygMarks: true,
	liveCheckboxes: true,
	aiActions: [],
	dictationMode: "raw",
	lineSpacing: "normal",
	headingGap: "12",
	richCopy: true,
	indentGuides: "no-ordered",
	showEdited: "labeled",
	editedPosition: "title",
	editedFormat: "relative",
	codeTheme: "vivid",
	codeLineNumbers: true,
	tableGap: "12",
	recentEmoji: [],
	onenoteMobileToolbar: true,
	mobileToolbarBackup: null,
	stampDoneDates: true,
	inboxNote: "Inbox.md",
	todoReminders: true,
	numberedOutline: true,
	// Word-style cascade: 1. → a. → i. → 1. → a. → i.
	outlineStyles: ["decimal", "lower-alpha", "lower-roman", "decimal", "lower-alpha", "lower-roman"],
};

const OUTLINE_CHOICES: [string, string][] = [
	["decimal", "1, 2, 3"],
	["lower-alpha", "a, b, c"],
	["upper-alpha", "A, B, C"],
	["lower-roman", "i, ii, iii"],
	["upper-roman", "I, II, III"],
];

/** Today as a local YYYY-MM-DD string. */
const todayStr = () => {
	const d = new Date();
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

const isoAddDays = (iso: string, n: number) => {
	const [y, m, d] = iso.split("-").map(Number);
	const t = new Date(y, m - 1, d + n);
	return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`;
};

const mondayOf = (iso: string) => {
	const [y, m, d] = iso.split("-").map(Number);
	const dow = new Date(y, m - 1, d).getDay();
	return isoAddDays(iso, dow === 0 ? -6 : 1 - dow);
};

/** The quick-capture mobile bar, left to right: photo, dictate, to-do,
 *  bullets, numbers, outdent, indent, bold, hide keyboard. Swapped into
 *  Obsidian's own above-keyboard toolbar, which handles the docking. */
const MOBILE_TOOLBAR = [
	"powereditor:insert-photo",
	"powereditor:dictate",
	"editor:toggle-checklist-status",
	"powereditor:todo-capture",
	"editor:toggle-bullet-list",
	"editor:toggle-numbered-list",
	"powereditor:indent-less",
	"powereditor:indent-more",
	"editor:toggle-bold",
	"powereditor:dismiss-keyboard",
];

const TODAY_VIEW = "ped-today";
const COMMENTS_VIEW = "ped-comments-view";
// Hardcoded so it reflects the RUNNING code, not the on-disk manifest (which a
// stale/cached plugin module would still report as current). Bump every build.
const PED_BUILD = "1.54.0";

/** Every toolbar button, for the visibility settings. */
const BUTTON_IDS: [string, string][] = [
	["undo", "Undo"],
	["redo", "Redo"],
	["heading", "Paragraph style"],
	["bold", "Bold"],
	["italic", "Italic"],
	["underline", "Underline"],
	["strike", "Strikethrough"],
	["highlight", "Highlight"],
	["code", "Inline code"],
	["color", "Text color"],
	["fontsize", "Font size, sub & superscript"],
	["painter", "Format painter"],
	["emoji", "Emoji"],
	["bullet", "Bulleted list"],
	["ordered", "Numbered list"],
	["task", "Checklist"],
	["quote", "Quote"],
	["callout", "Callout (tip, note, warning…)"],
	["toggle", "Toggle block (collapsible)"],
	["align", "Text alignment"],
	["indent", "Increase indent"],
	["outdent", "Decrease indent"],
	["link", "Insert link"],
	["codeblock", "Code block"],
	["table", "Insert table"],
	["hr", "Horizontal rule"],
	["findreplace", "Find & replace"],
	["dictate", "Dictate (speech to text)"],
	["ai", "AI edit"],
	["clear", "Clear formatting"],
];

/** The toolbar's out-of-the-box order, dividers included. "|" is a divider
 *  rather than a button: it can be moved, added and removed like anything
 *  else, which is the only way grouping survives a custom order. */
const DEFAULT_BUTTON_ORDER: string[] = [
	"undo", "redo", "|",
	"heading", "|",
	"bold", "italic", "underline", "strike", "highlight", "code", "color", "fontsize", "painter", "emoji", "|",
	"bullet", "ordered", "task", "quote", "callout", "toggle", "|",
	"align", "indent", "outdent", "|",
	"link", "codeblock", "table", "hr", "findreplace", "|",
	"dictate", "ai", "clear",
];


/** Curated, searchable-by-name emoji set (the system picker still exists for
 *  the long tail, this covers what notes actually use). */
const EMOJI: [string, string][] = [
	["😀", "grinning smile happy"], ["😁", "beaming grin"], ["😂", "joy laughing tears"], ["🤣", "rofl laughing"],
	["😊", "smiling blush"], ["😉", "wink"], ["😍", "heart eyes love"], ["😘", "kiss"], ["😎", "cool sunglasses"],
	["🤔", "thinking hmm"], ["🤨", "raised eyebrow skeptical"], ["😐", "neutral meh"], ["😴", "sleeping tired"],
	["😢", "crying sad tear"], ["😭", "sobbing crying"], ["😡", "angry mad"], ["🤯", "mind blown"], ["🥳", "party celebrate"],
	["😇", "halo innocent"], ["🙃", "upside down silly"], ["😬", "grimace awkward"], ["🫡", "salute"],
	["👍", "thumbs up yes good"], ["👎", "thumbs down no"], ["👏", "clap applause"], ["🙌", "raised hands hooray"],
	["🙏", "please thanks pray"], ["💪", "strong muscle"], ["👋", "wave hello bye"], ["🤝", "handshake deal"],
	["🤞", "fingers crossed"], ["👉", "point right"], ["👈", "point left"], ["☝️", "point up"], ["👀", "eyes looking"],
	["🧠", "brain smart"], ["❤️", "red heart love"], ["💙", "blue heart"], ["💚", "green heart"], ["💛", "yellow heart"],
	["🧡", "orange heart"], ["💜", "purple heart"], ["🖤", "black heart"], ["💔", "broken heart"], ["💯", "hundred percent"],
	["✅", "check done yes"], ["☑️", "checkbox ballot"], ["✔️", "check mark"], ["❌", "cross no wrong"], ["⚠️", "warning caution"],
	["❗", "exclamation important"], ["❓", "question"], ["💡", "idea lightbulb"], ["⭐", "star favorite"], ["🌟", "glowing star"],
	["🔥", "fire hot lit"], ["🎉", "tada party celebrate"], ["🎊", "confetti"], ["🏆", "trophy winner"], ["🥇", "gold first"],
	["🥈", "silver second"], ["🥉", "bronze third"], ["🎯", "target goal dart"], ["🚀", "rocket launch ship"],
	["📌", "pin pushpin"], ["📍", "location pin map"], ["🔖", "bookmark"], ["🏷️", "tag label"], ["📎", "paperclip attach"],
	["🔗", "link chain url"], ["📅", "calendar date"], ["🗓️", "calendar spiral"], ["⏰", "alarm clock"], ["⌛", "hourglass done"],
	["⏳", "hourglass waiting"], ["🕒", "clock time"], ["📝", "memo note writing"], ["✏️", "pencil edit"], ["🖊️", "pen"],
	["📄", "document page"], ["📑", "bookmark tabs pages"], ["📁", "folder"], ["📂", "open folder"], ["🗂️", "card index dividers"],
	["📋", "clipboard"], ["🗃️", "card file box archive"], ["📊", "bar chart stats"], ["📈", "chart up growth increase"],
	["📉", "chart down decrease"], ["🧮", "abacus calculate"], ["💰", "money bag"], ["💵", "dollar cash"],
	["💳", "credit card payment"], ["🧾", "receipt invoice"], ["🏦", "bank"], ["🛒", "shopping cart"], ["📦", "package box"],
	["🚚", "truck delivery shipping"], ["✈️", "airplane travel flight"], ["🚗", "car drive"], ["🏠", "house home"],
	["🏢", "office building company"], ["🏭", "factory plant"], ["🌍", "globe world earth"], ["🗺️", "world map"],
	["🧭", "compass direction"], ["☀️", "sun sunny"], ["🌙", "moon night"], ["⛅", "partly cloudy"], ["🌧️", "rain"],
	["⛈️", "storm thunder"], ["❄️", "snow cold"], ["🌈", "rainbow"], ["💧", "droplet water"], ["⚡", "lightning zap power"],
	["🍀", "clover luck"], ["🌱", "seedling growth"], ["🌲", "tree evergreen"], ["🌸", "blossom flower"],
	["🍎", "apple fruit"], ["☕", "coffee tea cup"], ["🍕", "pizza"], ["🍔", "burger"], ["🍺", "beer"], ["🍷", "wine"],
	["🎂", "birthday cake"], ["🍿", "popcorn"], ["⚽", "soccer football"], ["🏀", "basketball"], ["🏈", "american football"],
	["⚾", "baseball"], ["🎾", "tennis"], ["🎮", "game controller"], ["🎵", "music note"], ["🎶", "music notes"],
	["🎤", "microphone sing"], ["🎧", "headphones audio"], ["📷", "camera photo"], ["🎬", "clapper movie video"],
	["📺", "tv television"], ["💻", "laptop computer"], ["🖥️", "desktop computer"], ["⌨️", "keyboard"], ["🖱️", "mouse"],
	["📱", "phone mobile"], ["☎️", "telephone call"], ["🔋", "battery"], ["🔌", "plug power"], ["🛠️", "tools hammer wrench"],
	["🔧", "wrench fix"], ["🔨", "hammer build"], ["⚙️", "gear settings"], ["🧰", "toolbox"], ["🧲", "magnet"],
	["🔒", "lock secure private"], ["🔓", "unlocked open"], ["🔑", "key password"], ["🛡️", "shield security"],
	["🐛", "bug insect"], ["🤖", "robot ai bot"], ["💬", "speech bubble chat comment"], ["💭", "thought bubble"],
	["📣", "megaphone announce"], ["🔔", "bell notification"], ["🔕", "bell off mute"], ["🛑", "stop sign"],
	["🚧", "construction wip barrier"], ["♻️", "recycle"], ["➡️", "arrow right next"], ["⬅️", "arrow left back"],
	["⬆️", "arrow up"], ["⬇️", "arrow down"], ["↔️", "arrow left right"], ["🔄", "refresh sync repeat"],
	["➕", "plus add"], ["➖", "minus remove"], ["✖️", "multiply times"], ["➗", "divide"],
	["🔴", "red circle"], ["🟠", "orange circle"], ["🟡", "yellow circle"], ["🟢", "green circle"], ["🔵", "blue circle"],
	["🟣", "purple circle"], ["⚫", "black circle"], ["⚪", "white circle"], ["🟥", "red square"], ["🟧", "orange square"],
	["🟨", "yellow square"], ["🟩", "green square"], ["🟦", "blue square"], ["🟪", "purple square"], ["⬛", "black square"],
	["⬜", "white square"],
];

/** Hide the `[!type]` token on callout headers even at the cursor, so the
 *  header reads "> ❓ Title" while editing (cursor-independent, atomic, same
 *  philosophy as the WYSIWYG engine; follows the ped-wys toggle). */
/** A table that sits inside a list step, drawn. Obsidian's Live Preview only
 *  draws a table that starts at the left margin, so one written into a step
 *  stays a grid of pipes on screen no matter how correct it is. The rows are
 *  handed to Obsidian's own renderer with the step's indent taken off, so it
 *  comes out as the table the theme draws everywhere else. */
class ListTableWidget extends WidgetType {
	constructor(
		private md: string,
		private indent: string,
		private plugin: PowerEditorPlugin,
		private at: number
	) {
		super();
	}

	eq(other: ListTableWidget) {
		return other.md === this.md && other.indent === this.indent;
	}

	toDOM(view: EditorView) {
		const host = createDiv({ cls: "ped-list-table" });
		// the indent itself, written out rather than measured: the same
		// characters in the same font put the table under the step's words
		// however the theme happens to draw them
		host.createSpan({ cls: "ped-list-table-pad", text: this.indent });
		const body = host.createDiv({ cls: "ped-list-table-body" });
		const child = new MarkdownRenderChild(body);
		this.plugin.addChild(child);
		void MarkdownRenderer.render(this.plugin.app, this.md, body, this.plugin.app.workspace.getActiveFile()?.path ?? "", child);
		// clicking it asks for the source, the way Live Preview hands any block
		// back when the cursor lands in it
		host.addEventListener("mousedown", (e) => {
			e.preventDefault();
			view.dispatch({ selection: { anchor: this.at }, scrollIntoView: true });
			view.focus();
		});
		return host;
	}

	ignoreEvent() {
		return false;
	}
}

/** The tables inside list steps, drawn while the cursor is elsewhere. */
const listTables = (plugin: PowerEditorPlugin) =>
	ViewPlugin.fromClass(
		class {
			deco: DecorationSet;

			constructor(view: EditorView) {
				this.deco = this.build(view);
			}

			update(u: ViewUpdate) {
				if (u.docChanged || u.viewportChanged || u.selectionSet) this.deco = this.build(u.view);
			}

			build(view: EditorView): DecorationSet {
				const b = new RangeSetBuilder<Decoration>();
				const doc = view.state.doc;
				const lines = doc.toString().split("\n");
				const sel = view.state.selection.main;
				for (const t of indentedTables(lines)) {
					const from = doc.line(t.from + 1).from;
					const to = doc.line(t.to + 1).to;
					// the cursor inside it means it is being edited, and text is
					// what can be edited
					if (sel.to >= from && sel.from <= to) continue;
					const md = lines
						.slice(t.from, t.to + 1)
						.map((l) => (l.startsWith(t.indent) ? l.slice(t.indent.length) : l.trimStart()))
						.join("\n");
					b.add(from, to, Decoration.replace({ widget: new ListTableWidget(md, t.indent, plugin, from), block: true }));
				}
				return b.finish();
			}
		},
		{ decorations: (v) => v.deco }
	);

const calloutTokenHider = ViewPlugin.fromClass(
	class {
		deco: DecorationSet;

		constructor(view: EditorView) {
			this.deco = this.build(view);
		}

		update(u: ViewUpdate) {
			if (u.docChanged || u.viewportChanged) this.deco = this.build(u.view);
		}

		build(view: EditorView): DecorationSet {
			const b = new RangeSetBuilder<Decoration>();
			if (!document.body.hasClass("ped-wys")) return b.finish();
			for (const { from, to } of view.visibleRanges) {
				let pos = from;
				while (pos <= to) {
					const line = view.state.doc.lineAt(pos);
					const m = /^(\s*>\s*)(\[!\w+\][+-]?)( ?)/.exec(line.text);
					if (m) {
						const s = line.from + m[1].length;
						b.add(s, s + m[2].length + m[3].length, Decoration.replace({}));
					}
					pos = line.to + 1;
				}
			}
			return b.finish();
		}
	},
	{
		decorations: (v) => v.deco,
		provide: (p) => EditorView.atomicRanges.of((view) => view.plugin(p)?.deco ?? Decoration.none),
	}
);

/** Everything the picker offers, value first (what goes after the fence),
 *  then the label. Ordered roughly by how often a note actually needs it,
 *  because the list is searchable and the top of it should be useful. */
const CODE_LANGS: [string, string][] = [
	["", "Plain text"],
	["bash", "Bash / Shell"],
	["powershell", "PowerShell"],
	["javascript", "JavaScript"],
	["typescript", "TypeScript"],
	["python", "Python"],
	["sql", "SQL"],
	["json", "JSON"],
	["yaml", "YAML"],
	["html", "HTML"],
	["css", "CSS"],
	["markdown", "Markdown"],
	["csharp", "C#"],
	["java", "Java"],
	["go", "Go"],
	["rust", "Rust"],
	["php", "PHP"],
	["ruby", "Ruby"],
	["swift", "Swift"],
	["kotlin", "Kotlin"],
	["c", "C"],
	["cpp", "C++"],
	["objectivec", "Objective-C"],
	["scala", "Scala"],
	["r", "R"],
	["perl", "Perl"],
	["lua", "Lua"],
	["dart", "Dart"],
	["elixir", "Elixir"],
	["erlang", "Erlang"],
	["haskell", "Haskell"],
	["clojure", "Clojure"],
	["fsharp", "F#"],
	["groovy", "Groovy"],
	["julia", "Julia"],
	["matlab", "MATLAB"],
	["vbnet", "VB.NET"],
	["vba", "VBA"],
	["xml", "XML"],
	["toml", "TOML"],
	["ini", "INI"],
	["diff", "Diff"],
	["dockerfile", "Dockerfile"],
	["makefile", "Makefile"],
	["nginx", "Nginx"],
	["apache", "Apache"],
	["graphql", "GraphQL"],
	["scss", "SCSS"],
	["less", "Less"],
	["jsx", "JSX"],
	["tsx", "TSX"],
	["vue", "Vue"],
	["svelte", "Svelte"],
	["latex", "LaTeX"],
	["bibtex", "BibTeX"],
	["asm", "Assembly"],
	["verilog", "Verilog"],
	["vhdl", "VHDL"],
	["solidity", "Solidity"],
	["protobuf", "Protocol Buffers"],
	["csv", "CSV"],
	["plaintext", "Plain text (explicit)"],
];

/** Pretty names for the chip on a fenced block, so `js` reads as JavaScript. */
const LANG_LABEL: Record<string, string> = {
	bash: "Bash",
	sh: "Shell",
	shell: "Shell",
	zsh: "Zsh",
	powershell: "PowerShell",
	ps1: "PowerShell",
	js: "JavaScript",
	javascript: "JavaScript",
	ts: "TypeScript",
	typescript: "TypeScript",
	py: "Python",
	python: "Python",
	sql: "SQL",
	json: "JSON",
	yaml: "YAML",
	yml: "YAML",
	html: "HTML",
	css: "CSS",
	md: "Markdown",
	markdown: "Markdown",
	csharp: "C#",
	cs: "C#",
	cpp: "C++",
	go: "Go",
	rust: "Rust",
	java: "Java",
	php: "PHP",
	ruby: "Ruby",
	xml: "XML",
	diff: "Diff",
};

class CopyCodeWidget extends WidgetType {
	constructor(private code: string) {
		super();
	}

	eq(other: CopyCodeWidget) {
		return other.code === this.code;
	}

	toDOM() {
		const b = document.createElement("button");
		b.className = "ped-cb-copy";
		b.setAttribute("aria-label", "Copy code");
		b.textContent = "Copy";
		b.onmousedown = (e) => e.preventDefault(); // keep the editor's selection
		b.onclick = (e) => {
			e.preventDefault();
			e.stopPropagation();
			void navigator.clipboard.writeText(this.code).then(
				() => {
					b.textContent = "Copied";
					b.addClass("is-done");
					window.setTimeout(() => {
						b.textContent = "Copy";
						b.removeClass("is-done");
					}, 1400);
				},
				() => new Notice("Could not copy to the clipboard.")
			);
		};
		return b;
	}

	ignoreEvent() {
		return false;
	}
}

/** The lines the selection touches, as a key that changes only when it moves
 *  to another line. */
const selLines = (state: EditorState): string => {
	const s = state.selection.main;
	return `${state.doc.lineAt(s.from).number}:${state.doc.lineAt(s.to).number}`;
};

/** The card's left padding, on a fence that opens on a step's own line. The
 *  step's number has to stay in the list's column, so the line cannot be pushed
 *  in as a whole; this stands between the number and the fence instead, which
 *  puts the fence where the code below it starts. */
class CardPadWidget extends WidgetType {
	eq() {
		return true;
	}

	toDOM() {
		const s = document.createElement("span");
		s.className = "ped-cb-pad";
		return s;
	}
}

/** The filename on a fence, shown at the left of the header the way Claude
 *  labels a file. Click to rename; empty until you give it one. */
class FileNameWidget extends WidgetType {
	constructor(
		private line: number,
		private name: string
	) {
		super();
	}

	eq(other: FileNameWidget) {
		return other.line === this.line && other.name === this.name;
	}

	toDOM() {
		const b = document.createElement("button");
		b.className = "ped-cb-file" + (this.name ? "" : " is-empty");
		b.setAttribute("aria-label", this.name ? "Rename file" : "Name this block");
		b.setAttribute("data-ped-line", String(this.line));
		b.textContent = this.name || "Add a name";
		b.onmousedown = (e) => e.preventDefault();
		return b;
	}

	ignoreEvent() {
		return false;
	}
}

/** The language name on a fence, as a button. Always present, so a block that
 *  already has a language can be changed as easily as one that has none
 *  which is also why Obsidian's own `code-block-flair` label is hidden in CSS,
 *  since two labels for the same thing is what made them collide. */
class LangButtonWidget extends WidgetType {
	constructor(
		private line: number,
		private label: string
	) {
		super();
	}

	eq(other: LangButtonWidget) {
		return other.line === this.line && other.label === this.label;
	}

	toDOM() {
		const b = document.createElement("button");
		b.className = "ped-cb-lang";
		b.setAttribute("aria-label", "Change language");
		b.setAttribute("data-ped-line", String(this.line));
		b.textContent = this.label;
		const caret = b.appendChild(document.createElement("span"));
		caret.className = "ped-cb-caret";
		caret.textContent = "⌄";
		b.onmousedown = (e) => e.preventDefault();
		return b;
	}

	ignoreEvent() {
		return false;
	}
}

/** Fenced code blocks as cards: the opening fence carries the language name
 *  and a Copy button. Both hang off the fence line as decorations, so the
 *  document is untouched and the block stays plain Markdown. */
const codeBlockChrome = ViewPlugin.fromClass(
	class {
		deco: DecorationSet;
		/** Blocks that sit inside a list step, for the measuring pass. */
		insets: { start: number; end: number; markerPos: number; stepMarkerPos: number; stepTextPos: number }[] = [];

		/** The lines the selection is on, since a fence hides itself unless the
		 *  cursor is on that line. Rebuilding on every selection change would
		 *  rescan the note for a cursor that only moved along a line. */
		onLines = "";
		/** What the last measurement found, by opening line. The decorations
		 *  carry it, so a line CodeMirror redraws on its own comes back with the
		 *  measured edge rather than the estimate: a card whose rows disagree
		 *  about where they start is a card that looks broken in half. */
		measured = new Map<number, { x: number; pull: number }>();

		constructor(view: EditorView) {
			this.onLines = selLines(view.state);
			this.deco = this.build(view);
			this.align(view);
		}

		update(u: ViewUpdate) {
			const lines = selLines(u.state);
			if (u.docChanged || u.viewportChanged || u.geometryChanged || lines !== this.onLines) {
				this.onLines = lines;
				this.deco = this.build(u.view);
			}
			// every update, not only the rebuilds: CodeMirror redraws single
			// lines for reasons of its own, and each redraw is a chance for one
			// row of a card to be left behind the rest
			this.align(u.view);
		}

		/** Where a step's own words sit is settled by the theme's fonts, the
		 *  list's indent and the note's width, and the one place all three have
		 *  agreed is the rendered line. So the card's left edge is read off the
		 *  step above rather than worked out from character widths, and the
		 *  fence's line is pulled by whatever the two disagree by, which is what
		 *  puts its number in the column with the numbers above and below it.
		 *  The build's own estimate stands until this lands, and stays whenever
		 *  the lines it needs are scrolled out of view. */
		align(view: EditorView) {
			if (!this.insets.length) return;
			const blocks = this.insets;
			view.requestMeasure<({ start: number; end: number; x: number; pull: number } | null)[]>({
				read: (v) =>
					blocks.map((b) => {
						try {
							const doc = v.state.doc;
							if (b.end > doc.lines || b.stepTextPos < 0) return null;
							const head = lineElAt(v, doc.line(b.start).from);
							const text = v.coordsAtPos(b.stepTextPos);
							if (!head || !text) return null; // scrolled out of view: leave it as it stands
							// The number on the fence's line is measured against the
							// number above it, not the card, since a widget stands
							// between it and the code. That line already carries the
							// last pull, so what is measured now is only what was
							// left over: adding it converges, and once the two agree
							// it changes nothing.
							const mine = b.markerPos >= 0 ? v.coordsAtPos(b.markerPos) : null;
							const theirs = b.stepMarkerPos >= 0 ? v.coordsAtPos(b.stepMarkerPos) : null;
							const carried = this.measured.get(b.start)?.pull ?? 0;
							return {
								start: b.start,
								end: b.end,
								x: text.left - head.getBoundingClientRect().left,
								pull: mine && theirs ? carried + (mine.left - theirs.left) : 0,
							};
						} catch {
							return null; // a line the view has not built yet
						}
					}),
				write: (vals, v) => {
					for (const r of vals) {
						if (!r || r.x <= 0) continue;
						// kept for the next build, and written now so this frame is
						// already right rather than right one redraw later
						this.measured.set(r.start, { x: Math.round(r.x), pull: Math.round(r.pull) });
						try {
							for (let n = r.start; n <= r.end && n <= v.state.doc.lines; n++) {
								const el = lineElAt(v, v.state.doc.line(n).from);
								if (!el) continue;
								el.style.setProperty("--ped-cb-x", `${Math.round(r.x)}px`);
								if (n === r.start) el.style.setProperty("--ped-cb-pull", `${Math.round(r.pull)}px`);
							}
						} catch {
							/* the view moved on; the next measurement lands it */
						}
					}
				},
			});
		}

		build(view: EditorView): DecorationSet {
			const b = new RangeSetBuilder<Decoration>();
			const doc = view.state.doc;
			// One pass for the fence map. Fence state only makes sense counted
			// from the top of the document, and doing that per candidate line
			// was quadratic; this is linear and reused for every visible range.
			const blocks: { start: number; end: number; lang: string; file: string; mark: string; indent: string; lead: number; marker: number; closed: boolean }[] = [];
			let open: { start: number; lang: string; file: string; mark: string; indent: string; lead: number; marker: number } | null = null;
			for (let n = 1; n <= doc.lines; n++) {
				// the info string may carry a filename after the language, so it
				// is captured whole and parsed rather than matched narrowly
				const m = FENCE_LINE.exec(doc.line(n).text);
				if (!m) continue;
				const closing = !m[4].trim();
				if (!open) {
					const info = parseFenceInfo(m[4]);
					open = { start: n, lang: info.lang, file: info.file, mark: m[3], indent: m[1] + " ".repeat(m[2]?.length ?? 0), lead: m[1].length + (m[2]?.length ?? 0), marker: m[2]?.length ?? 0 };
				} else if (closing && m[3][0] === open.mark[0] && m[3].length >= open.mark.length) {
					blocks.push({ ...open, end: n, closed: true });
					open = null;
				}
			}
			if (open) blocks.push({ ...open, end: doc.lines, closed: false }); // unclosed fence
			const numbers = document.body.hasClass("ped-cb-nums");
			let tab = 0; // read once, and only when a block is actually indented
			this.insets = [];
			// Live Preview shows a block's fences whenever the cursor is anywhere
			// inside it, so clicking into the code breaks the card open and puts
			// its ``` on screen. The card's header is already the fence made
			// readable, language and all, so a fence stays hidden unless the
			// cursor is on its own line, which is where it can be edited.
			const sel = view.state.selection.main;
			const on = (n: number) => n >= doc.lineAt(sel.from).number && n <= doc.lineAt(sel.to).number;

			for (const blk of blocks) {
				const visible = view.visibleRanges.some((r) => doc.lineAt(r.to).number >= blk.start && doc.lineAt(r.from).number <= blk.end);
				if (!visible) continue;
				const head = doc.line(blk.start);
				const label = blk.lang
					? (LANG_LABEL[blk.lang] ?? CODE_LANGS.find(([v]) => v === blk.lang)?.[1] ?? blk.lang)
					: "Plain text";
				// A block inside a list item is indented to that step's own text
				// column, and the card is drawn from there across rather than
				// from the note's margin, so the step's number stays beside it
				// instead of being swallowed by it. The width is the indent in
				// code characters, which is exactly what the indent measures.
				// The last measurement stands in for it once there is one, so every
				// row of the card starts in the same place even when CodeMirror
				// redraws one of them by itself.
				const found = this.measured.get(blk.start);
				const inset = blk.indent ? `--ped-cb-x:${found ? `${found.x}px` : `${indentColumns(blk.indent, (tab ||= tabWidth(view)))}ch`}` : "";
				// A fence that opens on the step's own line keeps that line's
				// number where the list put it; one on a line of its own has
				// nothing but indent in front of it, so it is set like the code.
				const onStep = inset && blk.marker > 0;
				const step = inset ? stepAbove(doc, blk.start, blk.indent.length) : null;
				if (inset) {
					this.insets.push({
						start: blk.start,
						end: blk.end,
						markerPos: onStep ? head.from + blk.lead - blk.marker : -1,
						stepMarkerPos: step?.marker ?? -1,
						stepTextPos: step?.text ?? -1,
					});
				}
				const headAttrs: Record<string, string> = { class: ["ped-cb-head", inset ? "ped-cb-in" : "", onStep ? "ped-cb-step" : ""].filter(Boolean).join(" ") };
				if (inset) headAttrs.style = found ? `${inset};--ped-cb-pull:${found.pull}px` : inset;
				b.add(head.from, head.from, Decoration.line({ attributes: headAttrs }));
				// a fence on its own line is indented like the code below it, so
				// the indent goes the same way the code's does
				if (inset && !onStep && head.text.startsWith(blk.indent)) b.add(head.from, head.from + blk.indent.length, Decoration.replace({}));
				// the step's number ends where its words would start, which is the
				// card's own edge: the fence needs the card's padding after it to
				// line up with the code underneath
				if (onStep) b.add(head.from + blk.lead, head.from + blk.lead, Decoration.widget({ widget: new CardPadWidget(), side: -1 }));
				if (!on(blk.start) && head.to > head.from + blk.lead) b.add(head.from + blk.lead, head.to, Decoration.replace({}));
				b.add(head.to, head.to, Decoration.widget({ widget: new FileNameWidget(blk.start - 1, blk.file), side: 0 }));
				b.add(head.to, head.to, Decoration.widget({ widget: new LangButtonWidget(blk.start - 1, label), side: 1 }));
				b.add(head.to, head.to, Decoration.widget({ widget: new CopyCodeWidget(fenceBody(doc, blk.start, blk.mark, blk.indent)), side: 2 }));
				// The gutter number is the line's position INSIDE the block, and
				// it comes from the real line number rather than a CSS counter
				// CodeMirror only renders what is on screen, so a counter would
				// restart partway down a long block.
				for (let n = blk.start + 1; n <= blk.end; n++) {
					const line = doc.line(n);
					const closing = n === blk.end;
					const body = numbers && !closing;
					// The indent is what holds the block inside the step; it is not
					// part of the code, so it is not drawn. Replaced rather than
					// merely made invisible: a caret in text of no size is a caret
					// of no height, which is a caret nobody can see.
					const hideIndent = inset && line.text.startsWith(blk.indent);
					const attrs: Record<string, string> = { class: [body ? "ped-cb-body" : "", inset ? "ped-cb-in" : ""].filter(Boolean).join(" ") };
					if (body) attrs["data-ped-ln"] = String(n - blk.start);
					if (inset) attrs.style = inset;
					if (attrs.class) b.add(line.from, line.from, Decoration.line({ attributes: attrs }));
					// the closing fence goes the same way as the opening one: with
					// the cursor elsewhere, the card ends in a clean edge rather
					// than in three backticks
					if (closing && blk.closed && !on(n) && line.to > line.from) b.add(line.from, line.to, Decoration.replace({}));
					else if (hideIndent) b.add(line.from, line.from + blk.indent.length, Decoration.replace({}));
				}
			}
			// measurements outlive their block when an edit above moves it, and a
			// stale one would be handed to whatever lands on that line next
			if (this.measured.size) {
				const live = new Set(blocks.map((blk) => blk.start));
				for (const start of this.measured.keys()) if (!live.has(start)) this.measured.delete(start);
			}
			return b.finish();
		}
	},
	{ decorations: (v) => v.deco }
);

/** The step above a block, as the two positions worth measuring: where its
 *  number starts and where its words do. The words' column is the card's own
 *  left edge, and the number's is the column the block's own number belongs in.
 *  Null when the line above is not a step at this level. */
function stepAbove(doc: { lines: number; line(n: number): { from: number; text: string } }, start: number, indent: number): { marker: number; text: number } | null {
	for (let n = start - 1; n >= 1; n--) {
		const line = doc.line(n);
		if (!line.text.trim()) continue;
		const content = listContentIndent(line.text);
		if (content.length !== indent) return null; // a different level, or no list at all
		return { marker: line.from + (/^[ \t]*/.exec(line.text)?.[0].length ?? 0), text: line.from + content.length };
	}
	return null;
}

/** A line's leading whitespace, in characters. */
const leadOf = (line: string | undefined): number => /^[ \t]*/.exec(line ?? "")?.[0].length ?? 0;

/** The rendered line holding `pos`, for reading and writing its own geometry. */
const lineElAt = (view: EditorView, pos: number): HTMLElement | null => {
	const { node } = view.domAtPos(pos);
	const el = node.nodeType === 3 ? node.parentElement : (node as HTMLElement);
	return el?.closest?.(".cm-line") ?? null;
};

/** The editor's tab width in characters, for measuring an indent in the code
 *  font it is rendered in. */
const tabWidth = (view: EditorView): number => Number(getComputedStyle(view.contentDOM).tabSize) || 4;

/** An indent's width in columns, tabs expanded. */
const indentColumns = (indent: string, tab: number): number => {
	let n = 0;
	for (const ch of indent) n = ch === "\t" ? (Math.floor(n / tab) + 1) * tab : n + 1;
	return n;
};

/** The text inside the fence that starts at `lineNo`, for the Copy button. */
function fenceBody(doc: { lines: number; line(n: number): { text: string } }, lineNo: number, fence: string, indent: string): string {
	const out: string[] = [];
	const close = new RegExp("^\\s*" + fence[0] + "{" + fence.length + ",}\\s*$");
	// A block inside a list item carries that item's indent on every line. The
	// code is what is left after it, and that is what a copy has to hand over:
	// a paste into a terminal, or into Python or YAML, does not want the list.
	for (let i = lineNo + 1; i <= doc.lines; i++) {
		const t = doc.line(i).text;
		if (close.test(t)) break;
		out.push(indent && t.startsWith(indent) ? t.slice(indent.length) : t);
	}
	return out.join("\n");
}

/** Menu anchor just under a toolbar button. */
const rectBelow = (el: HTMLElement): { x: number; y: number } => {
	const r = el.getBoundingClientRect();
	return { x: r.left, y: r.bottom + 4 };
};

const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "avif"]);

/** The four corner resize handles. `dir` is the sign the horizontal drag delta
 *  applies to the width (right corners grow with the pointer, left corners
 *  against it); `cursor` is the matching diagonal. */
const IMG_CORNERS: { corner: "nw" | "ne" | "sw" | "se"; dir: 1 | -1; cursor: string }[] = [
	{ corner: "nw", dir: -1, cursor: "nwse-resize" },
	{ corner: "ne", dir: 1, cursor: "nesw-resize" },
	{ corner: "sw", dir: -1, cursor: "nesw-resize" },
	{ corner: "se", dir: 1, cursor: "nwse-resize" },
];

/** Vault image picker for the image toolbar's Replace action and covers. */
class ImageSuggestModal extends FuzzySuggestModal<TFile> {
	constructor(
		app: import("obsidian").App,
		private onPick: (f: TFile) => void,
		placeholder = "Replace with which image?"
	) {
		super(app);
		this.setPlaceholder(placeholder);
	}

	getItems(): TFile[] {
		return this.app.vault.getFiles().filter((f) => IMAGE_EXTS.has(f.extension.toLowerCase()));
	}

	getItemText(f: TFile): string {
		return f.path;
	}

	onChooseItem(f: TFile): void {
		this.onPick(f);
	}
}

/** One-field prompt (window.prompt doesn't exist in Electron). */
class TextPromptModal extends Modal {
	constructor(
		app: import("obsidian").App,
		private heading: string,
		private initial: string,
		private onSubmit: (value: string) => void
	) {
		super(app);
	}

	onOpen() {
		this.titleEl.setText(this.heading);
		const input = this.contentEl.createEl("input", {
			cls: "ped-prompt-input",
			attr: { type: "text", spellcheck: "false" },
		});
		input.value = this.initial;
		const submit = () => {
			const v = input.value;
			this.close();
			this.onSubmit(v);
		};
		input.addEventListener("keydown", (e) => {
			if (e.key === "Enter") {
				e.preventDefault();
				submit();
			}
		});
		const btns = this.contentEl.createDiv({ cls: "ped-prompt-btns" });
		btns.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.close());
		btns.createEl("button", { text: "Apply", cls: "mod-cta" }).addEventListener("click", submit);
		window.setTimeout(() => {
			input.focus();
			input.select();
		}, 0);
	}

	onClose() {
		this.contentEl.empty();
	}
}

/** The visual page-cover picker: gradient and solid swatches, your own images,
 *  and a height control. Swatches apply live behind the modal, Notion-style. */
class CoverModal extends Modal {
	constructor(private plugin: PowerEditorPlugin, private file: TFile) {
		super(plugin.app);
	}

	private current() {
		return parseCover(this.app.metadataCache.getFileCache(this.file)?.frontmatter);
	}

	onOpen() {
		this.titleEl.setText("Page cover");
		this.modalEl.addClass("ped-cover-modal");
		this.render();
	}

	private render(applied?: string) {
		const c = this.contentEl;
		c.empty();
		const spec = this.current();
		const activeVal = applied ?? (spec?.kind === "gradient" ? spec.value : spec?.kind === "solid" ? `solid:${spec.value}` : "");

		c.createEl("div", { cls: "ped-cover-sect", text: "Gradients" });
		const gGrid = c.createDiv({ cls: "ped-cover-grid" });
		GRADIENTS.forEach((css, i) => {
			const tile = gGrid.createDiv({ cls: "ped-cover-swatch", attr: { "aria-label": GRADIENT_NAMES[i] ?? `Gradient ${i + 1}` } });
			tile.style.backgroundImage = css;
			tile.toggleClass("is-active", activeVal === `gradient:${i + 1}`);
			tile.addEventListener("click", () => this.apply(`gradient:${i + 1}`));
		});

		c.createEl("div", { cls: "ped-cover-sect", text: "Solid colors" });
		const sGrid = c.createDiv({ cls: "ped-cover-grid" });
		SOLIDS.forEach((hex, i) => {
			const tile = sGrid.createDiv({ cls: "ped-cover-swatch", attr: { "aria-label": SOLID_NAMES[i] ?? hex } });
			tile.style.backgroundColor = hex;
			tile.toggleClass("is-active", activeVal.toLowerCase() === `solid:${hex}`.toLowerCase());
			tile.addEventListener("click", () => this.apply(`solid:${hex}`));
		});

		c.createEl("div", { cls: "ped-cover-sect", text: "Your images" });
		const imgRow = c.createDiv({ cls: "ped-cover-actions" });
		const act = (label: string, icon: string, fn: () => void) => {
			const b = imgRow.createEl("button", { cls: "ped-cover-action" });
			setIcon(b.createSpan({ cls: "ped-cover-action-icon" }), icon);
			b.createSpan({ text: label });
			b.addEventListener("click", fn);
		};
		act("From vault…", "image", () => {
			this.close();
			new ImageSuggestModal(this.app, (f) => void this.plugin.writeCover(this.file, `[[${f.path}]]`), "Which image becomes the cover?").open();
		});
		act("Upload…", "upload", () => {
			this.close();
			this.plugin.uploadCover(this.file);
		});
		act("From URL…", "link", () => {
			const url = spec?.kind === "url" ? spec.value : "";
			this.close();
			new TextPromptModal(this.app, "Cover image URL", url, (v) => {
				if (v.trim()) void this.plugin.writeCover(this.file, v.trim());
			}).open();
		});

		c.createEl("div", { cls: "ped-cover-sect", text: "Height" });
		const hRow = c.createDiv({ cls: "ped-cover-heights" });
		const heights: [CoverHeight, string][] = [
			["short", "Short"],
			["standard", "Standard"],
			["tall", "Tall"],
		];
		const curH = spec?.height ?? "standard";
		heights.forEach(([h, label]) => {
			const b = hRow.createEl("button", { cls: "ped-cover-height", text: label });
			b.toggleClass("is-active", h === curH);
			b.addEventListener("click", () => void this.plugin.writeCoverHeight(this.file, h).then(() => this.render(activeVal || undefined)));
		});

		c.createEl("div", { cls: "ped-cover-sect", text: "Title" });
		const overlaid = parsePageLayout(this.app.metadataCache.getFileCache(this.file)?.frontmatter).overlayTitle;
		const ovRow = c.createDiv({ cls: "ped-cover-heights" });
		const ovBtn = ovRow.createEl("button", { cls: "ped-cover-height", text: "Float title over cover" });
		ovBtn.toggleClass("is-active", overlaid);
		ovBtn.addEventListener("click", () =>
			void this.plugin.writePageProp(this.file, "cover-overlay", overlaid ? null : true).then(() => this.render(activeVal || undefined))
		);

		const foot = c.createDiv({ cls: "ped-cover-foot" });
		foot
			.createEl("button", { text: "Randomize" })
			.addEventListener("click", () => this.apply(`gradient:${1 + Math.floor(Math.random() * GRADIENTS.length)}`));
		if (spec || applied)
			foot.createEl("button", { cls: "mod-warning", text: "Remove cover" }).addEventListener("click", () => {
				this.close();
				void this.plugin.writeCover(this.file, null);
			});
	}

	private apply(value: string) {
		void this.plugin.writeCover(this.file, value);
		this.render(value);
	}

	onClose() {
		this.contentEl.empty();
	}
}

/** A live `todo` dashboard block: a Tasks-style query over every checklist in
 *  the vault, rendered with working checkboxes. Completing here edits the
 *  source note (stamping ✅ and spawning 🔁 recurrences); the vault change
 *  then re-renders every visible dashboard. */
class TodoBlock extends MarkdownRenderChild {
	private timer: number | null = null;

	constructor(
		el: HTMLElement,
		private source: string,
		private plugin: PowerEditorPlugin
	) {
		super(el);
	}

	onload() {
		void this.render();
		this.registerEvent(this.plugin.app.vault.on("modify", () => this.queue()));
		this.registerEvent(this.plugin.app.vault.on("delete", () => this.queue()));
		this.registerEvent(this.plugin.app.vault.on("rename", () => this.queue()));
	}

	private queue() {
		if (this.timer != null) window.clearTimeout(this.timer);
		this.timer = window.setTimeout(() => void this.render(), 400);
	}

	private async render() {
		const { query, errors } = parseQuery(this.source);
		const el = this.containerEl;
		el.empty();
		const root = el.createDiv({ cls: "ped-todo" });
		if (errors.length) {
			for (const err of errors) root.createDiv({ cls: "ped-todo-error", text: err });
			return;
		}
		const groups = runQuery(query, await this.plugin.collectTodos(), todayStr());
		if (query.view === "week") {
			this.renderWeek(
				root,
				groups.flatMap((g) => g.items)
			);
			return;
		}
		if (query.view === "board") {
			this.renderBoard(root, groups, query.groupBy);
			return;
		}
		if (!groups.length) {
			root.createDiv({ cls: "ped-todo-empty", text: "Nothing to do" });
			return;
		}
		for (const g of groups) {
			if (g.heading) {
				const done = g.items.filter((t) => t.checked).length;
				const count = done ? `${done} of ${g.items.length} done` : String(g.items.length);
				root.createDiv({ cls: "ped-todo-h", text: `${g.heading} · ${count}` });
			}
			const list = root.createDiv({ cls: "ped-todo-list" });
			for (const t of g.items) this.plugin.renderTodoItem(list, t);
		}
	}

	/** `view week`: the current week as seven columns, chips draggable across
	 *  days to reschedule. Only items due this week appear. */
	private renderWeek(root: HTMLElement, items: TodoItem[]) {
		const today = todayStr();
		const monday = mondayOf(today);
		const grid = root.createDiv({ cls: "ped-week" });
		const names = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
		for (let i = 0; i < 7; i++) {
			const date = isoAddDays(monday, i);
			const col = grid.createDiv({ cls: "ped-week-day" + (date === today ? " is-today" : "") });
			col.createDiv({ cls: "ped-week-h", text: `${names[i]} ${Number(date.slice(8))}` });
			col.addEventListener("dragover", (e) => {
				e.preventDefault();
				col.addClass("is-dragover");
			});
			col.addEventListener("dragleave", () => col.removeClass("is-dragover"));
			col.addEventListener("drop", (e) => {
				e.preventDefault();
				col.removeClass("is-dragover");
				const idx = Number(e.dataTransfer?.getData("text/ped-todo"));
				const item = items[idx];
				if (item) void this.plugin.setTodoDue(item, date);
			});
			for (const t of items.filter((t) => t.due === date)) {
				const chip = col.createDiv({ cls: "ped-week-chip" + (t.checked ? " is-done" : "") });
				chip.setText(t.body);
				chip.draggable = true;
				chip.addEventListener("dragstart", (e) => e.dataTransfer?.setData("text/ped-todo", String(items.indexOf(t))));
				chip.addEventListener("click", () => {
					void this.plugin.app.workspace.openLinkText(t.path ?? "", "", false, { eState: { line: t.line } });
				});
			}
		}
	}

	/** `view board`: the query's groups as columns. Chips drag between lanes
	 *  when the lane means something writable (a due date or a priority);
	 *  file lanes are read-only since dragging would mean moving notes. */
	private renderBoard(root: HTMLElement, groups: TodoGroup[], groupBy: "file" | "due" | "priority" | null) {
		if (!groups.length) {
			root.createDiv({ cls: "ped-todo-empty", text: "Nothing to show" });
			return;
		}
		const items = groups.flatMap((g) => g.items);
		const droppable = groupBy === "due" || groupBy === "priority";
		const grid = root.createDiv({ cls: "ped-board" });
		for (const g of groups) {
			const col = grid.createDiv({ cls: "ped-week-day ped-board-col" });
			col.createDiv({ cls: "ped-week-h", text: `${g.heading || "All"} · ${g.items.length}` });
			if (droppable) {
				col.addEventListener("dragover", (e) => {
					e.preventDefault();
					col.addClass("is-dragover");
				});
				col.addEventListener("dragleave", () => col.removeClass("is-dragover"));
				col.addEventListener("drop", (e) => {
					e.preventDefault();
					col.removeClass("is-dragover");
					const item = items[Number(e.dataTransfer?.getData("text/ped-todo"))];
					if (!item) return;
					if (groupBy === "due") void this.plugin.setTodoDue(item, g.heading === "No date" ? null : g.heading);
					else void this.plugin.setTodoPriority(item, Math.max(0, PRIORITY_LABELS.indexOf(g.heading)));
				});
			}
			for (const t of g.items) {
				const chip = col.createDiv({ cls: "ped-week-chip" + (t.checked ? " is-done" : "") });
				chip.setText(t.body);
				chip.draggable = droppable;
				chip.addEventListener("dragstart", (e) => e.dataTransfer?.setData("text/ped-todo", String(items.indexOf(t))));
				chip.addEventListener("click", () => {
					void this.plugin.app.workspace.openLinkText(t.path ?? "", "", false, { eState: { line: t.line } });
				});
			}
		}
	}
}

/** The Today pane: a persistent sidebar answer to "what now", Overdue,
 *  Today, and the next seven days, with the same live rows as dashboards. */
class TodayView extends ItemView {
	private timer: number | null = null;

	constructor(
		leaf: WorkspaceLeaf,
		private plugin: PowerEditorPlugin
	) {
		super(leaf);
	}

	getViewType() {
		return TODAY_VIEW;
	}

	getDisplayText() {
		return "Today";
	}

	getIcon() {
		return "calendar-check";
	}

	async onOpen() {
		await this.render();
		this.registerEvent(this.plugin.app.vault.on("modify", () => this.queue()));
		this.registerEvent(this.plugin.app.vault.on("delete", () => this.queue()));
		this.registerEvent(this.plugin.app.vault.on("rename", () => this.queue()));
	}

	private queue() {
		if (this.timer != null) window.clearTimeout(this.timer);
		this.timer = window.setTimeout(() => void this.render(), 400);
	}

	private async render() {
		const c = this.contentEl;
		c.empty();
		c.addClass("ped-todo", "ped-today");
		const today = todayStr();
		const horizon = isoAddDays(today, 7);
		const open = (await this.plugin.collectTodos()).filter((t) => !t.checked);
		const byDue = (a: TodoItem, b: TodoItem) =>
			(a.due ?? "9999").localeCompare(b.due ?? "9999") || (a.path ?? "").localeCompare(b.path ?? "");
		const sections: [string, TodoItem[]][] = [
			["Overdue", open.filter((t) => t.due != null && t.due < today)],
			["Today", open.filter((t) => t.due === today)],
			["Next 7 days", open.filter((t) => t.due != null && t.due > today && t.due <= horizon)],
		];
		let any = false;
		for (const [name, list] of sections) {
			if (!list.length) continue;
			any = true;
			c.createDiv({ cls: "ped-todo-h", text: `${name} · ${list.length}` });
			const wrap = c.createDiv({ cls: "ped-todo-list" });
			for (const t of list.sort(byDue)) this.plugin.renderTodoItem(wrap, t);
		}
		if (!any) c.createDiv({ cls: "ped-todo-empty", text: "Nothing due. Enjoy it." });
	}
}

/** The Comments pane: every open %%💬%% across the vault, grouped by note.
 *  Click a row to jump to it, or resolve it right here. */
class CommentsView extends ItemView {
	private timer: number | null = null;

	constructor(
		leaf: WorkspaceLeaf,
		private plugin: PowerEditorPlugin
	) {
		super(leaf);
	}

	getViewType() {
		return COMMENTS_VIEW;
	}

	getDisplayText() {
		return "Comments";
	}

	getIcon() {
		return "message-circle";
	}

	async onOpen() {
		await this.render();
		this.registerEvent(this.plugin.app.vault.on("modify", () => this.queue()));
		this.registerEvent(this.plugin.app.vault.on("delete", () => this.queue()));
		this.registerEvent(this.plugin.app.vault.on("rename", () => this.queue()));
	}

	private queue() {
		if (this.timer != null) window.clearTimeout(this.timer);
		this.timer = window.setTimeout(() => void this.render(), 400);
	}

	private async render() {
		const c = this.contentEl;
		c.empty();
		c.addClass("ped-todo", "ped-comments");
		let any = false;
		for (const f of this.plugin.app.vault.getMarkdownFiles()) {
			const content = await this.plugin.app.vault.cachedRead(f);
			if (!content.includes("%%💬")) continue;
			const comments = parseComments(content.split("\n"));
			if (!comments.length) continue;
			any = true;
			c.createDiv({ cls: "ped-todo-h", text: f.path.replace(/\.md$/, "") + " · " + comments.length });
			const list = c.createDiv({ cls: "ped-todo-list" });
			for (const cm of comments) {
				const row = list.createDiv({ cls: "ped-comment-row" });
				const main = row.createDiv({ cls: "ped-comment-rowmain" });
				main.createDiv({ cls: "ped-comment-text", text: cm.text });
				if (cm.stamp) main.createDiv({ cls: "ped-comment-stamp", text: cm.stamp });
				main.addEventListener("click", () => {
					void this.plugin.app.workspace.openLinkText(f.path, "", false, { eState: { line: cm.line } });
				});
				row.createEl("button", { cls: "ped-comment-resolve", text: "Resolve" }).addEventListener("click", (e) => {
					e.stopPropagation();
					void this.resolve(f, cm);
				});
			}
		}
		if (!any) c.createDiv({ cls: "ped-todo-empty", text: "No open comments." });
	}

	private async resolve(f: TFile, cm: NoteComment) {
		await this.plugin.app.vault.process(f, (data) => {
			const lines = data.split("\n");
			const line = lines[cm.line];
			if (line == null) return data;
			const m = line.slice(cm.ch).match(/^%%💬\s*(.*?)%%/);
			if (!m || commentParts(m[1]).text !== cm.text) return data;
			const from = cm.ch > 0 && line[cm.ch - 1] === " " ? cm.ch - 1 : cm.ch;
			lines[cm.line] = line.slice(0, from) + line.slice(cm.ch + m[0].length);
			return lines.join("\n");
		});
	}
}

/** A live `toc` block: the current note's headings as clickable contents,
 *  optionally narrowed with a "levels 2-3" line. */
class TocBlock extends MarkdownRenderChild {
	private timer: number | null = null;

	constructor(
		el: HTMLElement,
		private source: string,
		private path: string,
		private plugin: PowerEditorPlugin
	) {
		super(el);
	}

	onload() {
		this.render();
		this.registerEvent(
			this.plugin.app.metadataCache.on("changed", (f) => {
				if (f.path === this.path) this.queue();
			})
		);
	}

	private queue() {
		if (this.timer != null) window.clearTimeout(this.timer);
		this.timer = window.setTimeout(() => this.render(), 400);
	}

	private render() {
		const el = this.containerEl;
		el.empty();
		const root = el.createDiv({ cls: "ped-toc" });
		const rangeM = this.source.match(/levels\s+(\d)\s*-\s*(\d)/i);
		const lo = rangeM ? Number(rangeM[1]) : 1;
		const hi = rangeM ? Number(rangeM[2]) : 6;
		const f = this.plugin.app.vault.getAbstractFileByPath(this.path);
		const headings = (f instanceof TFile ? this.plugin.app.metadataCache.getFileCache(f)?.headings : null) ?? [];
		const shown = headings.filter((h) => h.level >= lo && h.level <= hi);
		if (!shown.length) {
			root.createDiv({ cls: "ped-todo-empty", text: "No headings yet." });
			return;
		}
		const min = Math.min(...shown.map((h) => h.level));
		root.createDiv({ cls: "ped-toc-title", text: "Contents" });
		for (const h of shown) {
			const item = root.createDiv({ cls: "ped-toc-item" });
			item.style.marginInlineStart = (h.level - min) * 16 + "px";
			item.setText(h.heading);
			item.addEventListener("click", () => {
				void this.plugin.app.workspace.openLinkText(this.path + "#" + h.heading, this.path);
			});
		}
	}
}

const AI_ACTIONS: [string, string][] = [
	["Improve writing", "Improve the writing: clearer, tighter, same meaning and tone."],
	["Fix grammar & spelling", "Fix grammar, spelling, and punctuation. Change nothing else."],
	["Make shorter", "Rewrite this at roughly half the length, keeping every key point."],
	["Summarize", "Summarize this in a few concise bullet points."],
];

/** The family palette (same swatches as Power Tables): a row of soft fills,
 *  a row of medium fills, and a row of strong colors, 8 each. */
const PALETTE = [
	"#FFFFFF", "#EFEAFC", "#E3F0FC", "#E2F5EA", "#FDF3D7", "#FCE9DC", "#FDE8E6", "#F1F1F4",
	"#D9CCF7", "#BFDDF8", "#BEE9CF", "#F8E4A0", "#F7CDB0", "#F6C3BE", "#DFDFE5", "#B9B9C2",
	"#6D28D9", "#0B6BCB", "#1E8553", "#B45309", "#C2410C", "#B42318", "#374151", "#1A1A1F",
];

/** Named text / background colors for the block-color submenu (Notion order). */
const TEXT_COLORS: [string, string][] = [
	["Gray", "#6B7280"], ["Brown", "#92400E"], ["Orange", "#C2410C"], ["Yellow", "#B45309"],
	["Green", "#1E8553"], ["Blue", "#0B6BCB"], ["Purple", "#6D28D9"], ["Red", "#B42318"],
];
const BG_COLORS: [string, string][] = [
	["Gray", "#F1F1F4"], ["Brown", "#FCE9DC"], ["Orange", "#F7CDB0"], ["Yellow", "#FDF3D7"],
	["Green", "#E2F5EA"], ["Blue", "#E3F0FC"], ["Purple", "#EFEAFC"], ["Red", "#FDE8E6"],
];

/** THE heading-typing fix. CodeMirror's inputHandler facet is called with the
 *  insertion range in CM's own document coordinates (from/to), authoritative,
 *  never stale like editor.getCursor() and never empty like beforeinput's
 *  getTargetRanges(). When a character would land before a heading's hidden
 *  "# " marker, we insert it after the marker instead and tell CM we handled
 *  it. This is what makes typing into an empty heading produce "# text". */
function headingInputFix(plugin: PowerEditorPlugin) {
	return EditorView.inputHandler.of((view, from, to, text) => {
		if (!plugin.settings.wysiwygMarks || from !== to || !text) return false;
		const line = view.state.doc.lineAt(from);
		const snapped = headingCursorSnap(line.text, from - line.from);
		if (snapped == null) return false;
		const at = line.from + snapped;
		view.dispatch({ changes: { from: at, insert: text }, selection: { anchor: at + text.length }, userEvent: "input.type" });
		return true;
	});
}

/** Keep the caret out of a heading's hidden "# " marker (WYSIWYG only). Without
 *  this, clicking an empty heading lands the caret at offset 0, before the
 *  hidden hash, and typing produces "text# " instead of a heading. */
function headingCursorGuard(plugin: PowerEditorPlugin) {
	return EditorState.transactionFilter.of((tr) => {
		if (!plugin.settings.wysiwygMarks || !tr.selection) return tr;
		const sel = tr.selection.main;
		if (!sel.empty) return tr;
		const line = tr.newDoc.lineAt(sel.head);
		const snapped = headingCursorSnap(line.text, sel.head - line.from);
		return snapped == null ? tr : [tr, { selection: EditorSelection.cursor(line.from + snapped) }];
	});
}

/** Empty headings show a greyed "Heading N" label, Notion-style, the hashes
 *  are hidden in WYSIWYG mode, so without this an empty heading looks blank.
 *  Only meaningful in WYSIWYG mode: with the hashes visible the line already
 *  reads as a heading, so the label would just be noise. */
function headingPlaceholders(plugin: PowerEditorPlugin) {
	return ViewPlugin.fromClass(
		class {
			decorations: DecorationSet;
			constructor(view: EditorView) {
				this.decorations = this.build(view);
			}
			update(u: ViewUpdate) {
				if (u.docChanged || u.viewportChanged) this.decorations = this.build(u.view);
			}
			build(view: EditorView): DecorationSet {
				const b = new RangeSetBuilder<Decoration>();
				if (!plugin.settings.wysiwygMarks) return b.finish();
				for (const { from, to } of view.visibleRanges) {
					let pos = from;
					while (pos <= to) {
						const line = view.state.doc.lineAt(pos);
						const label = emptyHeadingLabel(line.text);
						if (label)
							b.add(line.from, line.from, Decoration.line({ attributes: { class: "ped-heading-ph", "data-ped-hph": label } }));
						pos = line.to + 1;
					}
				}
				return b.finish();
			}
		},
		{ decorations: (v) => v.decorations }
	);
}

type CMView = EditorView & { posAtCoords(coords: { x: number; y: number }): number | null };

/** Toolbar button registry per pane, so active states can be repainted fast. */
interface Bar {
	el: HTMLElement;
	buttons: Map<string, HTMLElement>;
	headingLabel: HTMLElement;
}

export default class PowerEditorPlugin extends Plugin {
	settings!: PowerEditorSettings;
	/** The settings as they last stood on disk, read or written by us. Whatever
	 *  differs from this in memory is OUR change, and only those keys may
	 *  overwrite a synced data.json; see persistSettings(). */
	private baseline: PowerEditorSettings = DEFAULT_SETTINGS;
	private bars = new WeakMap<MarkdownView, Bar>();
	private stateTimer: number | null = null;
	/* dictation state */
	private recorder: MediaRecorder | null = null;
	private recChunks: Blob[] = [];
	/* drag state */
	private handleEl: HTMLElement | null = null;
	private dropEl: HTMLElement | null = null;
	private hover: { view: MarkdownView; cm: CMView; range: BlockRange } | null = null;
	private dragging: {
		view: MarkdownView;
		cm: CMView;
		range: BlockRange;
		starts: number[];
		target: number | null;
		startX: number;
		startY: number;
		moved: boolean;
	} | null = null;
	private linesCache: { doc: unknown; lines: string[] } | null = null;
	/* bubble + painter state */
	private bubbleEl: HTMLElement | null = null;
	private bubbleButtons = new Map<string, HTMLElement>();
	private bubbleHeadingLabel: HTMLElement | null = null;
	private bubbleTimer: number | null = null;
	private painter: { marks: Marks; sticky: boolean } | null = null;
	private colorPop: HTMLElement | null = null;
	/* image resize state */
	private imgGrips: HTMLElement[] = [];
	private imgBadge: HTMLElement | null = null;
	private imgHover: HTMLImageElement | null = null;
	private imgDrag: { img: HTMLImageElement; startW: number; startX: number; dir: 1 | -1 } | null = null;

	/** WYSIWYG mode: hide Markdown formatting characters even at the cursor. */
	applyWysiwyg() {
		document.body.toggleClass("ped-wys", this.settings.wysiwygMarks);
		this.app.workspace.updateOptions(); // rebuild editor extensions so tag-hiding follows the toggle
	}

	/** Line spacing: compact / normal / relaxed, editing and reading views. */
	applySpacing() {
		document.body.toggleClass("ped-lh-compact", this.settings.lineSpacing === "compact");
		document.body.toggleClass("ped-lh-relaxed", this.settings.lineSpacing === "relaxed");
		this.applyCodeTheme();
		this.applyBlockGap();
	}

	/** The blank line under a heading, and the ones hugging a table, are real
	 *  editor lines in Live Preview, a full line-height each, and no Obsidian
	 *  spacing variable reaches them. This publishes the wanted heights as
	 *  custom properties; styles.css uses them to shrink exactly those lines.
	 *  Headings and tables carry their own class and variable so either can be
	 *  turned off without touching the other. A garbage value falls back to
	 *  Obsidian's default rather than emitting broken CSS, since the settings
	 *  accept a hand-typed override. */
	/** Publish the chosen code theme as body classes: one marker so the token
	 *  rules apply at all, the theme's own class carrying its palette, and a
	 *  `dark` marker so the block's chrome (Copy, the language button) flips
	 *  to light-on-dark with it. */
	applyCodeTheme() {
		const t = this.settings.codeTheme;
		const DARK = new Set(["one-dark", "dracula", "monokai", "github-dark"]);
		for (const name of ["default", "vivid", "one-dark", "dracula", "monokai", "github-dark"]) {
			document.body.toggleClass("ped-cbt-" + name, t === name);
		}
		document.body.toggleClass("ped-cbt", t !== "default");
		document.body.toggleClass("ped-cb-dark", DARK.has(t));
		document.body.toggleClass("ped-cb-nums", this.settings.codeLineNumbers);
		this.refreshEditors();
	}

	/**
	 * Put the selection on the clipboard as rich text, for pasting into mail.
	 *
	 * Plain Ctrl+C hands a mail client raw Markdown, and the client then guesses:
	 * Outlook autoformats the "1." lines into a list of its own, renumbers every
	 * nested level 1, 2, 3 (Markdown writes them all as "1." and Obsidian's a, b,
	 * c is CSS, which no clipboard carries), and leaves a hole wherever a line
	 * held a non-breaking space. Rendering it here and handing over real HTML
	 * settles all three, because the receiving app is then reading a document
	 * rather than interpreting text.
	 *
	 * The plain-text flavor stays Markdown, so pasting into an editor, a terminal,
	 * or back into Obsidian is exactly what it was before.
	 */
	private async copyRichText(ed: Editor, quiet = false) {
		const md = stripFrontmatter(ed.getSelection() || ed.getValue()).trim();
		if (!md) {
			if (!quiet) new Notice("Power Editor: nothing to copy.");
			return;
		}
		const host = createDiv({ cls: "ped-offscreen" });
		document.body.appendChild(host);
		try {
			const path = this.app.workspace.getActiveFile()?.path ?? "";
			const child = new MarkdownRenderChild(host);
			await MarkdownRenderer.render(this.app, md, host, path, child);
			this.emailifyHtml(host);
			// the Markdown rides along inside the HTML, so pasting back into
			// Obsidian restores what was copied rather than a reading of it
			const html = wrapWithMarkdown(host.innerHTML, md);
			// text/html AND text/plain: the mail client takes the first, everything
			// else takes the Markdown it would have had anyway
			if (navigator.clipboard?.write && typeof ClipboardItem !== "undefined") {
				await navigator.clipboard.write([
					new ClipboardItem({
						"text/html": new Blob([html], { type: "text/html" }),
						"text/plain": new Blob([md], { type: "text/plain" }),
					}),
				]);
			} else {
				await navigator.clipboard.writeText(md); // no rich clipboard here; Markdown is still useful
				if (!quiet) new Notice("Power Editor: copied as plain Markdown (this platform has no rich clipboard).");
				return;
			}
			if (!quiet) new Notice("Copied as rich text. Paste into your email.");
		} catch (e) {
			// a quiet run is the Ctrl+C path, where plain Markdown is already on
			// the clipboard from the event itself: say nothing, lose nothing
			if (!quiet) new Notice(`Power Editor: could not copy (${e instanceof Error ? e.message : String(e)}).`);
		} finally {
			host.remove();
		}
	}

	/**
	 * Ordinary Ctrl+C, upgraded. A command nobody remembers to run is not a fix
	 * for "I copied it into an email and the formatting went wrong", so the
	 * plain copy carries the rich flavor too.
	 *
	 * Rendering Markdown is asynchronous and a clipboard event is not, so the
	 * event writes the Markdown itself first, the clipboard is never empty and
	 * never wrong, and the HTML replaces it a few milliseconds later. Pasting
	 * inside that window gets exactly what Ctrl+C always gave.
	 */
	private onEditorCopy(e: ClipboardEvent) {
		if (!this.settings.richCopy) return;
		const el = (e.target instanceof HTMLElement ? e.target : document.activeElement) as HTMLElement | null;
		if (!el?.closest?.(".markdown-source-view.mod-cm6")) return;
		const ed = this.activeEditor();
		const md = ed?.getSelection();
		if (!ed || !md?.trim()) return;
		e.preventDefault();
		e.clipboardData?.setData("text/plain", md);
		void this.copyRichText(ed, true);
	}

	/**
	 * Turn rendered note HTML into HTML a mail client will honor. Everything is
	 * written as inline style attributes: Outlook drops <style> blocks and every
	 * class with them, so a stylesheet would arrive as no styling at all.
	 */
	private emailifyHtml(root: HTMLElement) {
		// vault-only chrome: an embed's src points inside the vault and a link to
		// another note goes nowhere from a mail client, so the text survives and
		// the dead link does not
		for (const el of Array.from(root.querySelectorAll(".internal-embed, .frontmatter, .metadata-container, .copy-code-button, .ped-drag-handle"))) el.remove();
		for (const a of Array.from(root.querySelectorAll("a.internal-link"))) {
			const span = createSpan({ text: a.textContent ?? "" });
			a.replaceWith(span);
		}
		// a line that only held a non-breaking space is the gap people see above
		// a pasted list; it is spacing, and spacing is the margins' job
		for (const p of Array.from(root.querySelectorAll("p"))) if (isBlankBlock(p.textContent ?? "")) p.remove();

		const style = (el: Element, css: string) => el.setAttribute("style", `${el.getAttribute("style") ?? ""};${css}`.replace(/^;/, ""));
		for (const p of Array.from(root.querySelectorAll("p"))) style(p, "margin:0 0 10px 0");
		for (const h of Array.from(root.querySelectorAll("h1, h2, h3, h4, h5, h6"))) style(h, "margin:16px 0 6px 0");
		for (const li of Array.from(root.querySelectorAll("li"))) style(li, "margin:0 0 2px 0");
		for (const pre of Array.from(root.querySelectorAll("pre"))) style(pre, "margin:0 0 10px 0;padding:8px;background:#f5f5f5;font-family:Consolas,monospace;font-size:0.9em");
		for (const list of Array.from(root.querySelectorAll("ul, ol"))) {
			// tight against the paragraph above it, which is the gap being complained
			// about, and indented by a step a mail client will actually apply
			style(list, "margin:0 0 10px 0;padding-left:28px");
			if (list instanceof HTMLOListElement) {
				let depth = 0;
				for (let p = list.parentElement; p; p = p.parentElement) {
					if (p === root) break;
					if (p.tagName === "OL") depth++;
				}
				// Both spellings, because clients honor different ones: the type
				// attribute is what Word and the old Outlook read, and the current
				// Outlook is the web client, whose editor rewrites a pasted list and
				// keeps only what it recognizes as styling. The style goes on each
				// item as well as the list: that rewrite can rebuild the <ol> around
				// items it keeps, and an item carrying its own marker survives it.
				list.setAttribute("type", olTypeForDepth(depth));
				const marker = `list-style-type:${olStyleForDepth(depth)}`;
				style(list, marker);
				for (const li of Array.from(list.children)) if (li.tagName === "LI") style(li, marker);
			}
		}
		// a list nested inside an item must not re-add the item's bottom gap
		for (const nested of Array.from(root.querySelectorAll("li > ul, li > ol"))) style(nested, "margin:2px 0 0 0");
	}

	/** Indent guides on numbered lists. Body class rather than a CodeMirror
	 *  extension: the guide is Obsidian's own chrome, so hiding it is a matter
	 *  of not painting it, in both views at once. */
	private outlineSheet: CSSStyleSheet | null = null;

	applyListGuides() {
		document.body.toggleClass("ped-no-ol-guides", this.settings.indentGuides === "no-ordered");
		document.body.toggleClass("ped-no-guides", this.settings.indentGuides === "none");
	}

	applyBlockGap() {
		const set = (cls: string, prop: string, raw: string) => {
			const px = Number(raw);
			const on = raw !== "off" && Number.isFinite(px) && px >= 0 && px <= 60;
			document.body.toggleClass(cls, on);
			if (on) document.body.style.setProperty(prop, px + "px");
			else document.body.style.removeProperty(prop);
		};
		set("ped-heading-gap", "--ped-heading-gap", this.settings.headingGap);
		set("ped-table-gap", "--ped-table-gap", this.settings.tableGap);
	}

	/** Reading view uses real <ol>, so multilevel numbering there is just
	 *  list-style-type per nesting depth, injected as a <style> and refreshed
	 *  when the config changes. The editor is handled by orderedListOutline. */
	applyOutlineCss() {
		// One list-style-type per nesting depth, chosen in settings, so the rules
		// cannot live in styles.css. A constructable sheet carries them without
		// putting an element in the document; below Safari 16.4 the numbering
		// simply stays at Obsidian's default.
		if (typeof CSSStyleSheet === "undefined" || !("replaceSync" in CSSStyleSheet.prototype)) return;
		if (!this.outlineSheet) {
			this.outlineSheet = new CSSStyleSheet();
			document.adoptedStyleSheets = [...document.adoptedStyleSheets, this.outlineSheet];
		}
		if (!this.settings.numberedOutline) {
			this.outlineSheet.replaceSync("");
			return;
		}
		const rules = this.settings.outlineStyles.map((style, d) => {
			const sel = ".markdown-rendered " + Array(d + 1).fill("ol").join(" ");
			return `${sel} { list-style-type: ${style}; }`;
		});
		this.outlineSheet.replaceSync(rules.join("\n"));
	}

	/** Rebuild editor extensions so live-reading decoration engines (outline
	 *  numbering, placeholders) pick up a settings change immediately. */
	refreshEditors() {
		this.app.workspace.updateOptions();
	}

	async loadSettings() {
		const disk = ((await this.loadData()) ?? {}) as Record<string, unknown>;
		// 1.29.0 had one gap setting for headings and tables together; 1.30.0
		// split them. Carry the old value into both so a device that set it
		// keeps what it chose instead of snapping back to the default.
		// the indent-guide toggle used to be a boolean meaning "numbered only"
		if (typeof disk.hideOrderedGuides === "boolean" && disk.indentGuides === undefined) {
			disk.indentGuides = disk.hideOrderedGuides ? "no-ordered" : "all";
		}
		// 1.37 had a two-way skin toggle; 1.38 replaced it with named themes
		if (typeof disk.codeBlockSkin === "string" && disk.codeTheme === undefined) {
			disk.codeTheme = disk.codeBlockSkin === "dark" ? "one-dark" : "default";
		}
		if (typeof disk.blockGap === "string") {
			if (disk.headingGap === undefined) disk.headingGap = disk.blockGap;
			if (disk.tableGap === undefined) disk.tableGap = disk.blockGap;
		}
		const next = Object.assign({}, DEFAULT_SETTINGS, disk);
		// same reason as persistSettings: adopting a synced write while the
		// settings tab is open must not swap the object out from under it
		if (this.settings) Object.assign(this.settings, next);
		else this.settings = next;
		this.baseline = structuredClone(this.settings);
	}

	/**
	 * The one write path, and it merges rather than overwrites.
	 *
	 * data.json is synced, so this file belongs to every device at once. Writing
	 * memory wholesale reverts whatever another device changed since this one last
	 * read it, and a setting nothing rewrites afterwards never comes back from
	 * that. Re-read, and carry only what WE changed.
	 *
	 * Every settings write goes through here. Six of them wrote the whole object
	 * straight out before, which is six chances to revert another device.
	 */
	async persistSettings() {
		const disk = (await this.loadData()) as Partial<PowerEditorSettings> | null;
		// merged IN PLACE, never swapped for a new object: the settings tab and
		// the modals capture this object once and write through that reference
		// (`const s = plugin.settings` then `s.key = v`). Replacing it would
		// strand every one of those writes on an orphan the moment the first
		// save landed, and the setting would silently stop sticking.
		Object.assign(this.settings, mergeForSave(this.settings, this.baseline, disk));
		await this.saveData(this.settings);
		this.baseline = structuredClone(this.settings);
	}

	/** Obsidian calls this when Sync lands another device's write. Adopting it
	 *  keeps this device from holding a stale snapshot it would later write back. */
	async onExternalSettingsChange() {
		await this.loadSettings();
	}

	/**
	 * Obsidian reports a throw in here as a bare "encountered an error while
	 * loading" with no detail, and on a phone there is no console to go and
	 * read. So the real message is caught and shown, and whatever managed to
	 * register before the throw stays registered, a partly working plugin
	 * beats one that silently does nothing.
	 */
	async onload() {
		try {
			await this.boot();
		} catch (e) {
			const msg = e instanceof Error ? `${e.message}` : String(e);
			console.error("Power Editor failed to load", e);
			new Notice(`Power Editor ${PED_BUILD} could not start: ${msg}`, 0);
		}
	}

	private async boot() {
		console.log(`Power Editor: code build ${PED_BUILD} loaded`);
		await this.loadSettings();
		this.addSettingTab(new PowerEditorSettingTab(this));
		// Ground-truth check for which code is actually running (Settings shows the
		// on-disk manifest version, which can differ from the loaded module).
		this.addCommand({
			id: "show-version", icon: "info",
			name: "Show running version",
			callback: () => new Notice(`Power Editor code build ${PED_BUILD} is running.`, 6000),
		});
		this.applyWysiwyg();
		this.applySpacing();
		this.applyListGuides();
		// a popover must survive its own opening click; close on any later press outside it
		this.registerDomEvent(document, "pointerdown", (e) => {
			const t = e.target as HTMLElement | null;
			if (this.colorPop && !t?.closest?.(".ped-colorpop")) this.closeColorPopover();
			if (this.imgBar && !t?.closest?.(".ped-imgbar")) this.closeImageBar();
		});
		// Froala-style image toolbar: click an image in the editor to get
		// align / size / alt / replace / delete right on top of it.
		this.registerDomEvent(document, "click", (e) => {
			if (this.imgDrag) return;
			const t = e.target as HTMLElement | null;
			const img = t instanceof HTMLImageElement && t.closest(".markdown-source-view") ? t : null;
			if (img) this.showImageBar(img);
		});

		this.app.workspace.onLayoutReady(() => this.ensureToolbars());
		this.registerEvent(this.app.workspace.on("layout-change", () => this.ensureToolbars()));
		this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.ensureToolbars()));

		// Sized images may grow past the readable column, but never past the
		// pane: each pane's free room per side is published as a CSS variable
		// that styles.css and the drag clamp both read.
		this.app.workspace.onLayoutReady(() => this.updateImageBleed());
		this.registerEvent(this.app.workspace.on("resize", () => this.updateImageBleed()));
		this.registerEvent(this.app.workspace.on("layout-change", () => this.updateImageBleed()));
		this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.updateImageBleed()));
		this.registerEditorSuggest(new SlashSuggest(this));
		// Enter at the visual start of a list item makes a new item above it.
		//
		// Splitting there is destructive rather than merely wrong. WYSIWYG hides
		// inline HTML and registers those spans as CodeMirror atomic ranges, and
		// clicking at the start of the visible text does NOT place a cursor - it
		// produces a SELECTION covering the hidden `<mark ...>` tag. Obsidian's
		// Enter then replaces that selection, and the item's whole content goes
		// with it. Measured in the editor: empty=false, head=17, contentStart=17,
		// with the selection running to the end of the hidden tag.
		//
		// So the test is not "is the cursor collapsed" but "is everything from
		// the list marker to the end of the selection just markup" - i.e. the
		// user is visually at the start of the item's text.
		//
		// This must run at the document capture phase; a CodeMirror keymap, even
		// at Prec.highest, never sees Enter because Obsidian handles it first.
		this.registerDomEvent(
			document,
			"keydown",
			(e: KeyboardEvent) => {
				if (e.key !== "Enter" || e.shiftKey || e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return;
				const view = this.app.workspace.getActiveViewOfType(MarkdownView);
				const cm = view ? this.cmOf(view) : null;
				if (!cm || !cm.hasFocus) return;
				const sel = cm.state.selection.main;
				const line = cm.state.doc.lineAt(sel.from);
				if (cm.state.doc.lineAt(sel.to).number !== line.number) return; // spans lines
				const m = /^(\s*)((?:[-*+])|(\d+)([.)]))\s+/.exec(line.text);
				if (!m) return;
				const contentStart = line.from + m[0].length;
				if (sel.from < contentStart) return;
				// Everything between the list marker and the START of the selection
				// must be hidden markup, so the user is visually on the item's first
				// character.
				if (!/^(?:<[^>]*>|\s)*$/.test(cm.state.doc.sliceString(contentStart, sel.from))) return;
				// The selection is then either collapsed there, or, the case that
				// destroyed content, the click expanded across the whole atomic
				// `<mark>...</mark>` span and runs to the end of the line. Measured
				// in the editor: from=17, to=130, with the line ending at 130. A
				// deliberate partial selection stops short of that and is left to
				// behave normally.
				if (sel.to !== sel.from && sel.to !== line.to) return;
				// an empty item is Obsidian's "end the list" case; leave it alone
				if (!stripTags(line.text.slice(m[0].length))) return;
				const lines = cm.state.doc.toString().split("\n");
				const res = insertItemAbove(lines, line.number - 1);

				if (!res) return;
				e.preventDefault();
				e.stopPropagation();
				// renumbering touches the rest of the run, so write only that span
				const d = narrowEdit(lines, res.lines);
				if (d.from > d.to && d.text.length === 0) return;
				const fromPos = cm.state.doc.line(d.from + 1).from;
				const pure = d.from > d.to;
				const toPos = pure ? fromPos : cm.state.doc.line(d.to + 1).to;
				cm.dispatch({
					changes: { from: fromPos, to: toPos, insert: d.text.join("\n") + (pure ? "\n" : "") },
					selection: { anchor: fromPos + (res.lines[res.caret]?.length ?? 0) },
					scrollIntoView: true,
				});
			},
			true
		);

		// Backspace or Delete at the end of a step that holds nothing but its
		// marker takes the step out, the way a word processor does.
		//
		// Otherwise the marker goes one character at a time: the space, then the
		// dot, then the number. Every one of those states is a line that is no
		// longer a list item, so the run breaks apart under the cursor and the
		// source numbering shows through where the rendered letters were: "d."
		// becomes "4." on the first press. Delete is worse, since it pulls the
		// next step onto this line instead of taking this one away, and that
		// step's marker lands in the middle of the line as text.
		this.registerDomEvent(
			document,
			"keydown",
			(e: KeyboardEvent) => {
				const back = e.key === "Backspace";
				if ((!back && e.key !== "Delete") || e.shiftKey || e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return;
				const view = this.app.workspace.getActiveViewOfType(MarkdownView);
				const cm = view ? this.cmOf(view) : null;
				if (!cm || !cm.hasFocus) return;
				const sel = cm.state.selection.main;
				if (!sel.empty) return;
				const doc = cm.state.doc;
				const line = doc.lineAt(sel.from);
				// only from the end of the line, so editing a marker on purpose is
				// still character by character
				if (sel.from !== line.to) return;
				if (back ? line.number === 1 : line.number === doc.lines) return; // nothing to fall back to
				const lines = doc.toString().split("\n");
				const res = removeItemAt(lines, line.number - 1);
				if (!res) return;
				e.preventDefault();
				e.stopPropagation();
				const d = narrowEdit(lines, res.lines);
				let from = doc.line(d.from + 1).from;
				let to = doc.line(d.to + 1).to;
				// a whole line and nothing to put back: the break goes with it, or
				// the line stays behind as an empty one
				if (!d.text.length) {
					if (d.to + 2 <= doc.lines) to = doc.line(d.to + 2).from;
					else from = doc.line(d.from).to;
				}
				cm.dispatch({
					changes: { from, to, insert: d.text.join("\n") },
					// backspace lands at the end of the step above; delete stays put,
					// at the words of the step that moved up into this one's place
					selection: { anchor: back ? doc.line(line.number - 1).to : line.from + listContentIndent(res.lines[line.number - 1] ?? "").length },
					scrollIntoView: true,
				});
			},
			true
		);

		// Enter inside a fenced code block: keep the block's left edge, and on a
		// blank last line, leave the block.
		//
		// A block that lives in a list item is indented to that item's content
		// column, and every line of it has to stay there. One line back at
		// column 0 ends the list, and the closing fence is then read as the
		// START of another block, so everything typed after it disappears into
		// code with no end. Leaving matters for the same reason: inside a fence
		// Enter can only ever add another line, so a block that ends a note, or
		// ends a step, has no keyboard way out at all, and one written as the
		// last thing in a note has nothing below it to click either. The blank
		// line is spent leaving, which is what makes the gesture Enter twice.
		this.registerDomEvent(
			document,
			"keydown",
			(e: KeyboardEvent) => {
				if (e.key !== "Enter" || e.shiftKey || e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return;
				const view = this.app.workspace.getActiveViewOfType(MarkdownView);
				const cm = view ? this.cmOf(view) : null;
				if (!cm || !cm.hasFocus) return;
				const sel = cm.state.selection.main;
				const doc = cm.state.doc;
				if (!sel.empty) return;
				const line = doc.lineAt(sel.from);
				if (FENCE_LINE.test(line.text)) return; // on the fence itself: Obsidian's own Enter
				if (!insideFence(doc.sliceString(0, line.from))) return;
				let open = line.number - 1;
				while (open > 1 && !FENCE_LINE.test(doc.line(open).text)) open--;
				const after = line.number < doc.lines ? doc.line(line.number + 1) : null;
				const leaving = !line.text.trim() && after && /^[ \t]*(?:`{3,}|~{3,})[ \t]*$/.test(after.text);
				const edge = fenceIndent(doc.line(open).text);
				if (!leaving && !edge) return; // a block at the left margin types as it always has
				e.preventDefault();
				e.stopPropagation();
				if (!leaving) {
					// the line's own indent, not the fence's: code indented inside
					// the block keeps that too
					const indent = /^[ \t]*/.exec(line.text)?.[0] ?? "";
					cm.dispatch({ changes: { from: sel.from, insert: "\n" + indent }, selection: { anchor: sel.from + 1 + indent.length }, scrollIntoView: true });
					return;
				}
				// inside a list the way on is the next step, so that is what the
				// line after the block is: marker written, ready to type into
				const next = nextItemAfterFence((n) => doc.line(n + 1).text, open - 1);
				const close = doc.line(line.number + 1);
				const del = line.to - line.from + 1; // the blank line, and the break before it
				cm.dispatch({
					changes: [
						{ from: line.from - 1, to: line.to },
						{ from: close.to, to: close.to, insert: "\n" + next },
					],
					selection: { anchor: close.to - del + 1 + next.length },
					scrollIntoView: true,
				});
			},
			true
		);

		this.registerEditorExtension(calloutTokenHider);
		this.registerEditorExtension(listTables(this));
		this.registerEditorExtension(codeBlockChrome);
		// the "Set language" chip on an unlabelled fence
		this.registerDomEvent(document, "click", (e) => {
			const btn = (e.target as HTMLElement | null)?.closest?.(".ped-cb-lang") as HTMLElement | null;
			if (!btn) return;
			e.preventDefault();
			e.stopPropagation();
			const line = Number(btn.getAttribute("data-ped-line") ?? "-1");
			const ed = this.activeEditor();
			// anchor on the chip, not the text cursor, the cursor is usually
			// somewhere else entirely, which puts the menu off screen
			if (ed && line >= 0) this.pickLanguageForFence(ed, line, btn);
		});
		// the filename chip at the left of a code block header
		this.registerDomEvent(document, "click", (e) => {
			const btn = (e.target as HTMLElement | null)?.closest?.(".ped-cb-file") as HTMLElement | null;
			if (!btn) return;
			e.preventDefault();
			e.stopPropagation();
			const line = Number(btn.getAttribute("data-ped-line") ?? "-1");
			const ed = this.activeEditor();
			if (ed && line >= 0) this.renameCodeBlock(ed, line);
		});
		// right-click a folder to upgrade just that corner of the vault, the
		// natural scope when one imported tree carries the old "Tip:" style
		this.registerEvent(
			this.app.workspace.on("file-menu", (menu, target) => {
				if (!(target instanceof TFolder)) return;
				menu.addItem((i) =>
					i
						.setTitle("Convert lead-ins into callouts…")
						.setIcon("lightbulb")
						.onClick(() => this.openCalloutConverter(target.path === "/" ? "" : target.path))
				);
			})
		);
		// Editable tabs: a `tabs` code block with `--- Title` pane markers. Each
		// pane renders as real markdown; click a pane to edit its content, and
		// edits write straight back to the block source. Without the plugin the
		// block degrades to readable fenced text.
		this.registerMarkdownCodeBlockProcessor("tabs", (source, el, ctx) => this.renderTabs(source, el, ctx));
		// Notion-style columns: a `columns` code block, panes split on `---`
		// lines (optionally `--- 2` for a wider column). Stacks on phones.
		this.registerMarkdownCodeBlockProcessor("columns", (source, el, ctx) => this.renderColumns(source, el, ctx));
		// Notion-style: the emoji in a rendered callout title is clickable and
		// swaps via the emoji picker. The postprocessor wraps it and stamps the
		// header's line so Reading view can write back too.
		this.registerMarkdownPostProcessor((el, ctx) => {
			el.querySelectorAll(".callout-title-inner").forEach((title) => {
				const node = title.firstChild;
				if (!node || node.nodeType !== Node.TEXT_NODE || !node.nodeValue) return;
				const m = /^\s*((?:\p{Extended_Pictographic}|\p{Emoji_Presentation})️?)/u.exec(node.nodeValue);
				if (!m) return;
				const rest = node.nodeValue.slice(m[0].length);
				const span = createSpan({ cls: "ped-callout-emoji", text: m[1], attr: { title: "Change emoji" } });
				node.nodeValue = rest;
				title.insertBefore(span, node);
				const callout = title.closest(".callout") as HTMLElement | null;
				// The emoji IS the icon here, so the type's own Lucide badge steps
				// aside, but only on callouts that actually carry one. A header
				// typed by hand keeps its badge and still reads as a tip. Live
				// preview hangs the icon off .cm-callout, outside .callout, so
				// both wrappers get flagged.
				callout?.addClass("ped-emoji-icon");
				(title.closest(".cm-callout") as HTMLElement | null)?.addClass("ped-emoji-icon");
				const info = callout ? ctx.getSectionInfo(callout) : null;
				if (callout && info) {
					callout.setAttribute("data-ped-line", String(info.lineStart));
					callout.setAttribute("data-ped-path", ctx.sourcePath);
				}
			});
		});
		this.registerDomEvent(document, "click", (e) => {
			const span = (e.target as HTMLElement | null)?.closest?.(".ped-callout-emoji") as HTMLElement | null;
			if (!span) return;
			e.preventDefault();
			e.stopPropagation();
			this.swapCalloutEmoji(span);
		});

		this.registerDomEvent(document, "copy", (e) => this.onEditorCopy(e));
		// A copy of ours coming home. Checked before anything else and regardless
		// of the clean-paste setting: the exact Markdown is right there in the
		// clipboard, so reading the HTML instead could only ever be a worse guess.
		this.registerEvent(
			this.app.workspace.on("editor-paste", (evt, editor) => {
				if (evt.defaultPrevented) return;
				const own = markdownFromMarker(evt.clipboardData?.getData("text/html"));
				if (own === null) return;
				evt.preventDefault();
				this.insertPasted(editor, own);
			})
		);
		// clean-Markdown pasting: strip Word/Outlook/web sludge before it lands
		this.registerEvent(
			this.app.workspace.on("editor-paste", (evt, editor) => {
				if (!this.settings.cleanPaste || evt.defaultPrevented) return;
				const md = this.pastedMarkdown(evt.clipboardData?.getData("text/html"), evt.clipboardData?.getData("text/plain"));
				if (md === null) return;
				evt.preventDefault();
				this.insertPasted(editor, md);
			})
		);
		// Plain text carries no HTML to clean, so it never reaches the cleaner,
		// but a code block copied from a terminal or from a chat's copy button
		// still lands wrong inside a list. Only the pastes the plan would
		// actually move are taken over; a single line never is, which leaves
		// Obsidian its link-on-selection, its attachments, and its embeds.
		this.registerEvent(
			this.app.workspace.on("editor-paste", (evt, editor) => {
				if (evt.defaultPrevented) return;
				const text = (evt.clipboardData?.getData("text/plain") ?? "").replace(/\r\n?/g, "\n");
				if (!text.includes("\n")) return;
				const planned = this.plannedPaste(editor, text);
				if (planned === text) return;
				evt.preventDefault();
				editor.replaceSelection(planned);
			})
		);
		this.addCommand({
			id: "paste-clean", icon: "clipboard-paste",
			name: "Paste as clean Markdown",
			editorCallback: async (ed) => {
				const plain = await navigator.clipboard.readText().catch(() => "");
				const md = this.pastedMarkdown(await this.clipboardHtml(), plain);
				this.insertPasted(ed, md ?? plain);
			},
		});
		this.addCommand({
			id: "paste-formats", icon: "clipboard-list",
			name: "Insert clipboard formats (paste troubleshooting)",
			editorCallback: async (ed) => {
				const html = await this.clipboardHtml();
				const plain = await navigator.clipboard.readText().catch(() => "");
				ed.replaceSelection(["```text", "--- text/plain ---", plain, "--- text/html ---", html ?? "(none on the clipboard)", "```", ""].join("\n"));
			},
		});
		// copying highlighted/colored text used to paste its raw <mark>/<span>
		// source into other apps; clean the clipboard's plain text on the way out
		this.registerDomEvent(document, "copy", (e) => this.onCopyOut(e, false), { capture: true });
		this.registerDomEvent(document, "cut", (e) => this.onCopyOut(e, true), { capture: true });

		// active-state repaints ride CM updates; cheap debounce keeps it calm
		this.registerEditorExtension(
			EditorView.updateListener.of((u) => {
				if (u.selectionSet || u.docChanged || u.focusChanged) {
					this.queueStateRefresh();
					this.queueBubbleUpdate();
				}
			})
		);
		this.registerEditorExtension(wysiwygDecorations(this));
		this.registerEditorExtension(headingPlaceholders(this));
		this.registerEditorExtension(headingInputFix(this));
		this.registerEditorExtension(headingCursorGuard(this));
		this.registerEditorExtension(orderedListOutline(this));
		this.registerEditorExtension(liveTaskCheckbox(this));
		this.applyOutlineCss();
		// Reading view: apply alignment markers there too (comments survive into
		// the rendered DOM as comment nodes; find them and style their block)
		this.registerMarkdownPostProcessor((el) => {
			const walker = document.createTreeWalker(el, NodeFilter.SHOW_COMMENT);
			let node: Node | null;
			while ((node = walker.nextNode())) {
				const m = node.nodeValue?.match(/^al:(center|right)$/);
				if (m && node.parentElement) node.parentElement.style.textAlign = m[1];
			}
		});

		this.addCommand({
			id: "toggle-toolbar", icon: "panel-top",
			name: "Toggle the formatting toolbar",
			callback: () => {
				this.settings.showToolbar = !this.settings.showToolbar;
				void this.persistSettings();
				this.ensureToolbars();
			},
		});
		this.addCommand({
			id: "toggle-block", icon: "chevron-right",
			name: "Toggle block (collapsible)",
			editorCallback: (ed) => this.toggleBlock(ed),
		});
		this.addCommand({
			id: "toggle-list",
			name: "Toggle list (Notion-style)",
			editorCallback: (ed) => this.toggleListBlock(ed),
		});
		this.addCommand({
			id: "callout",
			name: "Callout: pick a flavor",
			icon: "lightbulb",
			editorCallback: (ed) => this.pickCalloutAtCursor(ed),
		});
		// each flavor is its own bindable command, a hotkey straight to a tip
		for (const f of CALLOUT_FLAVORS) {
			this.addCommand({
				id: `callout-${f.type}`,
				name: `Callout: ${f.label}`,
				icon: f.icon,
				editorCallback: (ed) => this.calloutOfType(ed, f.type),
			});
		}
		// notes written before callouts existed carry their type as a lead-in
		// label; these upgrade them, one note or the whole vault
		this.addCommand({
			id: "callout-convert-note",
			name: "Callouts: convert Tip/Note/Warning lead-ins in this note",
			icon: "wand-2",
			editorCallback: (ed) => this.convertLeadsInNote(ed, false),
		});
		this.addCommand({
			id: "callout-convert-note-bare",
			name: "Callouts: convert lead-ins in this note (including labels without bold)",
			icon: "wand-2",
			editorCallback: (ed) => this.convertLeadsInNote(ed, true),
		});
		this.addCommand({
			id: "callout-convert-vault",
			name: "Callouts: convert lead-ins across the vault…",
			icon: "wand-2",
			callback: () => this.openCalloutConverter(),
		});
		this.addCommand({
			id: "code-block",
			name: "Code block (pick a language)",
			icon: "code-square",
			editorCallback: (ed) => this.insertCodeBlock(ed),
		});
		this.addCommand({
			id: "code-block-language",
			name: "Code block: set the language",
			icon: "code-square",
			editorCallback: (ed) => this.setCodeBlockLanguage(ed),
		});
		this.addCommand({ id: "move-block-up", icon: "arrow-up", name: "Move block up", editorCallback: (ed) => this.moveBlockBy(ed, -1) });
		this.addCommand({ id: "move-block-down", name: "Move block down", editorCallback: (ed) => this.moveBlockBy(ed, 1) });
		this.addCommand({ id: "dictate", name: "Dictate at the cursor (start/stop)", icon: "mic", editorCallback: (ed) => void this.toggleDictation(ed) });
		// every toolbar action as a bindable command
		this.addCommand({ id: "underline", icon: "underline", name: "Underline", editorCallback: (ed) => this.toggleWrap(ed, "<u>", "</u>") });
		this.addCommand({ id: "clear-formatting", name: "Clear formatting", editorCallback: (ed) => this.clearFormatting(ed) });
		this.addCommand({
			id: "clean-note-highlights",
			name: "Highlights: clean up in this note",
			icon: "highlighter",
			editorCallback: (ed) => this.cleanNoteHighlights(ed),
		});
		this.addCommand({
			id: "clean-note-placeholder-tags",
			name: "Clean this note: escape placeholder tags",
			icon: "wand-2",
			editorCallback: (ed) => this.escapeTagsInNote(ed),
		});
		this.addCommand({
			id: "clean-vault-placeholder-tags",
			name: "Clean the vault: escape placeholder tags…",
			icon: "wand-2",
			callback: () => this.openPlaceholderSweep(),
		});
		this.addCommand({
			id: "clean-vault-highlights",
			name: "Highlights: clean up across the vault",
			icon: "highlighter",
			callback: () => void this.cleanVaultHighlights(),
		});
		this.addCommand({
			id: "convert-highlight-emphasis",
			name: "Highlights: make bold and italic render (this note)",
			icon: "bold",
			editorCallback: (ed) => {
				const prev = ed.getValue().split("\n");
				const res = convertEmphasisInWrappers(prev.join("\n"));
				if (!res.count) {
					new Notice("No Markdown bold or italic inside highlights here.");
					return;
				}
				this.applyDoc(ed, prev, res.text.split("\n"), ed.getCursor().line);
				new Notice(`Fixed emphasis in ${res.count} highlight${res.count === 1 ? "" : "s"}.`);
			},
		});
		this.addCommand({ id: "format-painter", icon: "paintbrush", name: "Format painter (paint once)", editorCallback: (ed) => this.armPainter(ed) });
		this.addCommand({ id: "insert-link", icon: "link", name: "Insert or edit link", editorCallback: (ed) => this.openLinkDialog(ed) });
		// right-clicking a link: core's "Edit link" only selects the markdown
		// (which WYSIWYG keeps hidden, so it looks like a no-op), offer the
		// Link dialog instead, which also understands bare pasted URLs
		this.registerEvent(
			this.app.workspace.on("editor-menu", (menu, editor) => {
				const cur = editor.getCursor();
				if (!linkAt(editor.getLine(cur.line), cur.ch)) return;
				menu.addItem((i) =>
					i.setTitle("Edit link (Power Editor)").setIcon("link").setSection("selection").onClick(() => this.openLinkDialog(editor))
				);
			})
		);
		this.addCommand({
			id: "copy-rich-text",
			name: "Copy as rich text (for email)",
			icon: "clipboard-type",
			editorCallback: (ed) => void this.copyRichText(ed),
		});
		this.registerEvent(
			this.app.workspace.on("editor-menu", (menu, editor) => {
				if (!editor.getSelection()) return;
				menu.addItem((i) =>
					i.setTitle("Copy as rich text").setIcon("clipboard-type").setSection("selection").onClick(() => void this.copyRichText(editor))
				);
			})
		);
		this.addCommand({ id: "align-left", icon: "align-left", name: "Align left", editorCallback: (ed) => this.applyAlign(ed, "left") });
		this.addCommand({ id: "align-center", icon: "align-center", name: "Align center", editorCallback: (ed) => this.applyAlign(ed, "center") });
		this.addCommand({ id: "align-right", name: "Align right", editorCallback: (ed) => this.applyAlign(ed, "right") });
		this.addCommand({ id: "indent-more", name: "Increase indent", icon: "indent-increase", editorCallback: (ed) => this.indent(ed, 1) });
		this.addCommand({ id: "indent-less", name: "Decrease indent", icon: "indent-decrease", editorCallback: (ed) => this.indent(ed, -1) });
		this.addCommand({ id: "insert-photo", name: "Insert photo (camera or library)", icon: "camera", editorCallback: (ed) => this.insertPhoto(ed) });
		this.addCommand({
			id: "dismiss-keyboard",
			name: "Dismiss the keyboard",
			icon: "keyboard",
			callback: () => (document.activeElement instanceof HTMLElement ? document.activeElement.blur() : undefined),
		});
		this.applyMobileToolbar();

		// To-dos: completing a checkbox in Live Preview stamps ✅ and spawns the
		// next occurrence of 🔁 items. Capture phase, so it wins over the
		// editor's own plain [x] flip; non-task checkboxes fall through.
		this.registerDomEvent(document, "mousedown", (e) => this.onTodoCheckboxClick(e), { capture: true });
		// The mousedown above already completed the item. Preventing its default
		// does NOT stop the click that follows, and that click reaches the
		// editor's own checkbox handler, which flipped the line straight back to
		// [ ] and left the ✅ stamp stranded. Swallow that one click.
		this.registerDomEvent(
			document,
			"click",
			(e) => {
				if (!this.todoHandled) return;
				this.todoHandled = false; // a click elsewhere just clears the guard
				const t = e.target;
				if (t instanceof HTMLInputElement && t.hasClass("task-list-item-checkbox")) {
					e.preventDefault();
					e.stopPropagation();
				}
			},
			{ capture: true }
		);
		// Keep the caret out of a heading's hidden "# " marker. The CM transaction
		// filter that does this doesn't apply to already-open notes until they're
		// rebuilt, so do it here too, a DOM handler takes effect immediately.
		// The marker is zero-width when hidden, so this correction is invisible.
		this.registerDomEvent(document, "mouseup", () => window.setTimeout(() => this.snapHeadingCaret(), 0));
		this.registerDomEvent(document, "keyup", (e) => {
			if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(e.key))
				window.setTimeout(() => this.snapHeadingCaret(), 0);
		});
		this.addCommand({ id: "todo-due", name: "To-do: set due date", icon: "calendar", editorCallback: (ed) => this.promptTodoToken(ed, "due") });
		this.addCommand({ id: "todo-recur", name: "To-do: make recurring", icon: "refresh-cw", editorCallback: (ed) => this.promptTodoToken(ed, "recur") });
		// `todo` dashboard blocks: Tasks-style queries over the whole vault.
		// Without the plugin they degrade to readable fenced text.
		this.registerMarkdownCodeBlockProcessor("todo", (source, el, ctx) => {
			ctx.addChild(new TodoBlock(el, source, this));
		});
		// reading view: stamp each checkbox with its absolute source line so
		// the capture handler can complete it with stamping and recurrence
		this.registerMarkdownPostProcessor((el, ctx) => {
			const boxes = el.findAll("input.task-list-item-checkbox");
			if (!boxes.length) return;
			const info = ctx.getSectionInfo(el);
			if (!info) return;
			for (const box of boxes) {
				const rel = box.closest("li.task-list-item")?.getAttr("data-line");
				if (rel != null) {
					box.setAttr("data-ped-line", String(info.lineStart + Number(rel)));
					box.setAttr("data-ped-path", ctx.sourcePath);
				}
			}
		});
		this.addCommand({ id: "todo-capture", name: "To-do: quick capture", icon: "list-plus", callback: () => this.quickCapture() });
		this.addCommand({ id: "open-today", name: "Open the Today pane", icon: "calendar-check", callback: () => void this.activateTodayView() });
		this.registerView(TODAY_VIEW, (leaf) => new TodayView(leaf, this));
		this.addRibbonIcon("calendar-check", "Today's to-dos", () => void this.activateTodayView());

		// Notion page features: covers, inline comments, verification
		this.registerEditorExtension(commentChips(this));
		this.addCommand({ id: "add-comment", name: "Add comment", icon: "message-circle", editorCallback: (ed) => this.addComment(ed) });
		this.addCommand({ id: "add-cover", name: "Add or change cover", icon: "image", callback: () => this.openCoverMenu() });
		this.addCommand({ id: "insert-columns", name: "Insert columns layout", icon: "columns-2", editorCallback: (ed) => this.insertColumnsMenu(ed) });
		this.addCommand({ id: "page-options", name: "Page options (width, font, cover)", icon: "layout", callback: () => this.openPageOptions() });
		this.addCommand({
			id: "verify-note",
			name: "Verify this note",
			icon: "badge-check",
			callback: () => {
				const f = this.app.workspace.getActiveViewOfType(MarkdownView)?.file;
				if (f) this.openVerifyMenu(undefined, f);
			},
		});
		this.registerEvent(this.app.workspace.on("file-open", () => this.updatePageChrome()));
		this.registerEvent(this.app.workspace.on("layout-change", () => this.updatePageChrome()));
		this.registerEvent(this.app.metadataCache.on("changed", () => this.updatePageChrome()));
		this.app.workspace.onLayoutReady(() => this.updatePageChrome());
		// mtime moves when the file is written, which metadataCache "changed"
		// does not always follow (a body edit with no frontmatter change)
		this.registerEvent(this.app.vault.on("modify", () => this.updatePageChrome()));
		// "3 minutes ago" has to age on its own or it stays "just now" for the
		// whole session. A minute is as fine as the wording ever gets.
		this.registerInterval(window.setInterval(() => this.refreshEditedStamps(), 60_000));
		this.addCommand({
			id: "page-icon",
			name: "Add or change page icon",
			icon: "smile",
			callback: () => {
				const f = this.app.workspace.getActiveViewOfType(MarkdownView)?.file;
				if (f) this.openIconMenu(undefined, f);
			},
		});
		this.addCommand({
			id: "archive-done",
			name: "Archive completed to-dos (into a Done section)",
			icon: "archive",
			editorCallback: (ed) => {
				const lines = ed.getValue().split("\n");
				const res = archiveCompleted(lines);
				if (!res.moved) {
					new Notice("Nothing completed to archive.");
					return;
				}
				this.applyDoc(ed, lines, res.lines, 0);
				new Notice(`Archived ${res.moved} completed to-do${res.moved === 1 ? "" : "s"}.`);
			},
		});
		this.registerView(COMMENTS_VIEW, (leaf) => new CommentsView(leaf, this));
		this.addCommand({ id: "open-comments", name: "Open the Comments pane", icon: "message-circle", callback: () => void this.activatePane(COMMENTS_VIEW) });
		// live table of contents for the current note
		this.registerMarkdownCodeBlockProcessor("toc", (source, el, ctx) => {
			ctx.addChild(new TocBlock(el, source, ctx.sourcePath, this));
		});
		// reminders: a due-today digest at launch, ⏰ notices while the app is open
		this.app.workspace.onLayoutReady(() => void this.todoDigest());
		this.registerInterval(window.setInterval(() => void this.todoReminderTick(), 60000));

		if (Platform.isDesktopApp) {
			this.registerDomEvent(document, "pointermove", (e) => this.onPointerMove(e));
			this.registerDomEvent(document, "pointermove", (e) => this.trackImageHover(e));
			this.registerDomEvent(document, "pointerup", () => {
				if (this.dragging) {
					const d = this.dragging;
					if (!d.moved) {
						// a plain click on the grip opens the block menu instead
						this.endDrag(null);
						this.openBlockMenu(d.view, d.range);
						return;
					}
					this.endDrag(d.target != null ? { target: d.target } : null);
					return;
				}
				if (this.painter) window.setTimeout(() => this.tryPaint(), 10);
			});
			this.registerDomEvent(document, "keydown", (e) => {
				if (e.key !== "Escape") return;
				if (this.dragging) this.endDrag(null);
				if (this.painter) {
					this.painter = null;
					this.paintButtons(false);
				}
			});
			this.registerDomEvent(document, "wheel", () => this.bubbleEl?.hide());
		}
	}

	onunload() {
		if (this.recorder) {
			this.recorder.onstop = null;
			this.recorder.stream.getTracks().forEach((t) => t.stop());
			this.recorder.stop();
			this.recorder = null;
		}
		this.endDrag(null);
		this.handleEl?.remove();
		this.dropEl?.remove();
		this.bubbleEl?.remove();
		this.colorPop?.remove();
		if (this.outlineSheet) {
			const sheet = this.outlineSheet;
			document.adoptedStyleSheets = document.adoptedStyleSheets.filter((x) => x !== sheet);
			this.outlineSheet = null;
		}
		for (const g of this.imgGrips) g.remove();
		this.imgBadge?.remove();
		document.body.removeClass("ped-wys");
		document.body.removeClass("ped-lh-compact");
		document.body.removeClass("ped-lh-relaxed");
		document.body.removeClass("ped-imgresizing");
		for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
			const view = leaf.view as MarkdownView;
			view.containerEl.querySelector(":scope > .ped-toolbar")?.remove();
		}
	}

	/* ---------------- toolbar lifecycle ---------------- */

	/** Mobile bar: swap Obsidian's above-keyboard toolbar commands for the
	 *  quick-capture set. Obsidian's toolbar already docks to the keyboard, so
	 *  only the command list and skin change; the user's own arrangement is
	 *  saved once and restored when the setting is turned off. */
	applyMobileToolbar() {
		if (!Platform.isMobile) return;
		const vault = this.app.vault as unknown as {
			getConfig(key: string): unknown;
			setConfig(key: string, value: unknown): void;
		};
		const current = (vault.getConfig("mobileToolbarCommands") as string[] | undefined) ?? [];
		if (this.settings.onenoteMobileToolbar) {
			document.body.addClass("ped-mobile-bar");
			if (JSON.stringify(current) === JSON.stringify(MOBILE_TOOLBAR)) return;
			// only the user's own arrangement is worth keeping, never overwrite
			// the backup with an older bar set from a previous plugin version
			if (this.readToolbarBackup() == null) this.writeToolbarBackup(current);
			vault.setConfig("mobileToolbarCommands", MOBILE_TOOLBAR);
		} else {
			document.body.removeClass("ped-mobile-bar");
			const backup = this.readToolbarBackup();
			if (backup) {
				vault.setConfig("mobileToolbarCommands", backup);
				this.writeToolbarBackup(null);
				// turning the toolbar off IS a user action, so clearing the
				// legacy copy here is a save worth making
				if (this.settings.mobileToolbarBackup) {
					this.settings.mobileToolbarBackup = null;
					void this.persistSettings();
				}
			}
		}
	}

	/**
	 * The toolbar backup lives in localStorage, not in settings.
	 *
	 * It used to be saved with the settings, which meant a phone wrote its
	 * data.json seconds into its FIRST launch, before any setting had been
	 * touched. On a new device that file is factory defaults, and it then
	 * competes with the real settings arriving from sync, newer by the clock
	 * and wrong in every value. Nothing here is worth that: the backup
	 * describes this device's own toolbar, is meaningless on any other, and
	 * is not something the fleet should agree on.
	 *
	 * Keyed by vault so two vaults on one phone keep their own, and read
	 * through the legacy settings key first so a device that saved one there
	 * still restores it.
	 */
	private toolbarBackupKey(): string {
		return `ped-mobile-toolbar-backup:${this.app.vault.getName()}`;
	}

	private readToolbarBackup(): string[] | null {
		if (this.settings.mobileToolbarBackup) return this.settings.mobileToolbarBackup;
		try {
			const raw = window.localStorage.getItem(this.toolbarBackupKey());
			if (!raw) return null;
			const v: unknown = JSON.parse(raw);
			return Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]) : null;
		} catch {
			return null; // unavailable or unreadable storage: no backup, never a crash
		}
	}

	private writeToolbarBackup(list: string[] | null) {
		try {
			if (list) window.localStorage.setItem(this.toolbarBackupKey(), JSON.stringify(list));
			else window.localStorage.removeItem(this.toolbarBackupKey());
		} catch {
			/* storage full or blocked: the swap still works, only the undo is lost */
		}
	}

	/** The camera button: system photo picker (camera or library), saved into
	 *  the vault's attachment folder and embedded at the cursor. */
	insertPhoto(ed: Editor) {
		const input = createEl("input", { type: "file", attr: { accept: "image/*" } });
		input.addEventListener("change", () => {
			void (async () => {
				const f = input.files?.[0];
				if (!f) return;
				const source = this.app.workspace.getActiveViewOfType(MarkdownView)?.file?.path ?? "";
				const dest = await this.app.fileManager.getAvailablePathForAttachment(f.name || `Photo ${Date.now()}.jpg`, source);
				const file = await this.app.vault.createBinary(dest, await f.arrayBuffer());
				let link = this.app.fileManager.generateMarkdownLink(file, source);
				if (!link.startsWith("!")) link = "!" + link;
				ed.replaceSelection(link);
			})();
		});
		input.click();
	}

	/** Checkbox clicks in Live Preview, seen before the editor's own handler:
	 *  completing a to-do stamps ✅ (per setting) and a 🔁 item spawns its next
	 *  occurrence on the line above itself. */
	/** Set once our mousedown has completed an item, so the click that follows
	 *  can be swallowed before the editor's own checkbox handler flips it back. */
	private todoHandled = false;

	private onTodoCheckboxClick(e: MouseEvent) {
		const target = e.target;
		if (!(target instanceof HTMLInputElement) || !target.hasClass("task-list-item-checkbox")) return;
		if (!target.closest(".markdown-source-view.mod-cm6")) {
			// reading view: the post-processor stamped the absolute source
			// position onto the box, so completion behaves exactly like LP
			const path = target.getAttr("data-ped-path");
			const lineNo = Number(target.getAttr("data-ped-line"));
			if (!path || Number.isNaN(lineNo)) return;
			const file = this.app.vault.getAbstractFileByPath(path);
			if (!(file instanceof TFile)) return;
			e.preventDefault();
			e.stopPropagation();
			this.todoHandled = true;
			void this.app.vault.process(file, (data) => {
				const lines = data.split("\n");
				const res = lines[lineNo] != null ? toggleTodo(lines[lineNo], todayStr(), this.settings.stampDoneDates) : null;
				if (!res) return data;
				lines.splice(lineNo, 1, ...(res.spawned != null ? [res.spawned, res.line] : [res.line]));
				return lines.join("\n");
			});
			return;
		}
		for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
			const view = leaf.view as MarkdownView;
			if (!view.containerEl.contains(target)) continue;
			const cm = (
				view.editor as unknown as {
					cm?: {
						dom: HTMLElement;
						posAtDOM(n: Node): number;
						dispatch(spec: unknown): void;
						state: { doc: { lineAt(pos: number): { from: number; to: number; text: string } } };
					};
				}
			).cm;
			if (!cm) return;
			// a checkbox inside a tab-pane editor is NOT in the host editor's
			// document, mapping it through the host cm would edit the wrong
			// line. Let the pane's own editor handle it natively.
			if (!cm.dom.contains(target)) return;
			let line: { from: number; to: number; text: string };
			try {
				line = cm.state.doc.lineAt(cm.posAtDOM(target));
			} catch {
				return;
			}
			const res = toggleTodo(line.text, todayStr(), this.settings.stampDoneDates);
			if (!res) return;
			e.preventDefault();
			e.stopPropagation();
			this.todoHandled = true;
			const insert = res.spawned != null ? res.spawned + "\n" + res.line : res.line;
			cm.dispatch({ changes: { from: line.from, to: line.to, insert } });
			return;
		}
	}

	/** Add or replace 📅 / 🔁 on the line under the cursor, making it a
	 *  checklist item first when it isn't one. */
	private promptTodoToken(ed: Editor, kind: "due" | "recur") {
		const lineNo = ed.getCursor().line;
		let text = ed.getLine(lineNo);
		if (!parseTodo(text)) {
			const lm = text.match(/^(\s*)(?:[-*+]|\d+[.)])\s+(.*)$/);
			text = lm ? `${lm[1]}- [ ] ${lm[2]}` : `${text.match(/^\s*/)?.[0] ?? ""}- [ ] ${text.trim()}`;
		}
		const t = parseTodo(text);
		if (!t) return;
		const heading = kind === "due" ? "Due date (YYYY-MM-DD)" : "Repeat (e.g. every 6 months, every monday)";
		const initial = kind === "due" ? (t.due ?? todayStr()) : (t.recurrence ?? "every week");
		new TextPromptModal(this.app, heading, initial, (raw) => {
			const v = raw.trim();
			if (kind === "due") {
				if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return;
				t.due = v;
			} else if (v) {
				t.recurrence = v;
			} else {
				delete t.recurrence;
			}
			ed.setLine(lineNo, formatTodo(t));
		}).open();
	}

	/** Every checklist line in the vault, located via the metadata cache so
	 *  only files that actually contain tasks get read. */
	async collectTodos(): Promise<TodoItem[]> {
		const out: TodoItem[] = [];
		for (const f of this.app.vault.getMarkdownFiles()) {
			const cache = this.app.metadataCache.getFileCache(f);
			if (!cache?.listItems?.some((li) => li.task !== undefined)) continue;
			const lines = (await this.app.vault.cachedRead(f)).split("\n");
			for (const li of cache.listItems) {
				if (li.task === undefined) continue;
				const n = li.position.start.line;
				const t = parseTodo(lines[n] ?? "");
				if (t) out.push({ ...t, path: f.path, line: n });
			}
		}
		return out;
	}

	/** Guarded source edit: the line index came from render time, so nothing
	 *  happens when the line no longer holds the same item. Every remote edit
	 *  offers a five-second Undo toast, dashboards and panes edit other
	 *  files, outside those notes' Ctrl+Z. */
	private async editTodoLine(t: TodoItem, change: (line: string) => string[] | null) {
		const file = this.app.vault.getAbstractFileByPath(t.path ?? "");
		if (!(file instanceof TFile)) return;
		const at = t.line ?? -1;
		let before: string[] | null = null;
		let after: string[] | null = null;
		await this.app.vault.process(file, (data) => {
			const lines = data.split("\n");
			if (at < 0 || lines[at] == null) return data;
			const now = parseTodo(lines[at]);
			if (!now || now.body !== t.body) return data;
			const next = change(lines[at]);
			if (!next) return data;
			before = [lines[at]];
			after = next;
			lines.splice(at, 1, ...next);
			return lines.join("\n");
		});
		const b = before as string[] | null;
		const a = after as string[] | null;
		if (b && a) this.offerUndo(file, at, b, a);
	}

	private offerUndo(file: TFile, at: number, before: string[], after: string[]) {
		const frag = document.createDocumentFragment();
		frag.appendChild(document.createTextNode("Updated. "));
		const link = document.createElement("a");
		link.textContent = "Undo";
		frag.appendChild(link);
		const notice = new Notice(frag, 5000);
		link.addEventListener("click", () => {
			notice.hide();
			void this.app.vault.process(file, (data) => {
				const lines = data.split("\n");
				const cur = lines.slice(at, at + after.length);
				if (JSON.stringify(cur) !== JSON.stringify(after)) return data;
				lines.splice(at, after.length, ...before);
				return lines.join("\n");
			});
		});
	}

	toggleTodoAt(t: TodoItem) {
		return this.editTodoLine(t, (line) => {
			const res = toggleTodo(line, todayStr(), this.settings.stampDoneDates);
			return res ? (res.spawned != null ? [res.spawned, res.line] : [res.line]) : null;
		});
	}

	setTodoDue(t: TodoItem, date: string | null) {
		return this.editTodoLine(t, (line) => {
			const next = setDueDate(line, date);
			return next != null ? [next] : null;
		});
	}

	setTodoPriority(t: TodoItem, priority: number) {
		return this.editTodoLine(t, (line) => {
			const next = setPriority(line, priority);
			return next != null ? [next] : null;
		});
	}

	/** One dashboard/pane row: live checkbox, body, snoozable due chip,
	 *  recurrence hint, and a link to the source note. */
	renderTodoItem(list: HTMLElement, t: TodoItem) {
		const row = list.createDiv({ cls: "ped-todo-item" + (t.checked ? " is-done" : "") });
		const box = row.createEl("input", { cls: "ped-todo-box", attr: { type: "checkbox" } });
		box.checked = t.checked;
		box.addEventListener("mousedown", (e) => {
			e.preventDefault();
			void this.toggleTodoAt(t);
		});
		row.createSpan({ cls: "ped-todo-text", text: t.body });
		const due = row.createSpan({
			cls:
				"ped-todo-due" +
				(t.due ? "" : " is-empty") +
				(t.due && !t.checked && t.due < todayStr() ? " is-overdue" : ""),
			text: t.due ? "📅 " + t.due : "📅",
			attr: { "aria-label": "Reschedule" },
		});
		due.addEventListener("click", (e) => this.openSnoozeMenu(t, e));
		if (t.recurrence) row.createSpan({ cls: "ped-todo-recur", text: "🔁 " + t.recurrence });
		const src = row.createSpan({
			cls: "ped-todo-src",
			text: (t.path ?? "").replace(/\.md$/, "").split("/").pop() ?? "",
		});
		src.addEventListener("click", () => {
			void this.app.workspace.openLinkText(t.path ?? "", "", false, { eState: { line: t.line } });
		});
	}

	/** Tap the 📅 chip: today / tomorrow / next week / pick / remove. The
	 *  picker takes phrases ("next friday", "aug 1"), not just dates. */
	private openSnoozeMenu(t: TodoItem, e: MouseEvent) {
		const menu = new Menu();
		const today = todayStr();
		const set = (date: string | null) => void this.setTodoDue(t, date);
		menu.addItem((i) => i.setTitle("Today").setIcon("calendar-check").onClick(() => set(today)));
		menu.addItem((i) => i.setTitle("Tomorrow").setIcon("calendar").onClick(() => set(isoAddDays(today, 1))));
		menu.addItem((i) => i.setTitle("Next week").setIcon("calendar-plus").onClick(() => set(parseDatePhrase("next week", today))));
		menu.addItem((i) =>
			i.setTitle("Pick date…").setIcon("calendar-search").onClick(() => {
				new TextPromptModal(this.app, "Due date, a date or phrase like 'next friday' or 'aug 1'", t.due ?? today, (raw) => {
					const d = parseDatePhrase(raw, todayStr());
					if (d) set(d);
					else new Notice("Power Editor: couldn't read that as a date.");
				}).open();
			})
		);
		if (t.due) menu.addItem((i) => i.setTitle("Remove due date").setIcon("calendar-x").onClick(() => set(null)));
		menu.showAtMouseEvent(e);
	}

	/** Quick capture: one natural-language line into the inbox note from
	 *  anywhere, "rotate tires every 6 months starting aug 1". */
	quickCapture() {
		new TextPromptModal(this.app, "Add a to-do, try 'call bob tomorrow' or 'rotate tires every 6 months'", "", (raw) => {
			if (!raw.trim()) return;
			const parsed = parseQuickTodo(raw, todayStr());
			const t = parseTodo(`- [ ] ${parsed.body || raw.trim()}`);
			if (!t) return;
			if (parsed.due) t.due = parsed.due;
			if (parsed.recurrence) t.recurrence = parsed.recurrence;
			void this.appendToInbox(formatTodo(t));
		}).open();
	}

	private async appendToInbox(line: string) {
		const path = this.settings.inboxNote.trim() || "Inbox.md";
		let file = this.app.vault.getAbstractFileByPath(path);
		if (!file) {
			const dir = path.split("/").slice(0, -1).join("/");
			if (dir && !this.app.vault.getAbstractFileByPath(dir)) {
				try {
					await this.app.vault.createFolder(dir);
				} catch {
					/* raced or already there */
				}
			}
			file = await this.app.vault.create(path, "");
		}
		if (!(file instanceof TFile)) {
			new Notice("Inbox path is a folder: " + path);
			return;
		}
		await this.app.vault.process(file, (data) => (data.trim() ? data.replace(/\s*$/, "\n") : "") + line + "\n");
		new Notice("Added: " + line.replace(/^\s*- \[ \] /, ""));
	}

	async activateTodayView() {
		await this.activatePane(TODAY_VIEW);
	}

	private async activatePane(type: string) {
		const existing = this.app.workspace.getLeavesOfType(type)[0];
		const leaf = existing ?? this.app.workspace.getRightLeaf(false);
		if (!leaf) return;
		if (!existing) await leaf.setViewState({ type, active: true });
		await this.app.workspace.revealLeaf(leaf);
	}

	/** The launch digest: how much is due (and overdue) today, one click from
	 *  the Today pane. Quiet when there's nothing to say. */
	private async todoDigest() {
		if (!this.settings.todoReminders) return;
		const today = todayStr();
		const open = (await this.collectTodos()).filter((t) => !t.checked && t.due != null && t.due <= today);
		if (!open.length) return;
		const overdue = open.filter((t) => t.due != null && t.due < today).length;
		const notice = new Notice(
			`${open.length} to-do${open.length === 1 ? "" : "s"} due today${overdue ? ` (${overdue} overdue)` : ""}, click to open Today`,
			10000
		);
		notice.noticeEl.addEventListener("click", () => {
			notice.hide();
			void this.activateTodayView();
		});
	}

	private notified = new Set<string>();

	/** Which tab is active per tabs block (keyed by note path + start line), so
	 *  the choice survives the re-render that a content edit triggers. */
	private tabActive = new Map<string, number>();

	/** Whether the real embedded-editor panes are available; flips false once
	 *  if Obsidian's internals move, and tabs fall back to the textarea panes. */
	private paneEditorsOk = true;

	/** Editable Notion-style tabs. The active pane hosts a real Obsidian
	 *  markdown editor (paneeditor.ts): live preview, slash commands, native
	 *  list handling, and the toolbar all work inside it, and edits write back
	 *  into the `tabs` code block on blur / tab switch / teardown. If the
	 *  internal editor can't be built, falls back to the textarea panes. */
	private renderTabs(source: string, el: HTMLElement, ctx: MarkdownPostProcessorContext) {
		if (!this.paneEditorsOk) {
			this.renderTabsBasic(source, el, ctx);
			return;
		}
		const panes = parseTabs(source);
		if (!panes.length) panes.push({ title: "Tab 1", body: "" });
		const child = new MarkdownRenderChild(el);
		ctx.addChild(child);
		const key = `${ctx.sourcePath}:${ctx.getSectionInfo(el)?.lineStart ?? -1}`;
		let active = Math.max(0, Math.min(this.tabActive.get(key) ?? 0, panes.length - 1));
		let pane: PaneEditor | null = null;
		let dirty = false;
		let flushTimer: number | null = null;

		const syncActive = () => {
			if (!pane) return;
			const v = pane.value();
			if (v !== panes[active].body) {
				panes[active].body = v;
				dirty = true;
			}
		};
		const writeBack = async () => {
			dirty = false;
			const file = this.app.vault.getAbstractFileByPath(ctx.sourcePath);
			if (!(file instanceof TFile)) return;
			const info = ctx.getSectionInfo(el);
			if (!info) return;
			await this.app.vault.process(file, (data) => {
				const lines = data.split("\n");
				const open = lines[info.lineStart];
				const close = lines[info.lineEnd];
				if (open == null || close == null) return data;
				if (open.replace(/`/g, "").trim() !== "tabs" || !close.trim().startsWith("```")) return data;
				const inner = serializeTabs(panes).split("\n");
				lines.splice(info.lineStart, info.lineEnd - info.lineStart + 1, open, ...inner, close);
				return lines.join("\n");
			});
		};
		const flush = () => {
			syncActive();
			if (dirty) void writeBack();
		};
		const scheduleFlush = (ms: number) => {
			if (flushTimer != null) window.clearTimeout(flushTimer);
			flushTimer = window.setTimeout(() => {
				// never yank the editor out from under a focused pane, the
				// write re-renders this block; wait for the next blur instead
				if (pane?.hasFocus()) return;
				flush();
			}, ms);
		};
		child.register(() => {
			if (flushTimer != null) window.clearTimeout(flushTimer);
			flush();
			pane?.destroy();
			pane = null;
		});

		const root = el.createDiv({ cls: "ped-tabs" });
		root.addEventListener("mousedown", (e) => e.stopPropagation());
		const strip = root.createDiv({ cls: "ped-tabstrip" });
		const body = root.createDiv({ cls: "ped-tabbody" });

		const mountPane = () => {
			pane?.destroy();
			body.empty();
			const paneEl = body.createDiv({ cls: "ped-tabpane" });
			pane = createPaneEditor(this.app, paneEl, {
				value: panes[active].body,
				sourcePath: ctx.sourcePath,
				onChange: () => {
					dirty = true;
					if (!pane?.hasFocus()) scheduleFlush(600); // toolbar edits after blur still land
				},
				onBlur: () => scheduleFlush(300),
				onEscape: () => flush(),
			});
			if (!pane) {
				// internals moved: mark broken and rebuild this block the old way
				this.paneEditorsOk = false;
				el.empty();
				this.renderTabsBasic(source, el, ctx);
			}
		};

		const renameTab = (btn: HTMLElement, i: number) => {
			const input = createEl("input", { cls: "ped-tab-rename", attr: { type: "text" } });
			input.value = panes[i].title;
			btn.replaceWith(input);
			input.focus();
			input.select();
			let done = false;
			const commit = (save: boolean) => {
				if (done) return;
				done = true;
				if (save) {
					const v = input.value.trim() || `Tab ${i + 1}`;
					if (panes[i].title !== v) {
						panes[i].title = v;
						dirty = true;
					}
				}
				flush();
				draw();
			};
			input.addEventListener("blur", () => commit(true));
			input.addEventListener("keydown", (e) => {
				if (e.key === "Enter") {
					e.preventDefault();
					commit(true);
				} else if (e.key === "Escape") {
					commit(false);
				}
			});
		};

		const draw = () => {
			active = Math.max(0, Math.min(active, panes.length - 1));
			this.tabActive.set(key, active);
			strip.empty();
			panes.forEach((p, i) => {
				const btn = strip.createEl("button", {
					cls: "ped-tab" + (i === active ? " is-active" : ""),
					text: p.title || `Tab ${i + 1}`,
				});
				btn.onclick = () => {
					if (i === active) return;
					syncActive();
					active = i;
					this.tabActive.set(key, active);
					if (dirty) void writeBack();
					draw();
					mountPane();
				};
				btn.ondblclick = () => renameTab(btn, i);
				btn.oncontextmenu = (e) => {
					e.preventDefault();
					const m = new Menu();
					m.addItem((it) => it.setTitle("Rename tab").setIcon("pencil").onClick(() => renameTab(btn, i)));
					if (panes.length > 1)
						m.addItem((it) =>
							it.setTitle("Delete tab").setIcon("trash-2").onClick(() => {
								panes.splice(i, 1);
								if (active >= i) active = Math.max(0, active - 1);
								this.tabActive.set(key, active);
								dirty = true;
								flush();
								draw();
								mountPane();
							})
						);
					m.showAtMouseEvent(e);
				};
			});
			const add = strip.createEl("button", { cls: "ped-tab-add", text: "+", attr: { "aria-label": "Add tab" } });
			add.onclick = () => {
				syncActive();
				panes.push({ title: `Tab ${panes.length + 1}`, body: "" });
				active = panes.length - 1;
				this.tabActive.set(key, active);
				dirty = true;
				void writeBack();
				draw();
				mountPane();
				pane?.focus();
			};
		};

		draw();
		mountPane();
	}

	/** The plain-textarea tabs (pre-embedded-editor), kept as the fallback. */
	private renderTabsBasic(source: string, el: HTMLElement, ctx: MarkdownPostProcessorContext) {
		const panes = parseTabs(source);
		if (!panes.length) panes.push({ title: "Tab 1", body: "" });
		const child = new MarkdownRenderChild(el);
		ctx.addChild(child);
		const key = `${ctx.sourcePath}:${ctx.getSectionInfo(el)?.lineStart ?? -1}`;
		let active = Math.min(this.tabActive.get(key) ?? 0, panes.length - 1);

		// Write the panes back into the block's source lines. Safe: only rewrites
		// when the fenced boundaries getSectionInfo reports really are a tabs block.
		const writeBack = async () => {
			const file = this.app.vault.getAbstractFileByPath(ctx.sourcePath);
			if (!(file instanceof TFile)) return;
			const info = ctx.getSectionInfo(el);
			if (!info) return;
			await this.app.vault.process(file, (data) => {
				const lines = data.split("\n");
				const open = lines[info.lineStart];
				const close = lines[info.lineEnd];
				if (open == null || close == null) return data;
				if (open.replace(/`/g, "").trim() !== "tabs" || !close.trim().startsWith("```")) return data;
				const inner = serializeTabs(panes).split("\n");
				lines.splice(info.lineStart, info.lineEnd - info.lineStart + 1, open, ...inner, close);
				return lines.join("\n");
			});
		};

		const root = el.createDiv({ cls: "ped-tabs" });
		// keep clicks inside the widget from moving the editor caret / revealing source
		root.addEventListener("mousedown", (e) => e.stopPropagation());
		const strip = root.createDiv({ cls: "ped-tabstrip" });
		const body = root.createDiv({ cls: "ped-tabbody" });

		const renderView = (pane: HTMLElement, i: number) => {
			pane.empty();
			const p = panes[i];
			if (p.body.trim()) void MarkdownRenderer.render(this.app, p.body, pane, ctx.sourcePath, child);
			else pane.createSpan({ cls: "ped-tab-empty", text: "Empty tab (click to add content)" });
			pane.onclick = (e) => {
				if ((e.target as HTMLElement).closest("a, input, button, .task-list-item-checkbox")) return;
				editView(pane, i);
			};
		};

		const editView = (pane: HTMLElement, i: number) => {
			pane.empty();
			pane.onclick = null;
			const ta = pane.createEl("textarea", { cls: "ped-tab-edit" });
			ta.value = panes[i].body;
			const grow = () => {
				ta.style.removeProperty("height");
				ta.style.height = ta.scrollHeight + 2 + "px";
			};
			grow();
			ta.addEventListener("input", grow);
			ta.addEventListener("keydown", (e) => {
				if (e.key === "Escape") {
					ta.blur();
					return;
				}
				const at = ta.selectionStart;
				if (at !== ta.selectionEnd) return; // only act on a plain caret
				if (e.key === "Enter" && !e.shiftKey) {
					const lineStart = ta.value.lastIndexOf("\n", at - 1) + 1;
					const cont = continueList(ta.value.slice(lineStart, at));
					if (cont) {
						e.preventDefault();
						if ("insert" in cont) ta.setRangeText(cont.insert, at, at, "end");
						else ta.setRangeText(cont.clear, lineStart, at, "end");
						grow();
					}
				} else if (e.key === "Tab") {
					e.preventDefault();
					ta.setRangeText("\t", at, at, "end");
					grow();
				}
			});
			ta.addEventListener("blur", () => {
				const changed = panes[i].body !== ta.value.trim();
				panes[i].body = ta.value;
				renderView(pane, i);
				if (changed) void writeBack();
			});
			window.setTimeout(() => ta.focus(), 0);
		};

		const renameTab = (btn: HTMLElement, i: number) => {
			const input = createEl("input", { cls: "ped-tab-rename", attr: { type: "text" } });
			input.value = panes[i].title;
			btn.replaceWith(input);
			input.focus();
			input.select();
			let done = false;
			const commit = (save: boolean) => {
				if (done) return;
				done = true;
				if (save) {
					const v = input.value.trim() || `Tab ${i + 1}`;
					const changed = panes[i].title !== v;
					panes[i].title = v;
					if (changed) void writeBack();
				}
				draw();
			};
			input.addEventListener("blur", () => commit(true));
			input.addEventListener("keydown", (e) => {
				if (e.key === "Enter") {
					e.preventDefault();
					commit(true);
				} else if (e.key === "Escape") {
					commit(false);
				}
			});
		};

		const draw = () => {
			active = Math.max(0, Math.min(active, panes.length - 1));
			this.tabActive.set(key, active);
			strip.empty();
			body.empty();
			panes.forEach((p, i) => {
				const btn = strip.createEl("button", {
					cls: "ped-tab" + (i === active ? " is-active" : ""),
					text: p.title || `Tab ${i + 1}`,
				});
				btn.onclick = () => {
					active = i;
					draw();
				};
				btn.ondblclick = () => renameTab(btn, i);
				btn.oncontextmenu = (e) => {
					e.preventDefault();
					const m = new Menu();
					m.addItem((it) => it.setTitle("Rename tab").setIcon("pencil").onClick(() => renameTab(btn, i)));
					if (panes.length > 1)
						m.addItem((it) =>
							it.setTitle("Delete tab").setIcon("trash-2").onClick(() => {
								panes.splice(i, 1);
								if (active >= i) active = Math.max(0, active - 1);
								void writeBack();
								draw();
							})
						);
					m.showAtMouseEvent(e);
				};
			});
			const add = strip.createEl("button", { cls: "ped-tab-add", text: "+", attr: { "aria-label": "Add tab" } });
			add.onclick = () => {
				panes.push({ title: `Tab ${panes.length + 1}`, body: "" });
				active = panes.length - 1;
				void writeBack();
				draw();
			};
			const pane = body.createDiv({ cls: "ped-tabpane" });
			renderView(pane, active);
		};

		draw();
	}

	/** Live, editable columns: every column hosts a real embedded editor so you
	 *  type straight into it in Live Preview, with a divider to drag-resize and
	 *  controls to add or remove a column. Writes back only while nothing in the
	 *  block is focused, so a re-render never yanks the editor mid-type. Falls
	 *  back to a read-only render if the internal editor can't be resolved. */
	private renderColumns(source: string, el: HTMLElement, ctx: MarkdownPostProcessorContext) {
		if (!this.paneEditorsOk) {
			this.renderColumnsBasic(source, el, ctx);
			return;
		}
		const panes = parseColumns(source);
		if (!panes.length) panes.push({ ratio: 1, body: "" });
		const child = new MarkdownRenderChild(el);
		ctx.addChild(child);
		const editors: (PaneEditor | null)[] = [];
		let dirty = false;
		let flushTimer: number | null = null;

		const anyFocused = () => editors.some((pe) => pe?.hasFocus());
		const syncAll = () => {
			editors.forEach((pe, i) => {
				if (!pe || !panes[i]) return;
				const v = pe.value();
				if (v !== panes[i].body) {
					panes[i].body = v;
					dirty = true;
				}
			});
		};
		const writeBack = async () => {
			dirty = false;
			const file = this.app.vault.getAbstractFileByPath(ctx.sourcePath);
			if (!(file instanceof TFile)) return;
			const info = ctx.getSectionInfo(el);
			if (!info) return;
			await this.app.vault.process(file, (data) => {
				const lines = data.split("\n");
				const open = lines[info.lineStart];
				const close = lines[info.lineEnd];
				if (open == null || close == null) return data;
				if (open.replace(/`/g, "").trim() !== "columns" || !close.trim().startsWith("```")) return data;
				const inner = serializeColumns(panes).split("\n");
				lines.splice(info.lineStart, info.lineEnd - info.lineStart + 1, open, ...inner, close);
				return lines.join("\n");
			});
		};
		const flush = () => {
			syncAll();
			if (dirty) void writeBack();
		};
		const scheduleFlush = (ms: number) => {
			if (flushTimer != null) window.clearTimeout(flushTimer);
			flushTimer = window.setTimeout(() => {
				if (anyFocused()) return; // still editing a column; wait for the block to blur
				flush();
			}, ms);
		};
		child.register(() => {
			if (flushTimer != null) window.clearTimeout(flushTimer);
			flush();
			editors.forEach((pe) => pe?.destroy());
			editors.length = 0;
		});

		const root = el.createDiv({ cls: "ped-columns ped-columns-live" });
		root.addEventListener("mousedown", (e) => e.stopPropagation());

		const draw = () => {
			editors.forEach((pe) => pe?.destroy());
			editors.length = 0;
			root.empty();
			const cols: HTMLElement[] = [];
			let broke = false;
			for (let i = 0; i < panes.length; i++) {
				if (i > 0) {
					const divider = root.createDiv({ cls: "ped-col-divider", attr: { "aria-label": "Drag to resize" } });
					this.armColumnResize(divider, () => cols, panes, i, () => {
						dirty = true;
						void writeBack();
					});
				}
				const col = root.createDiv({ cls: "ped-column" });
				col.style.flexGrow = String(panes[i].ratio);
				cols.push(col);
				if (panes.length > 1) {
					const rm = col.createEl("button", { cls: "ped-col-remove", attr: { "aria-label": "Remove column" } });
					setIcon(rm, "x");
					const idx = i;
					rm.onclick = () => {
						syncAll();
						panes.splice(idx, 1);
						dirty = true;
						void writeBack();
						draw();
					};
				}
				const paneEl = col.createDiv({ cls: "ped-col-pane" });
				const pe = createPaneEditor(this.app, paneEl, {
					value: panes[i].body,
					sourcePath: ctx.sourcePath,
					onChange: () => {
						dirty = true;
						if (!anyFocused()) scheduleFlush(600);
					},
					onBlur: () => scheduleFlush(300),
					onEscape: () => flush(),
				});
				editors.push(pe);
				if (!pe) {
					broke = true;
					break;
				}
			}
			if (broke) {
				this.paneEditorsOk = false;
				editors.forEach((pe) => pe?.destroy());
				el.empty();
				this.renderColumnsBasic(source, el, ctx);
				return;
			}
			const add = root.createDiv({ cls: "ped-col-add", attr: { "aria-label": "Add column" } });
			setIcon(add, "plus");
			add.onclick = () => {
				syncAll();
				panes.push({ ratio: 1, body: "" });
				dirty = true;
				void writeBack();
				draw();
				editors[editors.length - 1]?.focus();
			};
		};
		draw();
	}

	/** Drag a divider to resize the two columns it sits between; the pixel widths
	 *  become the new flex ratios, saved on release. */
	private armColumnResize(divider: HTMLElement, getCols: () => HTMLElement[], panes: { ratio: number }[], right: number, onDone: () => void) {
		divider.addEventListener("pointerdown", (e: PointerEvent) => {
			e.preventDefault();
			const cols = getCols();
			const left = right - 1;
			const lEl = cols[left];
			const rEl = cols[right];
			if (!lEl || !rEl) return;
			const startX = e.clientX;
			const wL = lEl.offsetWidth;
			const wR = rEl.offsetWidth;
			divider.setPointerCapture(e.pointerId);
			divider.addClass("is-dragging");
			const onMove = (me: PointerEvent) => {
				const dx = Math.max(-(wL - 60), Math.min(wR - 60, me.clientX - startX));
				panes[left].ratio = wL + dx;
				panes[right].ratio = wR - dx;
				lEl.style.flexGrow = String(wL + dx);
				rEl.style.flexGrow = String(wR - dx);
			};
			const onUp = () => {
				divider.removeEventListener("pointermove", onMove);
				divider.removeEventListener("pointerup", onUp);
				divider.removeClass("is-dragging");
				onDone();
			};
			divider.addEventListener("pointermove", onMove);
			divider.addEventListener("pointerup", onUp);
		});
	}

	/** The read-only columns render, kept as the fallback when embedded editors
	 *  can't be created (and used by Reading view). */
	private renderColumnsBasic(source: string, el: HTMLElement, ctx: MarkdownPostProcessorContext) {
		const panes = parseColumns(source);
		if (!panes.length) {
			el.createEl("em", { text: "Empty columns block (separate columns with '---' lines." });
			return;
		}
		const child = new MarkdownRenderChild(el);
		ctx.addChild(child);
		const root = el.createDiv({ cls: "ped-columns" });
		for (const p of panes) {
			const col = root.createDiv({ cls: "ped-column" });
			col.style.flexGrow = String(p.ratio);
			void MarkdownRenderer.render(this.app, p.body, col, ctx.sourcePath, child);
		}
	}

	/** ⏰ HH:MM tasks fire a notice the minute they come due (app open). */
	private async todoReminderTick() {
		if (!this.settings.todoReminders) return;
		const d = new Date();
		const hhmm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
		const today = todayStr();
		const hits = (await this.collectTodos()).filter((t) => !t.checked && t.due === today && t.time === hhmm);
		for (const t of hits) {
			const key = `${t.path}:${t.line}:${today} ${hhmm}`;
			if (this.notified.has(key)) continue;
			this.notified.add(key);
			new Notice("⏰ " + t.body, 10000);
		}
	}

	/* ---------------- Notion page chrome: covers, comments, verification ---------------- */

	/** Re-sync every markdown view's cover, page icon, verify badge, and the
	 *  per-note page layout (width, font, cover overlay). */
	updatePageChrome() {
		for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
			const view = leaf.view as MarkdownView;
			this.applyCover(view);
			this.applyPageIcon(view);
			this.applyVerifyBadge(view);
			this.applyPageLayout(view);
			this.applyEditedStamp(view);
		}
	}

	/** Toggle the per-note width, font, and cover-overlay classes on the view. */
	private applyPageLayout(view: MarkdownView) {
		const layout = parsePageLayout(view.file ? this.app.metadataCache.getFileCache(view.file)?.frontmatter : undefined);
		const host = view.containerEl;
		host.toggleClass("ped-full-width", layout.fullWidth);
		host.toggleClass("ped-font-serif", layout.font === "serif");
		host.toggleClass("ped-font-mono", layout.font === "mono");
		host.toggleClass("ped-cover-overlay", layout.overlayTitle);
	}

	async writePageProp(file: TFile, key: string, value: unknown) {
		await this.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
			if (value == null) delete fm[key];
			else fm[key] = value;
		});
	}

	/** A small menu for the per-note page options: full width, body font, and
	 *  (when a cover is set) whether the title floats over it. */
	openPageOptions() {
		const file = this.app.workspace.getActiveViewOfType(MarkdownView)?.file;
		if (!file) return;
		const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
		const layout = parsePageLayout(fm);
		const menu = new Menu();
		menu.addItem((i) =>
			i
				.setTitle("Full width")
				.setIcon("move-horizontal")
				.setChecked(layout.fullWidth)
				.onClick(() => void this.writePageProp(file, "full-width", layout.fullWidth ? null : true))
		);
		menu.addSeparator();
		const font = (label: string, val: "default" | "serif" | "mono", icon: string) =>
			menu.addItem((i) =>
				i
					.setTitle(label)
					.setIcon(icon)
					.setChecked((layout.font ?? "default") === val)
					.onClick(() => void this.writePageProp(file, "font", val === "default" ? null : val))
			);
		font("Default font", "default", "type");
		font("Serif", "serif", "type");
		font("Monospace", "mono", "code");
		if (parseCover(fm)) {
			menu.addSeparator();
			menu.addItem((i) =>
				i
					.setTitle("Title over cover")
					.setIcon("image")
					.setChecked(layout.overlayTitle)
					.onClick(() => void this.writePageProp(file, "cover-overlay", layout.overlayTitle ? null : true))
			);
		}
		menu.showAtPosition({ x: window.innerWidth / 2 - 110, y: 150 });
	}

	/** Notion's page icon: an `icon` frontmatter emoji rendered above the
	 *  inline title. Click to change or remove. */
	private applyPageIcon(view: MarkdownView) {
		const file = view.file;
		const icon = file ? parseIcon(this.app.metadataCache.getFileCache(file)?.frontmatter) : null;
		for (const titleEl of Array.from(view.containerEl.querySelectorAll(".inline-title"))) {
			const parent = titleEl.parentElement;
			if (!parent) continue;
			let el = parent.querySelector(":scope > .ped-page-icon") as HTMLElement | null;
			if (!icon || !file) {
				el?.remove();
				continue;
			}
			if (!el) {
				el = createDiv({ cls: "ped-page-icon" });
				parent.insertBefore(el, titleEl);
			}
			el.setText(icon);
			el.onclick = (e) => this.openIconMenu(e, file);
		}
	}

	/** The stamp's text for the chosen format. Clicking it adds the exact date
	 *  to whatever the setting says, so a glanceable "3 minutes ago" can be
	 *  pinned down without changing the setting. */
	private editedText(when: number, expanded: boolean): string {
		const label = this.settings.showEdited === "bare" ? "" : "Edited ";
		const mode = expanded ? "both" : this.settings.editedFormat;
		const rel = relativeEdited(when, Date.now());
		const abs = absoluteEdited(when);
		if (mode === "exact") return label + abs;
		if (mode === "both") return `${label}${rel} · ${abs}`;
		return label + rel;
	}

	/** 1Password-style "Edited 3 minutes ago": under the note's title, under it
	 *  with a rule closing the pair off, at the end of the note, or both. The
	 *  title copy sits next to .inline-title so a cover moves it too, and the
	 *  bottom copy goes in .cm-sizer, the same place Obsidian puts in-document
	 *  backlinks, so it scrolls with the note and CodeMirror keeps ownership of
	 *  the content itself. */
	private applyEditedStamp(view: MarkdownView) {
		const file = view.file;
		const when = file ? editedAt(this.app.metadataCache.getFileCache(file)?.frontmatter, file.stat?.mtime ?? 0) : 0;
		const on = this.settings.showEdited !== "off" && !!file && !!when;
		const pos = this.settings.editedPosition;
		const wantTitle = on && (pos === "title" || pos === "rule" || pos === "both");
		const wantBottom = on && (pos === "bottom" || pos === "both");
		const expanded = !!file && this.editedExpanded.has(file.path);
		const text = on ? this.editedText(when, expanded) : "";
		const exact = on ? absoluteEdited(when) : "";
		// Whatever the note opens with brings its own top spacing, and a heading
		// brings a great deal of it while a paragraph brings none. One gap under
		// the stamp therefore cannot serve both: it reads as adrift over a
		// heading and as cramped over prose. The section list says which it is
		// (frontmatter is a section too, so it is skipped).
		const opensOnHeading =
			(file ? this.app.metadataCache.getFileCache(file)?.sections : undefined)?.find((s) => s.type !== "yaml")?.type === "heading";

		const place = (host: HTMLElement, where: "title" | "bottom", anchor: Element | null, wanted: boolean) => {
			let el = host.querySelector(`:scope > .ped-edited.is-${where}`) as HTMLElement | null;
			if (!wanted) {
				el?.remove();
				return;
			}
			if (!el) {
				el = createDiv({ cls: `ped-edited is-${where}` });
				if (anchor) anchor.insertAdjacentElement("afterend", el);
				else host.appendChild(el);
				el.onclick = () => {
					if (!file) return;
					if (this.editedExpanded.has(file.path)) this.editedExpanded.delete(file.path);
					else this.editedExpanded.add(file.path);
					this.refreshEditedStamps();
				};
			} else if (!anchor && el !== host.lastElementChild) {
				host.appendChild(el); // stay last as the note grows
			}
			// set every pass, not just on create: the stamp outlives a change
			// of this setting, so the old look has to come back off it
			el.toggleClass("is-rule", where === "title" && pos === "rule");
			el.toggleClass("is-tight", where === "title" && opensOnHeading);
			el.setText(text);
			el.setAttribute("aria-label", exact);
			el.setAttribute("title", exact);
		};

		for (const titleEl of Array.from(view.containerEl.querySelectorAll(".inline-title"))) {
			if (titleEl.parentElement) place(titleEl.parentElement, "title", titleEl, wantTitle);
		}
		// .cm-sizer is editing view; .markdown-preview-sizer is reading view
		for (const sizer of Array.from(view.containerEl.querySelectorAll(".cm-sizer, .markdown-preview-sizer"))) {
			place(sizer as HTMLElement, "bottom", null, wantBottom);
		}
	}

	/** Notes whose stamp the reader clicked to expand, by path. Session-only:
	 *  a preference for one glance, not something worth writing to disk. */
	private editedExpanded = new Set<string>();

	/** Re-time the stamps without touching covers, icons, or layout, the
	 *  minute tick should not churn the rest of the page chrome. */
	private refreshEditedStamps() {
		if (this.settings.showEdited === "off") return;
		for (const leaf of this.app.workspace.getLeavesOfType("markdown")) this.applyEditedStamp(leaf.view as MarkdownView);
	}

	openIconMenu(evt: MouseEvent | undefined, file: TFile) {
		const menu = new Menu();
		menu.addItem((i) =>
			i.setTitle("Change icon…").setIcon("smile").onClick(() => {
				const anchor =
					(evt?.target instanceof HTMLElement ? evt.target : null) ??
					(this.app.workspace.getActiveViewOfType(MarkdownView)?.containerEl.querySelector(".view-header-title-container") as HTMLElement | null) ??
					document.body;
				this.pickEmoji(anchor, (ch) => {
					void this.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
						fm["icon"] = ch;
					});
				});
			})
		);
		if (parseIcon(this.app.metadataCache.getFileCache(file)?.frontmatter))
			menu.addItem((i) =>
				i.setTitle("Remove icon").setIcon("x").onClick(
					() =>
						void this.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
							delete fm["icon"];
						})
				)
			);
		if (evt) menu.showAtMouseEvent(evt);
		else menu.showAtPosition({ x: window.innerWidth / 2 - 100, y: 140 });
	}

	private applyCover(view: MarkdownView) {
		const file = view.file;
		const spec = file ? parseCover(this.app.metadataCache.getFileCache(file)?.frontmatter) : null;
		const hosts = [
			view.containerEl.querySelector(".markdown-source-view .cm-sizer"),
			view.containerEl.querySelector(".markdown-preview-view .markdown-preview-sizer"),
		];
		for (const h of hosts) {
			if (!(h instanceof HTMLElement)) continue;
			let el = h.querySelector(":scope > .ped-cover") as HTMLElement | null;
			if (!spec || !file) {
				el?.remove();
				h.removeClass("ped-has-cover");
				continue;
			}
			h.addClass("ped-has-cover");
			h.removeClass("ped-h-short", "ped-h-tall");
			if (spec.height === "short") h.addClass("ped-h-short");
			else if (spec.height === "tall") h.addClass("ped-h-tall");
			if (!el) {
				el = createDiv({ cls: "ped-cover" });
				h.insertBefore(el, h.firstChild);
			}
			el.empty();
			el.style.removeProperty("background-image");
			el.style.removeProperty("background-color");
			if (spec.kind === "gradient") {
				el.style.backgroundImage = gradientCss(spec.value) ?? "";
			} else if (spec.kind === "solid") {
				el.style.backgroundColor = spec.value;
			} else {
				const src = spec.kind === "url" ? spec.value : this.resolveCoverSrc(spec.value, file);
				if (src) {
					const img = el.createEl("img", { cls: "ped-cover-img", attr: { src, draggable: "false" } });
					img.style.objectPosition = `50% ${spec.y}%`;
				}
			}
			const bar = el.createDiv({ cls: "ped-cover-bar" });
			const btn = (label: string, fn: (e: MouseEvent) => void) => {
				const b = bar.createEl("button", { cls: "ped-cover-btn", text: label });
				b.addEventListener("click", (e) => {
					e.preventDefault();
					fn(e);
				});
			};
			btn("Change cover", (e) => this.openCoverMenu(e));
			if (spec.kind !== "gradient") btn("Reposition", () => this.armCoverReposition(el as HTMLElement, file, spec.value));
			btn("Remove", () => void this.writeCover(file, null));
		}
	}

	private resolveCoverSrc(path: string, from: TFile): string {
		const f = this.app.metadataCache.getFirstLinkpathDest(path, from.path);
		return f ? this.app.vault.getResourcePath(f) : "";
	}

	async writeCover(file: TFile, value: string | null, y?: number) {
		await this.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
			if (value == null) {
				delete fm["cover"];
				delete fm["cover-y"];
				delete fm["cover-h"];
			} else {
				fm["cover"] = value;
				if (y != null) fm["cover-y"] = y;
			}
		});
	}

	async writeCoverHeight(file: TFile, height: CoverHeight) {
		await this.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
			if (height === "standard") delete fm["cover-h"];
			else fm["cover-h"] = height;
		});
	}

	/** Upload an image from the computer and make it the cover. */
	uploadCover(file: TFile) {
		const input = document.createElement("input");
		input.type = "file";
		input.accept = "image/*";
		input.addEventListener("change", () => {
			const f = input.files?.[0];
			if (!f) return;
			void (async () => {
				const dest = await this.app.fileManager.getAvailablePathForAttachment(f.name || `Cover ${Date.now()}.jpg`, file.path);
				const img = await this.app.vault.createBinary(dest, await f.arrayBuffer());
				await this.writeCover(file, `[[${img.path}]]`);
			})();
		});
		input.click();
	}

	/** The visual cover picker: gradient and solid swatches, your own images,
	 *  and a height control, all applied live behind the modal. */
	openCoverMenu(_evt?: MouseEvent) {
		const file = this.app.workspace.getActiveViewOfType(MarkdownView)?.file;
		if (!file) return;
		new CoverModal(this, file).open();
	}

	/** One drag session: vertical drag slides the image, release saves. */
	private armCoverReposition(el: HTMLElement, file: TFile, coverValue: string) {
		const img = el.querySelector(".ped-cover-img") as HTMLImageElement | null;
		if (!img) return;
		new Notice("Drag the cover up or down; release to save.");
		el.addClass("is-repositioning");
		const startPct = Number((img.style.objectPosition.match(/(\d+(?:\.\d+)?)%$/) ?? [])[1] ?? 50);
		let pct = startPct;
		const onDown = (de: PointerEvent) => {
			de.preventDefault();
			const y0 = de.clientY;
			const onMove = (me: PointerEvent) => {
				pct = Math.max(0, Math.min(100, startPct - ((me.clientY - y0) / Math.max(1, el.clientHeight)) * 100));
				img.style.objectPosition = `50% ${pct}%`;
			};
			const onUp = () => {
				document.removeEventListener("pointermove", onMove);
				document.removeEventListener("pointerup", onUp);
				el.removeClass("is-repositioning");
				el.removeEventListener("pointerdown", onDown);
				void this.writeCover(file, coverValue, Math.round(pct));
			};
			document.addEventListener("pointermove", onMove);
			document.addEventListener("pointerup", onUp);
		};
		el.addEventListener("pointerdown", onDown);
	}

	/** Insert a %%💬 …%% marker right after the selection (or cursor). */
	addComment(ed: Editor) {
		const to = ed.getCursor("to");
		new TextPromptModal(this.app, "Comment", "", (raw) => {
			const text = raw.trim();
			if (!text) return;
			const before = to.ch > 0 ? ed.getRange({ line: to.line, ch: to.ch - 1 }, to) : "";
			const sep = before && !/\s/.test(before) ? " " : "";
			ed.replaceRange(sep + makeComment(text, todayStr()), to, to);
		}).open();
	}

	/** The chip popover: read, edit, or resolve. The marker is re-located at
	 *  action time, so edits elsewhere in the doc can't misfire it. */
	openCommentPopover(cm: EditorView, anchor: HTMLElement) {
		document.body.querySelector(".ped-comment-pop")?.remove();
		let pos: number;
		try {
			pos = cm.posAtDOM(anchor);
		} catch {
			return;
		}
		const locate = () => {
			const line = cm.state.doc.lineAt(Math.min(pos, cm.state.doc.length));
			const re = /%%💬\s*(.*?)%%/g;
			let m: RegExpExecArray | null;
			while ((m = re.exec(line.text))) {
				const from = line.from + m.index;
				const to = from + m[0].length;
				if (pos >= from && pos <= to) return { from, to, raw: m[0], inner: m[1] };
			}
			return null;
		};
		const hit = locate();
		if (!hit) return;
		const { text, stamp } = commentParts(hit.inner);
		const pop = document.body.createDiv({ cls: "ped-comment-pop" });
		const rect = anchor.getBoundingClientRect();
		pop.style.left = Math.max(8, Math.min(rect.left, window.innerWidth - 300)) + "px";
		pop.style.top = rect.bottom + 6 + "px";
		pop.createDiv({ cls: "ped-comment-text", text });
		if (stamp) pop.createDiv({ cls: "ped-comment-stamp", text: stamp });
		const btns = pop.createDiv({ cls: "ped-comment-btns" });
		const onDoc = (e: MouseEvent) => {
			if (!(e.target instanceof Node) || !pop.contains(e.target)) close();
		};
		const close = () => {
			pop.remove();
			document.removeEventListener("mousedown", onDoc, true);
		};
		document.addEventListener("mousedown", onDoc, true);
		btns.createEl("button", { text: "Edit" }).addEventListener("click", () => {
			close();
			new TextPromptModal(this.app, "Edit comment", text, (raw) => {
				const v = raw.trim();
				const cur = locate();
				if (!cur) return;
				cm.dispatch({
					changes: { from: cur.from, to: cur.to, insert: v ? replaceCommentText(cur.raw, v, todayStr()) : "" },
				});
			}).open();
		});
		btns.createEl("button", { text: "Resolve", cls: "mod-cta" }).addEventListener("click", () => {
			const cur = locate();
			close();
			if (!cur) return;
			const from = cur.from > 0 && cm.state.doc.sliceString(cur.from - 1, cur.from) === " " ? cur.from - 1 : cur.from;
			cm.dispatch({ changes: { from, to: cur.to, insert: "" } });
		});
		if (this.aiKey()) {
			btns.createEl("button", { text: "Resolve with AI" }).addEventListener("click", () => {
				const cur = locate();
				close();
				if (cur) void this.aiResolveComment(cm, cur, text);
			});
		}
	}

	/** The comment is the instruction: send the surrounding block plus the
	 *  comment to Claude, replace the block with the revision (marker gone).
	 *  A native editor edit, so Ctrl+Z reverses it. */
	private async aiResolveComment(cm: EditorView, cur: { from: number; to: number; raw: string }, instruction: string) {
		const key = this.aiKey();
		if (!key) return;
		const doc = cm.state.doc;
		const lineNo = doc.lineAt(cur.from).number - 1;
		const lines = doc.toString().split("\n");
		const range = blockRangeAt(lines, lineNo) ?? { from: lineNo, to: lineNo };
		const blockFrom = doc.line(range.from + 1).from;
		const blockTo = doc.line(range.to + 1).to;
		const passage = doc
			.sliceString(blockFrom, blockTo)
			.replace(cur.raw, "")
			.replace(/[ \t]+$/gm, "");
		new Notice("Power Editor: applying the comment…");
		try {
			const anthropic = new Anthropic({ apiKey: key, dangerouslyAllowBrowser: true });
			const msg = await anthropic.messages.create({
				model: this.settings.aiModel,
				max_tokens: 4096,
				system:
					"You revise Markdown passages according to a reviewer comment. Reply with ONLY the revised passage: no preamble, no quotes, no code fences. Preserve Markdown structure (links, emphasis, lists) unless the comment says otherwise.",
				messages: [{ role: "user", content: `Reviewer comment: "${instruction}"\n\nPassage:\n"""\n${passage}\n"""` }],
			});
			const out = msg.content
				.filter((b): b is Anthropic.TextBlock => b.type === "text")
				.map((b) => b.text)
				.join("\n")
				.trim();
			if (out) cm.dispatch({ changes: { from: blockFrom, to: blockTo, insert: out } });
		} catch (e) {
			new Notice("Power Editor AI failed: " + (e instanceof Error ? e.message : String(e)), 6000);
		}
	}

	private applyVerifyBadge(view: MarkdownView) {
		const header = view.containerEl.querySelector(".view-header-title-container");
		if (!(header instanceof HTMLElement)) return;
		let badge = header.querySelector(":scope > .ped-verify") as HTMLElement | null;
		const file = view.file;
		const st = file
			? verificationState(this.app.metadataCache.getFileCache(file)?.frontmatter, todayStr())
			: ({ state: "none" } as const);
		if (!file || st.state === "none") {
			badge?.remove();
			return;
		}
		if (!badge) badge = header.createSpan({ cls: "ped-verify" });
		badge.className = "ped-verify " + (st.state === "verified" ? "is-verified" : "is-expired");
		badge.setText(st.state === "verified" ? "✓ Verified" : "✓ Expired");
		badge.setAttr(
			"aria-label",
			st.state === "verified" ? `Verified ${st.since}` + (st.until ? `, until ${st.until}` : "") : `Verification expired ${st.until}`
		);
		badge.onclick = (e) => this.openVerifyMenu(e, file);
	}

	/** Notion's page verification: verify now, verify with expiry, remove. */
	openVerifyMenu(evt: MouseEvent | undefined, file: TFile) {
		const st = verificationState(this.app.metadataCache.getFileCache(file)?.frontmatter, todayStr());
		const menu = new Menu();
		const write = (until: string | null) =>
			void this.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
				fm["verified"] = todayStr();
				if (until == null) delete fm["verified-until"];
				else fm["verified-until"] = until;
			});
		menu.addItem((i) => i.setTitle("Verify (no expiry)").setIcon("badge-check").onClick(() => write(null)));
		menu.addItem((i) =>
			i.setTitle("Verify with expiry…").setIcon("calendar-clock").onClick(() =>
				new TextPromptModal(this.app, "Verified until, a date or phrase like 'in 6 months'", "in 6 months", (raw) => {
					const d = parseDatePhrase(raw, todayStr());
					if (d) write(d);
					else new Notice("Power Editor: couldn't read that as a date.");
				}).open()
			)
		);
		if (st.state !== "none")
			menu.addItem((i) =>
				i.setTitle("Remove verification").setIcon("badge-x").onClick(
					() =>
						void this.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
							delete fm["verified"];
							delete fm["verified-until"];
						})
				)
			);
		if (evt) menu.showAtMouseEvent(evt);
		else menu.showAtPosition({ x: window.innerWidth / 2 - 100, y: 140 });
	}

	/** Tear down and re-create every toolbar (settings changes). */
	rebuildToolbars() {
		for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
			(leaf.view as MarkdownView).containerEl.querySelector(":scope > .ped-toolbar")?.remove();
		}
		this.ensureToolbars();
	}

	/** Notion-style toggle: fold the block under the cursor behind its
	 *  first line (a collapsed [!toggle] callout, plain markdown, folds
	 *  natively everywhere). On a block that is already a folded callout the
	 *  same button unwraps it back to plain text, title first. */
	toggleBlock(ed: Editor) {
		const lines = ed.getValue().split("\n");
		const from = ed.getCursor("from");
		const to = ed.getCursor("to");
		const hasSelection = from.line !== to.line || from.ch !== to.ch;
		const picked =
			(hasSelection ? unionBlockRange(lines, from.line, to.line) : blockRangeAt(lines, from.line)) ??
			blockRangeAt(lines, from.line) ?? { from: from.line, to: from.line };
		// with no selection, a bullet list folds whole, first item as the title,
		// siblings as the body, instead of stranding them outside the callout
		const range = hasSelection ? picked : listStretchRange(lines, picked);
		const isToggle = /^\s*>\s*\[!\w+\]-/.test(lines[range.from]);
		const next = transformBlock(
			lines,
			range,
			isToggle ? "paragraph" : "callout",
			isToggle ? undefined : { type: "toggle", folded: true }
		);
		this.applyDoc(ed, lines, next, range.from);
		const l = ed.getLine(range.from);
		ed.setCursor({ line: range.from, ch: l.length });
	}

	/** Notion-style toggle list: bullet title, indented children fold under it.
	 *  Selection-aware like toggleBlock. */
	toggleListBlock(ed: Editor) {
		const lines = ed.getValue().split("\n");
		const from = ed.getCursor("from");
		const to = ed.getCursor("to");
		const hasSelection = from.line !== to.line || from.ch !== to.ch;
		const picked =
			(hasSelection ? unionBlockRange(lines, from.line, to.line) : blockRangeAt(lines, from.line)) ??
			blockRangeAt(lines, from.line) ?? { from: from.line, to: from.line };
		// same rule as toggleBlock: a whole flat list becomes ONE toggle
		const range = hasSelection ? picked : listStretchRange(lines, picked);
		this.applyDoc(ed, lines, transformBlock(lines, range, "toggleList"), range.from);
		const l = ed.getLine(range.from);
		ed.setCursor({ line: range.from, ch: l.length });
	}

	/** If a collapsed caret has landed before a heading's hidden "# " marker,
	 *  move it just past the marker so typing produces "# text", not "text# ".
	 *  A no-op everywhere else. Invisible because the hidden marker is zero-width. */
	private snapHeadingCaret() {
		if (!this.settings.wysiwygMarks) return;
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!view || view.getMode() !== "source") return;
		const ed = view.editor;
		const from = ed.getCursor("from");
		const to = ed.getCursor("to");
		if (from.line !== to.line || from.ch !== to.ch) return; // a range selection: leave it
		const snapped = headingCursorSnap(ed.getLine(from.line), from.ch);
		if (snapped != null && snapped !== from.ch) ed.setCursor({ line: from.line, ch: snapped });
	}

	/** Turn the block under the cursor into another kind (slash commands). */
	turnCurrentInto(ed: Editor, kind: BlockKind, callout?: CalloutSpec) {
		const lines = ed.getValue().split("\n");
		const line = ed.getCursor().line;
		// Empty line + a markerable kind: drop in a bare marker and park the
		// cursor, so /Heading on a blank line gives a ready-to-type "# " (whose
		// placeholder then reads "Heading 1") instead of transformBlock's
		// empty-body filter deleting the line outright.
		const BARE: Partial<Record<BlockKind, string>> = {
			h1: "# ", h2: "## ", h3: "### ", bullet: "- ", ordered: "1. ", task: "- [ ] ", quote: "> ",
		};
		if (!lines[line]?.trim() && BARE[kind]) {
			const marker = BARE[kind] as string;
			ed.setLine(line, marker);
			const at = { line, ch: marker.length };
			ed.setCursor(at);
			// EditorSuggest can reset the caret to the line start after the action
			// returns; re-assert it past the marker on the next tick.
			window.setTimeout(() => ed.setCursor(at), 0);
			return;
		}
		const picked = blockRangeAt(lines, line) ?? { from: line, to: line };
		// toggle-shaped targets swallow the whole list; other kinds keep
		// per-block semantics (turning one item into a heading stays one item)
		const range = kind === "toggleList" || kind === "callout" ? listStretchRange(lines, picked) : picked;
		this.applyDoc(ed, lines, transformBlock(lines, range, kind, callout), range.from);
		const l = ed.getLine(range.from);
		ed.setCursor({ line: range.from, ch: l.length });
	}

	private ensureToolbars() {
		const show = this.settings.showToolbar && (Platform.isDesktopApp || this.settings.showOnMobile);
		for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
			const view = leaf.view as MarkdownView;
			const existing = view.containerEl.querySelector(":scope > .ped-toolbar") as HTMLElement | null;
			if (!show) {
				existing?.remove();
				continue;
			}
			if (!existing) this.buildToolbar(view);
			const bar = view.containerEl.querySelector(":scope > .ped-toolbar") as HTMLElement | null;
			bar?.toggleClass("ped-hidden", view.getMode() !== "source");
		}
		this.queueStateRefresh();
	}

	/** The toolbar's buttons in the order they should appear. Unknown ids are
	 *  dropped and anything the order has not heard of is appended, so a button
	 *  added in a later version still shows up instead of silently vanishing
	 *  for anyone who has customized the order. */
	orderedButtonIds(): string[] {
		const known = new Set(BUTTON_IDS.map(([id]) => id));
		const saved = this.settings.buttonOrder.length ? this.settings.buttonOrder : DEFAULT_BUTTON_ORDER;
		const out = saved.filter((id) => id === "|" || known.has(id));
		for (const [id] of BUTTON_IDS) if (!out.includes(id)) out.push(id);
		return out;
	}

	private buildToolbar(view: MarkdownView) {
		const content = view.containerEl.querySelector(":scope > .view-content");
		if (!content) return;
		const el = createDiv({ cls: "ped-toolbar" });
		view.containerEl.insertBefore(el, content);
		const buttons = new Map<string, HTMLElement>();
		const hidden = new Set(this.settings.hiddenButtons);
		// pointerdown always preventDefaults (keeps the editor's focus and
		// selection); instant actions run there, but anything that OPENS a menu
		// runs on click - opening during pointerdown lets the same click's
		// release land outside the menu and close it immediately.
		const btn = (id: string, icon: string, tip: string, fn: (ed: Editor) => void, opens: "act" | "menu" = "act") => {
			if (hidden.has(id)) return null;
			const b = el.createEl("button", { cls: "ped-btn", attr: { "aria-label": tip } });
			setIcon(b, icon);
			b.addEventListener("pointerdown", (e) => {
				e.preventDefault();
				if (opens === "act") {
					const ed = this.activeEditor();
					if (ed) fn(ed);
				}
			});
			if (opens === "menu") {
				b.addEventListener("click", () => {
					const ed = this.activeEditor();
					if (ed) fn(ed);
				});
			}
			buttons.set(id, b);
			return b;
		};
		let headingLabel: HTMLElement = createSpan();

		// One factory per button, keyed by id, so the order is data rather than
		// the shape of this function. Each closure keeps its own reference where
		// a button has to anchor its own menu.
		const make: Record<string, () => void> = {
			undo: () => void btn("undo", "undo-2", "Undo", (ed) => (ed as unknown as { undo?: () => void }).undo?.()),
			redo: () => void btn("redo", "redo-2", "Redo", (ed) => (ed as unknown as { redo?: () => void }).redo?.()),
			heading: () => {
				if (hidden.has("heading")) return;
				const heading = el.createEl("button", { cls: "ped-btn ped-heading", attr: { "aria-label": "Paragraph style" } });
				headingLabel = heading.createSpan({ text: "\u00b6" });
				heading.addEventListener("pointerdown", (e) => e.preventDefault());
				heading.addEventListener("click", () => {
					const ed = this.activeEditor();
					if (ed) this.openHeadingMenu(ed, heading);
				});
				buttons.set("heading", heading);
			},
			bold: () => void btn("bold", "bold", "Bold", (ed) => this.toggleEmphasis(ed, "bold")),
			italic: () => void btn("italic", "italic", "Italic", (ed) => this.toggleEmphasis(ed, "italic")),
			underline: () => void btn("underline", "underline", "Underline", (ed) => this.toggleWrap(ed, "<u>", "</u>")),
			strike: () => void btn("strike", "strikethrough", "Strikethrough", () => this.cmd("editor:toggle-strikethrough")),
			highlight: () => {
				const hl: HTMLElement | null = btn("highlight", "highlighter", "Highlight color", (ed) => this.openColorPopover(ed, hl ?? el, "hl"), "menu");
			},
			code: () => void btn("code", "code", "Inline code", () => this.cmd("editor:toggle-code")),
			color: () => {
				const color: HTMLElement | null = btn("color", "palette", "Font color", (ed) => this.openColorPopover(ed, color ?? el, "text"), "menu");
			},
			fontsize: () => {
				const fsize: HTMLElement | null = btn("fontsize", "a-large-small", "Font size, subscript & superscript", (ed) => this.showFontSizeMenu(ed, fsize ?? el), "menu");
				if (fsize && !fsize.querySelector("svg")) setIcon(fsize, "type");
			},
			painter: () => {
				const painter = btn(
					"painter",
					"paintbrush",
					"Format painter: click to paint once, double-click to keep painting",
					(ed) => this.armPainter(ed),
					"menu"
				);
				painter?.addEventListener("dblclick", () => {
					const ed = this.activeEditor();
					if (ed) this.armPainter(ed, true);
				});
			},
			emoji: () => {
				const emo: HTMLElement | null = btn("emoji", "smile", "Emoji", (ed) => this.showEmojiPicker(ed, emo ?? el), "menu");
			},
			bullet: () => void btn("bullet", "list", "Bulleted list", () => this.cmd("editor:toggle-bullet-list")),
			ordered: () => void btn("ordered", "list-ordered", "Numbered list", () => this.cmd("editor:toggle-numbered-list")),
			task: () => void btn("task", "list-checks", "Checklist", () => this.cmd("editor:toggle-checklist-status")),
			quote: () => void btn("quote", "quote", "Quote", () => this.cmd("editor:toggle-blockquote")),
			callout: () => {
				const callout: HTMLElement | null = btn(
					"callout",
					"lightbulb",
					"Callout: turn this block into a tip, note, warning...",
					(ed) => {
						const r = (callout ?? el).getBoundingClientRect();
						this.pickCalloutAtCursor(ed, { x: r.left, y: r.bottom + 4 });
					},
					"menu"
				);
			},
			toggle: () =>
				void btn("toggle", "chevron-right", "Toggle block: collapse this block behind its first line (click again to unwrap)", (ed) =>
					this.toggleBlock(ed)
				),
			align: () => {
				const align: HTMLElement | null = btn("align", "align-left", "Text alignment", (ed) => this.openAlignMenu(ed, align ?? el), "menu");
			},
			indent: () => void btn("indent", "indent-increase", "Increase indent", (ed) => this.indent(ed, 1)),
			outdent: () => void btn("outdent", "indent-decrease", "Decrease indent", (ed) => this.indent(ed, -1)),
			link: () => void btn("link", "link", "Insert or edit link", (ed) => this.openLinkDialog(ed), "menu"),
			codeblock: () => {
				const cbBtn: HTMLElement | null = btn("codeblock", "code-square", "Code block (pick a language)", (ed) => this.insertCodeBlock(ed, rectBelow(cbBtn ?? el)), "menu");
			},
			table: () => {
				const tbl: HTMLElement | null = btn("table", "table", "Insert table", (ed) => this.openTableGrid(ed, tbl ?? el), "menu");
			},
			hr: () => void btn("hr", "minus", "Horizontal rule", () => this.cmd("editor:insert-horizontal-rule")),
			findreplace: () => void btn("findreplace", "text-search", "Find & replace in this note", () => this.cmd("editor:open-search-replace")),
			dictate: () => {
				const mic = btn("dictate", "mic", "Dictate: click, talk, click again to stop (right-click: raw / tidy / bullets)", (ed) =>
					void this.toggleDictation(ed)
				);
				mic?.addEventListener("contextmenu", (e) => {
					e.preventDefault();
					this.showDictationModes(mic);
				});
			},
			ai: () => void btn("ai", "sparkles", "AI edit the selection", (ed) => this.showAiMenu(ed, buttons.get("ai") ?? el), "menu"),
			clear: () => void btn("clear", "remove-formatting", "Clear formatting", (ed) => this.clearFormatting(ed)),
		};

		// A divider only renders once something has actually appeared after it,
		// so hiding a whole group cannot leave two rules touching, a rule at the
		// start, or a rule trailing off the end.
		let pendingSep = false;
		let anyYet = false;
		for (const id of this.orderedButtonIds()) {
			if (id === "|") {
				pendingSep = anyYet;
				continue;
			}
			const before = el.childElementCount;
			make[id]?.();
			if (el.childElementCount === before) continue; // hidden, so nothing was added
			if (pendingSep) {
				el.insertBefore(createDiv({ cls: "ped-sep" }), el.lastElementChild);
				pendingSep = false;
			}
			anyYet = true;
		}

		this.bars.set(view, { el, buttons, headingLabel });
	}

	/* ---------------- actions ---------------- */

	private activeEditor(): Editor | null {
		// a focused tab pane registers itself as the workspace's active editor,
		// which routes the toolbar and commands into the pane like a note
		const info = this.app.workspace.activeEditor;
		if (info && isPaneOwner(info) && info.editor) return info.editor;
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		return view && view.getMode() === "source" ? view.editor : null;
	}

	private cmd(id: string) {
		(this.app as unknown as { commands?: { executeCommandById?: (id: string) => void } }).commands?.executeCommandById?.(id);
	}

	private applyHeading(ed: Editor, level: number) {
		if (this.inTableCell()) {
			new Notice("Power Editor: a table cell cannot be a heading.", 4000);
			return;
		}
		const from = ed.getCursor("from").line;
		const to = ed.getCursor("to").line;
		const changes = [];
		for (let l = from; l <= to; l++) {
			const text = setHeading(ed.getLine(l), level);
			if (text !== ed.getLine(l))
				changes.push({ from: { line: l, ch: 0 }, to: { line: l, ch: ed.getLine(l).length }, text });
		}
		if (changes.length) ed.transaction({ changes });
		this.queueStateRefresh();
	}

	private toggleWrap(ed: Editor, open: string, close: string) {
		const sel = ed.getSelection();
		if (sel.startsWith(open) && sel.endsWith(close)) {
			ed.replaceSelection(sel.slice(open.length, sel.length - close.length));
			return;
		}
		if (sel) {
			ed.replaceSelection(open + sel + close);
			return;
		}
		const cur = ed.getCursor();
		ed.replaceRange(open + close, cur);
		ed.setCursor({ line: cur.line, ch: cur.ch + open.length });
	}

	/** Bold/italic that adapts to context: inside a color or highlight the
	 *  emphasis must be HTML (Obsidian won't format ** inside inline HTML off
	 *  the active line), everywhere else Obsidian's native ** / * keeps the
	 *  Markdown portable. */
	private toggleEmphasis(ed: Editor, kind: "bold" | "italic") {
		const from = ed.getCursor("from");
		const to = ed.getCursor("to");
		const inWrapper =
			from.line === to.line &&
			(() => {
				const w = wrapperAt(ed.getLine(from.line), from.ch, to.ch);
				return w.highlighted || w.color != null;
			})();
		if (inWrapper) this.toggleHtmlEmphasis(ed, kind === "bold" ? ["strong", "b"] : ["em", "i"]);
		else this.cmd(kind === "bold" ? "editor:toggle-bold" : "editor:toggle-italics");
	}

	/** Toggle an HTML emphasis wrapper around the selection: if it already sits
	 *  inside one of `tags`, strip that tag; otherwise wrap in the first tag. */
	private toggleHtmlEmphasis(ed: Editor, tags: string[]) {
		const from = ed.getCursor("from");
		const to = ed.getCursor("to");
		if (from.line === to.line) {
			const line = ed.getLine(from.line);
			const re = new RegExp(`<(${tags.join("|")})>([\\s\\S]*?)<\\/\\1>`, "gi");
			let m: RegExpExecArray | null;
			while ((m = re.exec(line))) {
				const s = m.index;
				const openLen = m[0].indexOf(">") + 1;
				const innerFrom = s + openLen;
				const innerTo = s + m[0].length - `</${m[1]}>`.length;
				if (innerFrom <= from.ch && innerTo >= to.ch) {
					ed.transaction({ changes: [{ from: { line: from.line, ch: s }, to: { line: from.line, ch: s + m[0].length }, text: m[2] }] });
					ed.setSelection({ line: from.line, ch: from.ch - openLen }, { line: from.line, ch: to.ch - openLen });
					this.queueStateRefresh();
					return;
				}
			}
		}
		const open = `<${tags[0]}>`;
		const close = `</${tags[0]}>`;
		ed.replaceSelection(open + ed.getSelection() + close);
		this.queueStateRefresh();
	}

	/** True when ch sits inside one of the given HTML emphasis tags on the line. */
	private inHtmlTag(line: string, ch: number, tags: string[]): boolean {
		const re = new RegExp(`<(${tags.join("|")})>([\\s\\S]*?)<\\/\\1>`, "gi");
		let m: RegExpExecArray | null;
		while ((m = re.exec(line))) {
			if (m.index < ch && m.index + m[0].length > ch) return true;
		}
		return false;
	}

	/** Pick the language first: a fence with no language gets no syntax
	 *  highlighting, which is most of why a bare code block looks flat. */
	insertCodeBlock(ed: Editor, at?: { x: number; y: number }) {
		const menu = new Menu();
		for (const [lang, label] of CODE_LANGS) {
			menu.addItem((i) => i.setTitle(label).onClick(() => this.writeCodeBlock(ed, lang)));
		}
		menu.showAtPosition(at ?? this.cursorPoint());
	}

	/** A fence written where the cursor stands leaves its body and its closing
	 *  fence at column 0, which ends the list the block was meant for: the block
	 *  renders outside the step, misaligned with the step above it, and the
	 *  stranded closing fence reads as the START of another block, so everything
	 *  typed after it disappears into code with no way out. Inside a list every
	 *  line of the block sits at the item's content column instead, the empty
	 *  body line included, so the first thing typed lands there too. */
	private writeCodeBlock(ed: Editor, lang: string) {
		const from = ed.getCursor("from");
		const line = ed.getLine(from.line);
		const indent = listContentIndent(line);
		const sel = ed.getSelection();
		if (sel) {
			// the selection is the block's body, so it stays where it was found
			const at = (l: string) => (!l.trim() || l.startsWith(indent) ? l : indent + l);
			ed.replaceSelection("```" + lang + "\n" + sel.split("\n").map(at).join("\n") + "\n" + indent + "```");
			return;
		}
		// A step holding nothing but its marker opens the fence on that line, so
		// the block sits beside the number the way the step's words would. Words
		// already on the line keep it and the block starts below them.
		const head = !line.trim() || (indent && !textBesideMarker(line)) ? "" : "\n";
		ed.replaceRange(head + (head ? indent : "") + "```" + lang + "\n" + indent + "\n" + indent + "```", { line: from.line, ch: line.length });
		ed.setCursor({ line: from.line + (head ? 2 : 1), ch: indent.length });
	}

	/** Change the language on the fence the cursor is inside, so an existing
	 *  block can be highlighted without retyping the fence. */
	setCodeBlockLanguage(ed: Editor) {
		const lines = ed.getValue().split("\n");
		const cur = ed.getCursor().line;
		let open = -1;
		for (let i = cur; i >= 0; i--) {
			if (FENCE_LINE.test(lines[i])) {
				open = i;
				break;
			}
		}
		if (open < 0) {
			new Notice("Put the cursor inside a code block first.");
			return;
		}
		this.pickLanguageForFence(ed, open);
	}

	/** Notion's language dropdown: a search box over every language, anchored
	 *  on the button. Type to filter, arrows to move, Enter to pick. The
	 *  block's own first lines are read for a shebang so the likely answer is
	 *  offered first on a fence that has none yet. */
	pickLanguageForFence(ed: Editor, line: number, anchor?: HTMLElement) {
		this.closeLangPicker();
		const lines = ed.getValue().split("\n");
		const m = FENCE_LINE.exec(lines[line] ?? "");
		if (!m) return;
		const current = parseFenceInfo(m[4]).lang;
		const guess = current ? null : guessLanguage(lines.slice(line + 1, line + 6));

		const pop = createDiv({ cls: "ped-langpop" });
		document.body.appendChild(pop);
		this.langPopover = pop;
		const r = anchor?.getBoundingClientRect();
		pop.style.left = Math.max(8, Math.min((r?.left ?? 200) - 120, window.innerWidth - 268)) + "px";
		pop.style.top = (r ? r.bottom + 6 : 160) + "px";
		const search = pop.createEl("input", {
			cls: "ped-langpop-search",
			attr: { type: "text", placeholder: "Search for a language…", spellcheck: "false" },
		});
		const list = pop.createDiv({ cls: "ped-langpop-list" });

		const close = () => this.closeLangPicker();
		const apply = (lang: string) => {
			close();
			const fresh = ed.getLine(line);
			const fm = FENCE_LINE.exec(fresh);
			if (!fm) return;
			// keep whatever filename the fence already carries, and the step's
			// own marker when the block opens on a list item's line
			const keep = parseFenceInfo(fm[4]).file;
			ed.replaceRange(fm[1] + (fm[2] ?? "") + fm[3] + formatFenceInfo(lang, keep), { line, ch: 0 }, { line, ch: fresh.length });
			ed.focus();
		};

		let rows: HTMLElement[] = [];
		let active = 0;
		const setActive = (i: number) => {
			if (!rows.length) return;
			active = (i + rows.length) % rows.length;
			rows.forEach((el, n) => el.toggleClass("is-active", n === active));
			rows[active].scrollIntoView({ block: "nearest" });
		};
		const render = (q: string) => {
			const ql = q.trim().toLowerCase();
			let items = CODE_LANGS.filter(([v, label]) => !ql || label.toLowerCase().includes(ql) || v.includes(ql));
			if (guess && !ql) items = [...items].sort((a, b) => (a[0] === guess ? -1 : b[0] === guess ? 1 : 0));
			list.empty();
			rows = items.map(([v, label]) => {
				const row = list.createDiv({ cls: "ped-langpop-row" });
				row.createSpan({ text: label + (v === guess && !current ? "  (detected)" : "") });
				if (v === current) row.createSpan({ cls: "ped-langpop-check", text: "✓" });
				row.onclick = () => apply(v);
				return row;
			});
			setActive(0);
		};
		search.addEventListener("input", () => render(search.value));
		search.addEventListener("keydown", (e) => {
			if (e.key === "ArrowDown") {
				e.preventDefault();
				setActive(active + 1);
			} else if (e.key === "ArrowUp") {
				e.preventDefault();
				setActive(active - 1);
			} else if (e.key === "Enter") {
				e.preventDefault();
				rows[active]?.click();
			} else if (e.key === "Escape") {
				e.preventDefault();
				close();
			}
		});
		const onDoc = (e: PointerEvent) => {
			if (!pop.contains(e.target as Node) && e.target !== anchor && !anchor?.contains(e.target as Node)) close();
		};
		document.addEventListener("pointerdown", onDoc, true);
		(pop as HTMLElement & { pedCleanup?: () => void }).pedCleanup = () => document.removeEventListener("pointerdown", onDoc, true);
		render("");
		window.setTimeout(() => search.focus(), 0);
	}

	/** Name (or rename) the file a code block represents. The name lives in the
	 *  fence's own info string, so it travels with the note as plain Markdown
	 *  and other renderers simply ignore it. */
	renameCodeBlock(ed: Editor, line: number) {
		const fresh = ed.getLine(line);
		const m = FENCE_LINE.exec(fresh);
		if (!m) return;
		const { lang, file } = parseFenceInfo(m[4]);
		new TextPromptModal(this.app, file ? "Rename this block" : "Name this block", file, (value) => {
			const cur = ed.getLine(line);
			const cm = FENCE_LINE.exec(cur);
			if (!cm) return;
			ed.replaceRange(cm[1] + (cm[2] ?? "") + cm[3] + formatFenceInfo(lang, value.trim()), { line, ch: 0 }, { line, ch: cur.length });
			ed.focus();
		}).open();
	}

	private closeLangPicker() {
		const pop = this.langPopover as (HTMLElement & { pedCleanup?: () => void }) | null;
		if (!pop) return;
		pop.pedCleanup?.();
		pop.remove();
		this.langPopover = null;
	}

	/** Pick a multi-column layout, then drop its `columns` block at the cursor. */
	insertColumnsMenu(ed: Editor) {
		const menu = new Menu();
		const opt = (title: string, icon: string, layout: ColumnLayout) =>
			menu.addItem((i) => i.setTitle(title).setIcon(icon).onClick(() => this.insertColumns(ed, layout)));
		opt("Two columns", "columns-2", "two");
		opt("Three columns", "columns-3", "three");
		opt("Sidebar, then content", "panel-left", "sidebar-left");
		opt("Content, then sidebar", "panel-right", "sidebar-right");
		menu.showAtPosition({ x: window.innerWidth / 2 - 120, y: 160 });
	}

	private insertColumns(ed: Editor, layout: ColumnLayout) {
		const cur = ed.getCursor();
		const written = this.insertBlockAt(ed, columnsSnippet(layout) + "\n", cur);
		const fence = Math.max(0, written.findIndex((l) => l.trim()));
		ed.setCursor({ line: cur.line + fence + 1, ch: leadOf(written[fence + 1]) });
	}

	/** Word-style insert-table grid: sweep to the size you want, click. */
	private openTableGrid(ed: Editor, anchor: HTMLElement) {
		if (this.colorPop) {
			this.closeColorPopover();
			return;
		}
		const pop = document.body.createDiv({ cls: "ped-colorpop ped-tablepop" });
		this.colorPop = pop;
		const title = pop.createDiv({ cls: "ped-colorpop-title", text: "Insert table" });
		const grid = pop.createDiv({ cls: "ped-tablegrid" });
		const COLS = 8;
		const ROWS = 6;
		const cells: HTMLElement[] = [];
		const paint = (c: number, r: number) => {
			cells.forEach((cell, i) => cell.toggleClass("is-on", i % COLS < c && Math.floor(i / COLS) < r));
			title.setText(c && r ? `Insert table: ${c} × ${r}` : "Insert table");
		};
		for (let r = 1; r <= ROWS; r++) {
			for (let c = 1; c <= COLS; c++) {
				const cell = grid.createDiv({ cls: "ped-tablecell" });
				cells.push(cell);
				cell.addEventListener("pointerenter", () => paint(c, r));
				cell.addEventListener("pointerdown", (e) => {
					e.preventDefault();
					e.stopPropagation();
					this.closeColorPopover();
					this.insertTableAt(ed, c, r);
				});
			}
		}
		const r = anchor.getBoundingClientRect();
		pop.style.left = Math.min(r.left, window.innerWidth - 220) + "px";
		pop.style.top = r.bottom + 6 + "px";
	}

	/** Write a block where the cursor is, the way a pasted one lands: on a line
	 *  of its own, and at the content column of the list step it was written in.
	 *  Put in where the cursor stands, its second line stays at column 0, which
	 *  ends the list and leaves the block outside the step. A table takes the
	 *  rest of the note with it when that happens, since what follows an opened
	 *  table reads as more of the table. Returns the lines as written, so the
	 *  caller can put the caret inside them. */
	insertBlockAt(ed: Editor, md: string, pos: EditorPosition): string[] {
		const line = ed.getLine(pos.line);
		const text = planPastedMarkdown(md, line.slice(0, pos.ch), line.slice(pos.ch));
		ed.replaceRange(text, pos);
		return text.split("\n");
	}

	private insertTableAt(ed: Editor, cols: number, rows: number) {
		const cur = ed.getCursor();
		const pos = { line: cur.line, ch: ed.getLine(cur.line).length };
		const written = this.insertBlockAt(ed, tableSnippet(cols, rows), pos);
		const first = Math.max(0, written.findIndex((l) => /^[ \t]*\|/.test(l)));
		ed.setCursor({ line: pos.line + first, ch: leadOf(written[first]) + 2 });
	}

	private clearFormatting(ed: Editor) {
		// A selection strips in place, widened first, since under WYSIWYG the
		// hidden ==/mark/span markers sit just OUTSIDE the visible selection.
		// With no strippable selection, clearing works on whole lines, which
		// also resets headings and alignment.
		if (ed.getSelection()) {
			const { from, to } = this.expandStyleSelection(ed);
			const sel = ed.getRange(from, to);
			if (sel && stripFormatting(sel) !== sel) {
				ed.replaceRange(stripFormatting(sel), from, to);
				return;
			}
		}
		const from = ed.getCursor("from").line;
		const to = ed.getCursor("to").line;
		const changes: { from: EditorPosition; to: EditorPosition; text: string }[] = [];
		for (let l = from; l <= to; l++) {
			const line = ed.getLine(l);
			const out = clearAllFormatting(line);
			if (out !== line) changes.push({ from: { line: l, ch: 0 }, to: { line: l, ch: line.length }, text: out });
		}
		if (changes.length) ed.transaction({ changes });
	}

	/**
	 * The editor the cursor is really in.
	 *
	 * Usually the note's own. Inside a table cell in Live Preview it is not:
	 * Obsidian edits that cell in a CodeMirror of its own, nested in the table
	 * widget, and the note's editor is left holding a cursor pointing into the
	 * table's raw markdown. Writing there puts the text somewhere else in the
	 * table, or the cell syncs its own unchanged content back over it a moment
	 * later, which is what "I clicked Insert and nothing happened" looks like.
	 *
	 * So reads and writes both go to whichever CodeMirror has focus. Everywhere
	 * outside a table that IS the note's editor, and nothing changes.
	 */
	/**
	 * The CodeMirror that owns the focused element.
	 *
	 * Inside a table cell in Live Preview that is NOT the note's editor:
	 * Obsidian renders each table in a nested CodeMirror of its own (its
	 * stylesheet gives `.cm-table-widget` a full `.cm-scroller`/`.cm-content`/
	 * `.cm-cursorLayer` tree), so the cell's selection lives there and the
	 * note's editor reports none. Anything that asks the note's editor whether
	 * text is selected therefore sees nothing while a cell selection is plainly
	 * visible, which is what "the bubble doesn't work in tables" was.
	 */
	private focusedCm(fallback: EditorView | null): EditorView | null {
		const host = (document.activeElement as HTMLElement | null)?.closest?.(".cm-editor") as HTMLElement | null;
		return (host ? EditorView.findFromDOM(host) : null) ?? fallback;
	}

	/**
	 * True when the caret is inside a table cell in Live Preview.
	 *
	 * Whole-line rewrites must refuse in that case. A cell is edited in its own
	 * nested CodeMirror, but the note's Editor still addresses the raw markdown,
	 * where the "line" is the entire table row. Prefixing that with "## " does
	 * not make a heading of the cell, it rips the row out of the table, which
	 * is exactly what applying a heading to a cell used to do.
	 */
	private inTableCell(): boolean {
		return !!(document.activeElement as HTMLElement | null)?.closest?.(".cm-table-widget");
	}

	private cursorDoc(ed: Editor): CursorDoc {
		const main = (ed as unknown as { cm?: EditorView }).cm ?? null;
		// The CodeMirror that owns the focused element, the cell's when a table
		// cell is being edited, the note's otherwise. Reading the selection off
		// the view itself rather than the Editor wrapper is also the safer answer
		// if a future Obsidian edits cells inside the main editor after all: a
		// live selection beats a cursor the wrapper cached before the click.
		const cm = this.focusedCm(main);
		if (!cm) {
			return {
				from: ed.getCursor("from"),
				to: ed.getCursor("to"),
				selection: ed.getSelection(),
				line: (n) => ed.getLine(n),
				replace: (from, to, text) => {
					ed.replaceRange(text, from, to);
					ed.setCursor({ line: from.line, ch: from.ch + text.length });
				},
			};
		}
		const at = (pos: number): EditorPosition => {
			const l = cm.state.doc.lineAt(pos);
			return { line: l.number - 1, ch: pos - l.from };
		};
		const off = (p: EditorPosition) => {
			const n = Math.min(Math.max(p.line + 1, 1), cm.state.doc.lines);
			const l = cm.state.doc.line(n);
			return Math.min(l.from + p.ch, l.to);
		};
		const sel = cm.state.selection.main;
		return {
			from: at(sel.from),
			to: at(sel.to),
			selection: cm.state.sliceDoc(sel.from, sel.to),
			line: (n) => (n >= 0 && n < cm.state.doc.lines ? cm.state.doc.line(n + 1).text : ""),
			replace: (from, to, text) => {
				const f = off(from);
				cm.dispatch({ changes: { from: f, to: off(to), insert: text }, selection: { anchor: f + text.length } });
				cm.focus();
			},
		};
	}

	/** The Link dialog: prefills from the selection, or edits the link under
	 *  the cursor in place. */
	private openLinkDialog(ed: Editor) {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!view) return;
		const doc = this.cursorDoc(ed);
		let from = doc.from;
		let to = doc.to;
		let text = doc.selection;
		let address = "";
		let noteQuery = "";
		// a link under the cursor (or covering the selection) is edited in
		// place, fully prefilled, a selected bare URL is the ADDRESS, not
		// the display text
		const sameLine = from.line === to.line;
		const found = sameLine ? linkAt(doc.line(from.line), from.ch) : null;
		if (found && (!text || (found.start <= from.ch && found.end >= to.ch))) {
			from = { line: from.line, ch: found.start };
			to = { line: from.line, ch: found.end };
			text = found.text;
			if (found.wiki) noteQuery = found.url;
			else address = found.url;
		} else if (text && /^https?:\/\/\S+$/.test(text.trim())) {
			address = text.trim();
			text = "";
		}
		new LinkModal(this, doc, view, from, to, { text, address, noteQuery }).open();
	}

	/** Set text alignment on every selected line via hidden markers. */
	private applyAlign(ed: Editor, align: Align) {
		if (this.inTableCell()) {
			// alignment is a per-line marker; inside a cell it would land on the
			// table row. Power Tables owns cell alignment.
			new Notice("Use Power Tables to align a table cell.", 4000);
			return;
		}
		const from = ed.getCursor("from").line;
		const to = ed.getCursor("to").line;
		const changes = [];
		for (let l = from; l <= to; l++) {
			const line = ed.getLine(l);
			if (!line.trim()) continue;
			const next = setAlign(line, align);
			if (next !== line) changes.push({ from: { line: l, ch: 0 }, to: { line: l, ch: line.length }, text: next });
		}
		if (changes.length) ed.transaction({ changes });
	}

	/** Indent or outdent the selected lines, native CodeMirror behavior, the
	 *  same as Tab / Shift+Tab, so lists nest correctly. */
	private indent(ed: Editor, dir: 1 | -1) {
		const exec = (ed as unknown as { exec?: (cmd: string) => void }).exec;
		if (exec) {
			exec.call(ed, dir === 1 ? "indentMore" : "indentLess");
			return;
		}
		// fallback: raw tab handling
		const from = ed.getCursor("from").line;
		const to = ed.getCursor("to").line;
		const changes = [];
		for (let l = from; l <= to; l++) {
			const line = ed.getLine(l);
			if (dir === 1) changes.push({ from: { line: l, ch: 0 }, to: { line: l, ch: 0 }, text: "\t" });
			else if (/^(\t| {1,4})/.test(line))
				changes.push({ from: { line: l, ch: 0 }, to: { line: l, ch: (line.match(/^(\t| {1,4})/) as RegExpMatchArray)[1].length }, text: "" });
		}
		if (changes.length) ed.transaction({ changes });
	}

	/** One whole-document edit (a single undo step), then park the cursor.
	 *  The viewport stays exactly where it was unless `follow` is set, a
	 *  whole-doc change plus recentering is what made pages look like they
	 *  jumped after every block move. */
	private applyDoc(ed: Editor, prevLines: string[], nextLines: string[], cursorLine: number, follow = false) {
		const scroller = ((ed as unknown as { cm?: EditorView }).cm as EditorView | undefined)?.scrollDOM ?? null;
		const scrollTop = scroller?.scrollTop ?? 0;
		// Narrow the write to the lines that actually changed. Replacing the
		// whole document (which is what this used to do) invalidates every
		// position in it, and CodeMirror's folds are positions: collapse a
		// dozen headings, delete one block, and all twelve spring open.
		const e = narrowEdit(prevLines, nextLines);
		if (e.from > e.to && e.text.length === 0) return; // nothing changed
		let from = { line: e.from, ch: 0 };
		let to = { line: Math.max(e.from, e.to), ch: 0 };
		let text = e.text.join("\n");
		if (e.text.length === 0) {
			// A pure deletion has to swallow one line break too, or the range
			// collapses to a blank line instead of disappearing.
			if (e.to + 1 < prevLines.length) {
				from = { line: e.from, ch: 0 };
				to = { line: e.to + 1, ch: 0 };
			} else if (e.from > 0) {
				from = { line: e.from - 1, ch: prevLines[e.from - 1].length };
				to = { line: e.to, ch: prevLines[e.to].length };
			} else {
				to = { line: e.to, ch: prevLines[e.to].length };
			}
		} else if (e.from > e.to) {
			// Pure insertion: nothing is replaced, so open a gap at `from`.
			text += "\n";
		} else {
			to = { line: e.to, ch: prevLines[e.to].length };
		}
		ed.transaction({ changes: [{ from, to, text }] });
		const line = Math.min(cursorLine, nextLines.length - 1);
		ed.setCursor({ line, ch: 0 });
		if (follow) {
			ed.scrollIntoView({ from: { line, ch: 0 }, to: { line, ch: 0 } }, true);
		} else if (scroller) {
			scroller.scrollTop = scrollTop;
			window.requestAnimationFrame(() => (scroller.scrollTop = scrollTop));
		}
	}

	/** The unit a grip or command operates on: the block under `line`, widened
	 *  to the whole selection when it spans blocks, and to the whole section
	 *  when grabbing a heading (if that setting is on). */
	private rangeFor(ed: Editor, lines: string[], line: number): BlockRange | null {
		const sections = this.settings.headingSections;
		const selFrom = ed.getCursor("from").line;
		const selTo = ed.getCursor("to").line;
		if (selTo > selFrom && line >= selFrom && line <= selTo && ed.getSelection().trim()) {
			return unionBlockRange(lines, selFrom, selTo, sections);
		}
		return sections ? sectionRangeAt(lines, line) : blockRangeAt(lines, line);
	}

	/** What a paste should insert, or null to let Obsidian handle it as usual.
	 *  Plain text wins when it already holds a Markdown table, since chat apps
	 *  put their own Markdown on the clipboard and that original beats any
	 *  conversion. Otherwise the HTML is converted, tables included, and it is
	 *  kept when it came out as one clean table (that keeps the cell
	 *  formatting Word and Outlook carry). When it did not, the plain text
	 *  gets its turn: a copied table also rides along as tab-separated rows,
	 *  and rebuilding those beats a pile of one-row tables. */
	private pastedMarkdown(html: string | null | undefined, plain: string | null | undefined): string | null {
		const text = (plain ?? "").replace(/\r\n?/g, "\n");
		if (text.trim() && looksLikeMarkdownTable(text)) return text.trim();
		const md = html ? cleanPastedHtml(html, htmlToMarkdown) : null;
		if (md && isOneMarkdownTable(md)) return md;
		return tabbedTextToMarkdown(text) ?? md;
	}

	/** What a paste should write here. Markdown as it stands, unless the cursor
	 *  is in a list: a table or a code block dropped in as it stands puts its
	 *  second line back at column 0, which ends the list and leaves the block
	 *  outside the step it was meant for. Inside a fenced block a paste is code
	 *  and is left exactly as it was copied. */
	private plannedPaste(ed: Editor, md: string): string {
		const from = ed.getCursor("from");
		const to = ed.getCursor("to");
		if (insideFence(ed.getRange({ line: 0, ch: 0 }, from))) return md;
		return planPastedMarkdown(md, ed.getLine(from.line).slice(0, from.ch), ed.getLine(to.line).slice(to.ch));
	}

	/** Insert pasted Markdown, keeping a table or a code block on its own block
	 *  and inside the list item it was dropped into. Dropping table rows onto
	 *  the end of a paragraph turns them into literal pipe text. */
	private insertPasted(ed: Editor, md: string) {
		ed.replaceSelection(this.plannedPaste(ed, md));
	}

	private async clipboardHtml(): Promise<string | null> {
		try {
			for (const item of await navigator.clipboard.read()) {
				if (item.types.includes("text/html")) {
					return await (await item.getType("text/html")).text();
				}
			}
		} catch {
			/* no async clipboard (or no html) */
		}
		return null;
	}

	/** Rewrite the clipboard's plain text when copying or cutting a formatted
	 *  selection out of a Power Editor pane. In Live Preview the selection maps
	 *  to the Markdown source, so a highlight copies its <mark> tags; this puts
	 *  clean text on the clipboard instead. Only steps in when there is actually
	 *  something to strip, so plain selections copy exactly as before. */
	private onCopyOut(e: ClipboardEvent, isCut: boolean) {
		const mode = this.settings.copyMode;
		if (mode === "off") return;
		const target = e.target as HTMLElement | null;
		if (!target?.closest?.(".markdown-source-view.mod-cm6")) return;
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!view || view.getMode() !== "source" || !view.containerEl.contains(target)) return;
		const ed = view.editor;
		const sel = ed.getSelection();
		if (!sel) return;
		const cleaned = cleanCopyText(sel, mode);
		if (cleaned === sel) return; // nothing formatted, let Obsidian's own copy run
		e.preventDefault();
		e.stopPropagation();
		e.clipboardData?.setData("text/plain", cleaned);
		if (isCut) ed.replaceSelection("");
	}

	/* ---------------- format painter ---------------- */

	/** Painter semantics: click = paint once, double-click = keep painting
	 *  until Esc (or clicking the brush again). Detection reads the syntax
	 *  tree and enclosing HTML wrappers, a WYSIWYG selection holds only the
	 *  inner text, so scanning the selection string finds nothing. */
	private armPainter(ed: Editor, sticky = false) {
		if (this.painter && !sticky) {
			this.painter = null;
			this.paintButtons(false);
			return;
		}
		const sel = ed.getSelection();
		if (!sel) {
			new Notice("Select formatted text first, then click the painter.");
			return;
		}
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		const tree = view ? this.treeMarks(view) : null;
		const from = ed.getCursor("from");
		const to = ed.getCursor("to");
		const wrap = from.line === to.line ? wrapperAt(ed.getLine(from.line), from.ch, to.ch) : { underline: false, color: null, highlighted: false };
		const text = detectMarks(sel);
		const marks: Marks = {
			bold: (tree?.bold ?? false) || text.bold,
			italic: (tree?.italic ?? false) || text.italic,
			strike: (tree?.strike ?? false) || text.strike,
			highlight: (tree?.highlight ?? false) || text.highlight || wrap.highlighted,
			underline: text.underline || wrap.underline,
			color: text.color ?? wrap.color,
		};
		if (!hasAnyMark(marks)) {
			new Notice("That selection has no formatting to copy.");
			return;
		}
		this.painter = { marks, sticky };
		this.paintButtons(true);
		new Notice(sticky ? "Format painter locked (Esc or click the brush to stop)." : "Format painter armed (select the text to paint).");
	}

	private paintButtons(on: boolean) {
		for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
			this.bars.get(leaf.view as MarkdownView)?.buttons.get("painter")?.toggleClass("is-active", on);
		}
		this.bubbleButtons.get("painter")?.toggleClass("is-active", on);
	}

	private tryPaint() {
		if (!this.painter) return;
		const ed = this.activeEditor();
		const sel = ed?.getSelection();
		if (!ed || !sel) return;
		ed.replaceSelection(applyMarks(sel, this.painter.marks));
		if (!this.painter.sticky) {
			this.painter = null;
			this.paintButtons(false);
		}
	}

	/* ---------------- dictation ---------------- */

	/** An endpoint is usable once it has a key, or when it points at this machine
	 *  or the LAN, where a local transcription server usually needs none. */
	private usableTranscription(endpoint?: string, key?: string, model?: string): { endpoint: string; key: string; model: string } | null {
		if (!endpoint) return null;
		const local = /localhost|127\.0\.0\.1|192\.168\./.test(endpoint);
		if (!key && !local) return null;
		return { endpoint, key: key ?? "", model: model || "whisper-large-v3" };
	}

	/** Where dictation sends its audio: this plugin's own endpoint when set,
	 *  otherwise Power Assistant's, the same one its meeting recorder uses (older
	 *  installs used the Power Capture id; both are probed). Own settings come
	 *  first so dictation stands on its own, while a vault running both still
	 *  needs no second setup. */
	private transcriptionConfig(): { endpoint: string; key: string; model: string } | null {
		const own = this.usableTranscription(this.settings.transcriptionEndpoint, this.settings.transcriptionKey, this.settings.transcriptionModel);
		if (own) return own;
		const plugs = (this.app as unknown as { plugins?: { plugins?: Record<string, { settings?: Record<string, string> }> } })
			.plugins?.plugins;
		const s = (plugs?.["powerassistant"] ?? plugs?.["powercapture"])?.settings;
		return this.usableTranscription(s?.transcriptionEndpoint, s?.transcriptionKey, s?.transcriptionModel);
	}

	async toggleDictation(ed: Editor) {
		if (this.recorder) {
			this.recorder.stop();
			return;
		}
		const cfg = this.transcriptionConfig();
		if (!cfg) {
			new Notice(
				"Power Editor: dictation needs a transcription endpoint and key. Set them under AI & dictation in settings, or enable Power Assistant and configure transcription there to reuse it.",
				10000
			);
			return;
		}
		let stream: MediaStream;
		try {
			stream = await navigator.mediaDevices.getUserMedia({ audio: true });
		} catch {
			new Notice("Microphone unavailable or permission denied.");
			return;
		}
		const target = this.app.workspace.getActiveViewOfType(MarkdownView)?.editor ?? ed;
		const rec = new MediaRecorder(stream);
		this.recorder = rec;
		this.recChunks = [];
		rec.ondataavailable = (e) => {
			if (e.data.size) this.recChunks.push(e.data);
		};
		rec.onstop = async () => {
			stream.getTracks().forEach((t) => t.stop());
			this.recorder = null;
			this.setRecording(false);
			const blob = new Blob(this.recChunks, { type: (rec.mimeType || "audio/webm").split(";")[0] });
			this.recChunks = [];
			if (blob.size < 1000) {
				new Notice("Nothing recorded.");
				return;
			}
			new Notice("Power Editor: transcribing…");
			try {
				const text = await this.transcribeBlob(blob, cfg);
				if (!text.trim()) {
					new Notice("The transcription came back empty.");
					return;
				}
				this.insertDictation(target, await this.maybeTidy(text));
			} catch (e) {
				new Notice("Transcription failed: " + (e instanceof Error ? e.message : String(e)));
			}
		};
		rec.start();
		this.setRecording(true);
		new Notice("Power Editor: recording (click the mic again to stop).");
	}

	private setRecording(on: boolean) {
		for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
			this.bars.get(leaf.view as MarkdownView)?.buttons.get("dictate")?.toggleClass("is-recording", on);
		}
	}

	private async transcribeBlob(blob: Blob, cfg: { endpoint: string; key: string; model: string }): Promise<string> {
		const mime = blob.type || "audio/webm";
		const ext = mime.includes("ogg") ? "ogg" : mime.includes("mp4") ? "mp4" : "webm";
		const { contentType, body } = buildMultipart(
			{ model: cfg.model, response_format: "json" },
			"file",
			`dictation.${ext}`,
			mime,
			await blob.arrayBuffer()
		);
		const res = await requestUrl({
			url: cfg.endpoint.replace(/\/+$/, "") + "/audio/transcriptions",
			method: "POST",
			headers: { ...(cfg.key ? { Authorization: `Bearer ${cfg.key}` } : {}), "Content-Type": contentType },
			body,
			throw: true,
		});
		return (res.json as { text?: string }).text ?? "";
	}

	private insertDictation(ed: Editor, raw: string) {
		const cur = ed.getCursor();
		const line = ed.getLine(cur.line) ?? "";
		const plan = planDictationInsert(line, raw);
		const at = plan.atEnd ? { line: cur.line, ch: line.length } : cur;
		ed.replaceRange(plan.insert, at);
		const parts = plan.insert.split("\n");
		ed.setCursor({
			line: at.line + parts.length - 1,
			ch: parts.length === 1 ? at.ch + parts[0].length : parts[parts.length - 1].length,
		});
		ed.focus();
	}

	/** Optional post-dictation pass: filler-free prose or a bullet list. Any
	 *  failure falls back to the raw transcript, words never get lost. */
	private async maybeTidy(text: string): Promise<string> {
		const mode = this.settings.dictationMode;
		const key = this.aiKey();
		if (mode === "raw" || !key) return text;
		new Notice(mode === "tidy" ? "Power Editor: tidying…" : "Power Editor: making bullets…");
		try {
			const anthropic = new Anthropic({ apiKey: key, dangerouslyAllowBrowser: true });
			const msg = await anthropic.messages.create({
				model: this.settings.aiModel,
				max_tokens: 4096,
				system:
					mode === "tidy"
						? "You clean up dictated speech. Remove filler words, false starts, and repetitions; fix punctuation and sentence breaks. Keep every point, the speaker's own words where possible, and the original language. Reply with ONLY the cleaned text."
						: "You turn dictated speech into notes. Reply with ONLY a concise Markdown bullet list of the points made, in the original language.",
				messages: [{ role: "user", content: text }],
			});
			const out = msg.content
				.filter((b): b is Anthropic.TextBlock => b.type === "text")
				.map((b) => b.text)
				.join("\n")
				.trim();
			return out || text;
		} catch {
			return text;
		}
	}

	private showDictationModes(anchor: HTMLElement) {
		const menu = new Menu();
		const opt = (label: string, mode: PowerEditorSettings["dictationMode"], icon: string) =>
			menu.addItem((i) =>
				i.setTitle(label).setIcon(icon).setChecked(this.settings.dictationMode === mode).onClick(() => {
					this.settings.dictationMode = mode;
					void this.persistSettings();
				})
			);
		opt("Raw transcript", "raw", "mic");
		opt("Tidy into clean prose", "tidy", "wand-2");
		opt("Turn into bullet points", "bullets", "list");
		const r = anchor.getBoundingClientRect();
		menu.showAtPosition({ x: r.left, y: r.bottom + 4 });
	}

	/* ---------------- AI actions ---------------- */

	private aiKey(): string {
		if (this.settings.anthropicKey) return this.settings.anthropicKey;
		const plugs = (this.app as unknown as { plugins?: { plugins?: Record<string, { settings?: { anthropicKey?: string } }> } })
			.plugins?.plugins;
		const pc = plugs?.["powerassistant"] ?? plugs?.["powercapture"];
		return pc?.settings?.anthropicKey ?? "";
	}

	private async aiAction(ed: Editor, instruction: string) {
		const key = this.aiKey();
		if (!key) {
			new Notice("Power Editor: add an Anthropic API key in settings (or enable Power Assistant with one).");
			return;
		}
		const sel = ed.getSelection();
		if (!sel.trim()) {
			new Notice("Select the text to work on first.");
			return;
		}
		new Notice("Power Editor: thinking…");
		try {
			const anthropic = new Anthropic({ apiKey: key, dangerouslyAllowBrowser: true });
			const msg = await anthropic.messages.create({
				model: this.settings.aiModel,
				max_tokens: 4096,
				system:
					"You edit Markdown text. Reply with ONLY the rewritten text: no preamble, no quotes, no code fences. Preserve Markdown structure (links, emphasis, lists) unless the instruction says otherwise.",
				messages: [{ role: "user", content: `${instruction}\n\n"""\n${sel}\n"""` }],
			});
			const out = msg.content
				.filter((b): b is Anthropic.TextBlock => b.type === "text")
				.map((b) => b.text)
				.join("\n")
				.trim();
			if (out) ed.replaceSelection(out);
		} catch (e) {
			new Notice("Power Editor AI failed: " + (e instanceof Error ? e.message : String(e)), 6000);
		}
	}

	/** The paragraph-style menu (Normal text, Heading 1-6), anchored on whatever
	 *  button opened it. Shared by the toolbar and the selection bubble so the
	 *  two can never drift apart. */
	openHeadingMenu(ed: Editor, anchor: HTMLElement) {
		const menu = new Menu();
		const cur = headingLevel(ed.getLine(ed.getCursor().line));
		const opt = (label: string, level: number) =>
			menu.addItem((i) =>
				i
					.setTitle(label)
					.setChecked(cur === level)
					.onClick(() => this.applyHeading(ed, level))
			);
		opt("Normal text", 0);
		for (let h = 1; h <= 6; h++) opt("Heading " + h, h);
		const r = anchor.getBoundingClientRect();
		menu.showAtPosition({ x: r.left, y: r.bottom + 4 });
	}

	/** The text-alignment menu, likewise shared between the two bars. */
	openAlignMenu(ed: Editor, anchor: HTMLElement) {
		const menu = new Menu();
		const cur = alignOf(ed.getLine(ed.getCursor().line));
		const opt = (label: string, icon: string, a: Align) =>
			menu.addItem((i) => i.setTitle(label).setIcon(icon).setChecked(cur === a).onClick(() => this.applyAlign(ed, a)));
		opt("Align left", "align-left", "left");
		opt("Align center", "align-center", "center");
		opt("Align right", "align-right", "right");
		const r = anchor.getBoundingClientRect();
		menu.showAtPosition({ x: r.left, y: r.bottom + 4 });
	}

	/* ---------------- bubble menu ---------------- */

	private ensureBubble(): HTMLElement {
		if (this.bubbleEl) return this.bubbleEl;
		const el = document.body.createDiv({ cls: "ped-bubble" });
		const btn = (id: string, icon: string, tip: string, fn: (ed: Editor) => void, opens: "act" | "menu" = "act") => {
			const b = el.createEl("button", { cls: "ped-btn", attr: { "aria-label": tip } });
			setIcon(b, icon);
			b.addEventListener("pointerdown", (e) => {
				e.preventDefault();
				if (opens === "act") {
					const ed = this.activeEditor();
					if (ed) fn(ed);
				}
			});
			if (opens === "menu") {
				b.addEventListener("click", () => {
					const ed = this.activeEditor();
					if (ed) fn(ed);
				});
			}
			this.bubbleButtons.set(id, b);
			return b;
		};
		const sep = () => el.createDiv({ cls: "ped-sep" });
		// Paragraph style leads, as it does on the toolbar, and its label shows
		// the current level so the bubble reports the block you are in and not
		// just the inline marks.
		const bheading = el.createEl("button", { cls: "ped-btn ped-heading", attr: { "aria-label": "Paragraph style" } });
		this.bubbleHeadingLabel = bheading.createSpan({ text: "¶" });
		bheading.addEventListener("pointerdown", (e) => e.preventDefault());
		bheading.addEventListener("click", () => {
			const ed = this.activeEditor();
			if (ed) this.openHeadingMenu(ed, bheading);
		});
		sep();
		btn("bold", "bold", "Bold", (ed) => this.toggleEmphasis(ed, "bold"));
		btn("italic", "italic", "Italic", (ed) => this.toggleEmphasis(ed, "italic"));
		btn("underline", "underline", "Underline", (ed) => this.toggleWrap(ed, "<u>", "</u>"));
		const bhl = btn("highlight", "highlighter", "Highlight color", (ed) => this.openColorPopover(ed, bhl, "hl"), "menu");
		const bcolor = btn("color", "palette", "Font color", (ed) => this.openColorPopover(ed, bcolor, "text"), "menu");
		sep();
		btn("bullet", "list", "Bulleted list", () => this.cmd("editor:toggle-bullet-list"));
		btn("ordered", "list-ordered", "Numbered list", () => this.cmd("editor:toggle-numbered-list"));
		btn("task", "list-checks", "Checklist", () => this.cmd("editor:toggle-checklist-status"));
		const balign = btn("align", "align-left", "Text alignment", (ed) => this.openAlignMenu(ed, balign ?? el), "menu");
		sep();
		btn("link", "link", "Insert or edit link", (ed) => this.openLinkDialog(ed), "menu");
		btn("comment", "message-circle", "Add comment", (ed) => this.addComment(ed));
		const bp = btn("painter", "paintbrush", "Format painter: click to paint once, double-click to keep painting", (ed) => this.armPainter(ed), "menu");
		bp.addEventListener("dblclick", () => {
			const ed = this.activeEditor();
			if (ed) this.armPainter(ed, true);
		});
		btn("ai", "sparkles", "AI edit", (ed) => this.showAiMenu(ed, this.bubbleEl!), "menu");
		btn("clear", "remove-formatting", "Clear formatting", (ed) => this.clearFormatting(ed));
		this.bubbleEl = el;
		el.hide();
		return el;
	}

	/* ---------------- color palette popover ---------------- */

	private closeColorPopover() {
		this.colorPop?.remove();
		this.colorPop = null;
	}

	/** A swatch grid for font color or highlight color. Swatches
	 *  act on pointerdown with preventDefault, so the selection never blurs. */
	private openColorPopover(ed: Editor, anchor: HTMLElement, mode: "text" | "hl") {
		if (this.colorPop) {
			this.closeColorPopover();
			return;
		}
		if (!ed.getSelection()) {
			new Notice("Select some text first.");
			return;
		}
		const pop = document.body.createDiv({ cls: "ped-colorpop" });
		this.colorPop = pop;
		pop.createDiv({ cls: "ped-colorpop-title", text: mode === "text" ? "Font color" : "Highlight color" });
		const grid = pop.createDiv({ cls: "ped-swatches" });
		const swatch = (hex: string, title: string, fn: () => void, cls = "") => {
			const s = grid.createEl("button", { cls: "ped-swatch " + cls, attr: { "aria-label": title } });
			if (hex) s.style.background = hex;
			s.addEventListener("pointerdown", (e) => {
				e.preventDefault();
				e.stopPropagation();
				fn();
				this.closeColorPopover();
			});
			return s;
		};
		for (const hex of PALETTE) {
			swatch(hex, hex, () => this.applyColor(ed, mode, hex));
		}
		const foot = pop.createDiv({ cls: "ped-colorpop-foot" });
		const footBtn = (label: string, fn: () => void) => {
			const b = foot.createEl("button", { text: label, cls: "ped-colorpop-btn" });
			b.addEventListener("pointerdown", (e) => {
				e.preventDefault();
				e.stopPropagation();
				fn();
				this.closeColorPopover();
			});
		};
		if (mode === "hl") footBtn("Default ==", () => this.cmd("editor:toggle-highlight"));
		// More… opens the OS color dialog (with hex entry) via a native input
		const picker = pop.createEl("input", { type: "color", cls: "ped-colorpicker" });
		picker.value = mode === "text" ? "#0b6bcb" : "#fdf3d7";
		picker.addEventListener("change", () => {
			this.applyColor(ed, mode, picker.value);
			this.closeColorPopover();
		});
		const more = foot.createEl("button", { text: "More…", cls: "ped-colorpop-btn" });
		more.addEventListener("pointerdown", (e) => {
			e.preventDefault();
			e.stopPropagation();
			picker.click();
		});
		footBtn("Clear", () => this.applyColor(ed, mode, null));
		const r = anchor.getBoundingClientRect();
		pop.style.left = Math.min(r.left, window.innerWidth - 232) + "px";
		pop.style.top = r.bottom + 6 + "px";
	}

	/** Widen a selection so its endpoints don't sit inside hidden style
	 *  markers (==…==, <mark>, color spans) on their lines. */
	private expandStyleSelection(ed: Editor): { from: EditorPosition; to: EditorPosition } {
		const from = ed.getCursor("from");
		const to = ed.getCursor("to");
		if (from.line === to.line) {
			const r = expandStyleRange(ed.getLine(from.line), from.ch, to.ch);
			return { from: { line: from.line, ch: r.from }, to: { line: to.line, ch: r.to } };
		}
		return {
			from: { line: from.line, ch: expandStyleRange(ed.getLine(from.line), from.ch, from.ch).from },
			to: { line: to.line, ch: expandStyleRange(ed.getLine(to.line), to.ch, to.ch).to },
		};
	}

	/** Shared chooser for the highlight cleanup commands: remove, or convert
	 *  to one of the background colors. `label` carries the scan counts. */
	private showHighlightSweepMenu(label: string, run: (hex: string | null) => void) {
		const menu = new Menu();
		menu.addItem((i) => i.setTitle(`Remove ${label}`).setIcon("eraser").onClick(() => run(null)));
		menu.addSeparator();
		for (const [name, hex] of BG_COLORS) {
			menu.addItem((i) => i.setTitle(`Convert to ${name.toLowerCase()} background`).setIcon("highlighter").onClick(() => run(hex)));
		}
		menu.showAtPosition({ x: window.innerWidth / 2 - 140, y: 140 });
	}

	/** Clean up ==highlights== in the active note, one undoable edit. */
	private cleanNoteHighlights(ed: Editor) {
		const lines = ed.getValue().split("\n");
		const probe = sweepHighlights(lines.join("\n"), null);
		if (!probe.count) {
			new Notice("Power Editor: no ==highlights== in this note.");
			return;
		}
		this.showHighlightSweepMenu(`${probe.count} highlight${probe.count === 1 ? "" : "s"} in this note`, (hex) => {
			const res = sweepHighlights(lines.join("\n"), hex);
			this.applyDoc(ed, lines, res.text.split("\n"), ed.getCursor().line);
			new Notice(`${hex ? "Recolored" : "Removed"} ${res.count} highlight${res.count === 1 ? "" : "s"}.`);
		});
	}

	/** Clean up ==highlights== across every markdown file in the vault.
	 *  Scans first so the menu states exactly what it will touch. */
	private async cleanVaultHighlights() {
		const files = this.app.vault.getMarkdownFiles();
		const hits: TFile[] = [];
		let total = 0;
		for (const f of files) {
			const data = await this.app.vault.cachedRead(f);
			if (!data.includes("==")) continue;
			const n = sweepHighlights(data, null).count;
			if (n > 0) {
				hits.push(f);
				total += n;
			}
		}
		if (!total) {
			new Notice("Power Editor: no ==highlights== found in the vault.");
			return;
		}
		this.showHighlightSweepMenu(`all ${total} highlights across ${hits.length} notes`, (hex) => {
			void (async () => {
				let changed = 0;
				for (const f of hits) {
					await this.app.vault.process(f, (cur) => {
						const res = sweepHighlights(cur, hex);
						if (res.count > 0) changed++;
						return res.text;
					});
				}
				new Notice(`${hex ? "Recolored" : "Removed"} highlights in ${changed} note${changed === 1 ? "" : "s"}.`, 8000);
			})();
		});
	}

	private applyColor(ed: Editor, mode: "text" | "hl", hex: string | null) {
		if (!ed.getSelection()) return;
		// swallow the hidden wrapper markers around the visible selection
		// this is what lets a color change or Clear act on imported ==…==
		const { from, to } = this.expandStyleSelection(ed);
		let sel = ed.getRange(from, to);
		if (!sel) return;
		// inside a color or highlight, bold and italic must be HTML, since
		// Obsidian won't format ** inside inline HTML off the active line;
		// removing the wrapper hands the text back to portable Markdown
		let out: string;
		if (mode === "text") {
			sel = sel.replace(/<span style="color:[^"]*">([\s\S]*?)<\/span>/gi, "$1");
			out = hex ? `<span style="color:${hex}">${mdEmphasisToHtml(sel)}</span>` : htmlEmphasisToMd(sel);
		} else {
			sel = sel.replace(/<mark[^>]*>([\s\S]*?)<\/mark>/gi, "$1").replace(/==([\s\S]+?)==/g, "$1");
			out = hex ? `<mark style="background:${hex}">${mdEmphasisToHtml(sel)}</mark>` : htmlEmphasisToMd(sel);
		}
		ed.replaceRange(out, from, to);
		const parts = out.split("\n");
		const end =
			parts.length === 1
				? { line: from.line, ch: from.ch + parts[0].length }
				: { line: from.line + parts.length - 1, ch: parts[parts.length - 1].length };
		ed.setSelection(from, end);
	}

	/** Font size and sub/superscript, one menu, spans the engine renders live. */
	private showFontSizeMenu(ed: Editor, anchor: HTMLElement) {
		if (!ed.getSelection()) {
			new Notice("Select some text first.");
			return;
		}
		const menu = new Menu();
		for (const [label, em] of FONT_SIZES) {
			menu.addItem((i) => i.setTitle(label).setIcon("case-sensitive").onClick(() => this.applyFontSize(ed, em)));
		}
		menu.addSeparator();
		menu.addItem((i) => i.setTitle("Superscript").setIcon("arrow-up-right").onClick(() => this.applyScript(ed, "sup")));
		menu.addItem((i) => i.setTitle("Subscript").setIcon("arrow-down-right").onClick(() => this.applyScript(ed, "sub")));
		const r = anchor.getBoundingClientRect();
		menu.showAtPosition({ x: r.left, y: r.bottom + 4 });
	}

	private applyFontSize(ed: Editor, em: string | null) {
		const sel = ed.getSelection();
		if (sel) ed.replaceSelection(setFontSize(sel, em));
	}

	private applyScript(ed: Editor, tag: "sub" | "sup") {
		const sel = ed.getSelection();
		if (sel) ed.replaceSelection(toggleScript(sel, tag));
	}

	private showAiMenu(ed: Editor, anchor: HTMLElement) {
		const menu = new Menu();
		for (const [title, instruction] of AI_ACTIONS) {
			menu.addItem((i) => i.setTitle(title).setIcon("sparkles").onClick(() => void this.aiAction(ed, instruction)));
		}
		for (const a of this.settings.aiActions) {
			if (a.name.trim() && a.prompt.trim())
				menu.addItem((i) => i.setTitle(a.name).setIcon("wand-2").onClick(() => void this.aiAction(ed, a.prompt)));
		}
		menu.addSeparator();
		menu.addItem((i) => i.setTitle("Continue writing").setIcon("pen-line").onClick(() => void this.aiGenerate(ed, "continue")));
		menu.addItem((i) => i.setTitle("Summarize page into bullets").setIcon("list").onClick(() => void this.aiGenerate(ed, "summarize")));
		const r = anchor.getBoundingClientRect();
		menu.showAtPosition({ x: r.left, y: r.bottom + 4 });
	}

	/** Selection-free AI: continue from what's above the cursor, or distill the
	 *  whole page. Output lands at the cursor as its own block. */
	private async aiGenerate(ed: Editor, mode: "continue" | "summarize") {
		const key = this.aiKey();
		if (!key) {
			new Notice("Power Editor: add an Anthropic API key in settings (or enable Power Assistant with one).");
			return;
		}
		const cur = ed.getCursor();
		const context = mode === "continue" ? ed.getRange({ line: 0, ch: 0 }, cur).slice(-8000) : ed.getValue().slice(0, 24000);
		if (!context.trim()) {
			new Notice(mode === "continue" ? "Write a little first so there's something to continue." : "This page is empty.");
			return;
		}
		new Notice("Power Editor: thinking…");
		try {
			const anthropic = new Anthropic({ apiKey: key, dangerouslyAllowBrowser: true });
			const msg = await anthropic.messages.create({
				model: this.settings.aiModel,
				max_tokens: 1024,
				system:
					mode === "continue"
						? "Continue the user's document. Reply with ONLY the continuation in Markdown, a paragraph or two (or matching list items if a list is open), matching the document's tone, language, and formatting. No preamble."
						: "Summarize the user's document. Reply with ONLY a concise Markdown bullet list of the key points, in the document's language: no heading, no preamble.",
				messages: [{ role: "user", content: context }],
			});
			const out = msg.content
				.filter((b): b is Anthropic.TextBlock => b.type === "text")
				.map((b) => b.text)
				.join("\n")
				.trim();
			if (out) this.insertDictation(ed, out);
		} catch (e) {
			new Notice("Power Editor: AI call failed: " + (e instanceof Error ? e.message : String(e)));
		}
	}

	private queueBubbleUpdate() {
		if (this.bubbleTimer) return;
		this.bubbleTimer = window.setTimeout(() => {
			this.bubbleTimer = null;
			this.updateBubble();
		}, 60);
	}

	private updateBubble() {
		if (!this.settings.showBubble || this.dragging || !Platform.isDesktopApp) {
			this.bubbleEl?.hide();
			return;
		}
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		const ed = view?.getMode() === "source" ? view.editor : null;
		// The focused CodeMirror, not the note's: a selection inside a table cell
		// lives in the nested editor Obsidian gives each table, and the note's
		// editor reports no selection at all. Gating on the note's editor is why
		// the bubble never appeared over a table.
		const cm = this.focusedCm(view ? this.cmOf(view) : null);
		if (!view || !ed || !cm || !cm.hasFocus) {
			this.bubbleEl?.hide();
			return;
		}
		const main = cm.state.selection.main;
		// ...and ask that same view whether anything is selected, for the same
		// reason: ed.getSelection() is empty while a cell selection is visible.
		if (!cm.state.sliceDoc(main.from, main.to).trim()) {
			this.bubbleEl?.hide();
			return;
		}
		let head = cm.coordsAtPos(main.from);
		let tail = cm.coordsAtPos(main.to);
		if (!head || !tail) {
			// over a decorated or atomic region (a highlight, a color span)
			// coordsAtPos reads null, which used to swallow the bubble; fall back
			// to the live selection's own screen rectangle
			const sel = cm.dom.ownerDocument.getSelection();
			const rect = sel && sel.rangeCount ? sel.getRangeAt(0).getBoundingClientRect() : null;
			if (rect && (rect.width || rect.height)) {
				head = head ?? { left: rect.left, right: rect.left, top: rect.top, bottom: rect.bottom };
				tail = tail ?? { left: rect.right, right: rect.right, top: rect.top, bottom: rect.bottom };
			}
		}
		if (!head || !tail) {
			this.bubbleEl?.hide();
			return;
		}
		const el = this.ensureBubble();
		el.show();
		const w = el.offsetWidth || 320;
		let x = (head.left + tail.right) / 2 - w / 2;
		x = Math.max(8, Math.min(x, window.innerWidth - w - 8));
		let y = head.top - el.offsetHeight - 8;
		if (y < 48) y = tail.bottom + 8;
		el.style.left = x + "px";
		el.style.top = y + "px";
	}

	/* ---------------- emoji picker ---------------- */

	private emojiPopover: HTMLElement | null = null;
	private langPopover: HTMLElement | null = null;

	/** Searchable emoji popover under the toolbar button; recents float first. */
	private showEmojiPicker(ed: Editor, anchor: HTMLElement) {
		this.pickEmoji(anchor, (ch) => {
			ed.replaceSelection(ch);
			ed.focus();
		});
	}

	/** Click the emoji on a rendered callout title: pick a new one and write it
	 *  back, through the editor in Live Preview, through the file in Reading. */
	private swapCalloutEmoji(span: HTMLElement) {
		this.pickEmoji(span, (ch) => {
			const callout = span.closest(".callout") as HTMLElement | null;
			if (!callout) return;
			const src = span.closest(".markdown-source-view");
			if (src) {
				for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
					const view = leaf.view as MarkdownView;
					if (!view.containerEl.contains(span)) continue;
					const cm = this.cmOf(view);
					if (!cm) return;
					try {
						const ln = cm.state.doc.lineAt(cm.posAtDOM(callout));
						const next = setCalloutEmoji(ln.text, ch);
						if (next != null && next !== ln.text) {
							view.editor.transaction({
								changes: [{ from: { line: ln.number - 1, ch: 0 }, to: { line: ln.number - 1, ch: ln.text.length }, text: next }],
							});
						}
					} catch {
						new Notice("Power Editor: couldn't find that callout's header line.");
					}
					return;
				}
				return;
			}
			const lineNo = Number(callout.getAttribute("data-ped-line") ?? "-1");
			const path = callout.getAttribute("data-ped-path") ?? "";
			const file = path ? this.app.vault.getAbstractFileByPath(path) : null;
			if (lineNo < 0 || !(file instanceof TFile)) return;
			void this.app.vault.process(file, (data) => {
				const lines = data.split("\n");
				const next = lineNo < lines.length ? setCalloutEmoji(lines[lineNo], ch) : null;
				if (next != null) lines[lineNo] = next;
				return lines.join("\n");
			});
		});
	}

	private pickEmoji(anchor: HTMLElement, onPick: (ch: string) => void) {
		if (this.emojiPopover) {
			this.closeEmojiPicker();
			return;
		}
		const pop = createDiv({ cls: "ped-emoji" });
		document.body.appendChild(pop);
		this.emojiPopover = pop;
		const r = anchor.getBoundingClientRect();
		pop.style.left = Math.max(8, Math.min(r.left, window.innerWidth - 336)) + "px";
		pop.style.top = r.bottom + 6 + "px";
		const search = pop.createEl("input", { attr: { type: "text", placeholder: "Search emoji…", spellcheck: "false" } });
		const grid = pop.createDiv({ cls: "ped-emoji-grid" });
		const onDoc = (e: PointerEvent) => {
			if (!pop.contains(e.target as Node) && e.target !== anchor && !anchor.contains(e.target as Node)) {
				this.closeEmojiPicker();
			}
		};
		document.addEventListener("pointerdown", onDoc, true);
		this.register(() => this.closeEmojiPicker());
		pop.addEventListener("keydown", (e) => {
			if (e.key === "Escape") this.closeEmojiPicker();
		});
		(pop as HTMLElement & { pedCleanup?: () => void }).pedCleanup = () =>
			document.removeEventListener("pointerdown", onDoc, true);
		const insert = (ch: string) => {
			this.settings.recentEmoji = [ch, ...this.settings.recentEmoji.filter((c) => c !== ch)].slice(0, 16);
			void this.persistSettings();
			this.closeEmojiPicker();
			onPick(ch);
		};
		const mk = (ch: string, name: string) => {
			const b = grid.createEl("button", { text: ch, attr: { title: name, "aria-label": name } });
			b.addEventListener("pointerdown", (e) => {
				e.preventDefault();
				insert(ch);
			});
		};
		const render = (q: string) => {
			grid.empty();
			const ql = q.trim().toLowerCase();
			if (!ql && this.settings.recentEmoji.length) {
				for (const ch of this.settings.recentEmoji) mk(ch, "recently used");
			}
			let shown = 0;
			for (const [ch, name] of EMOJI) {
				if (ql && !name.includes(ql)) continue;
				if (!ql && this.settings.recentEmoji.includes(ch)) continue;
				mk(ch, name);
				if (++shown >= 160) break;
			}
		};
		search.addEventListener("input", () => render(search.value));
		render("");
		window.setTimeout(() => search.focus(), 0);
	}

	private closeEmojiPicker() {
		const pop = this.emojiPopover as (HTMLElement & { pedCleanup?: () => void }) | null;
		if (!pop) return;
		pop.pedCleanup?.();
		pop.remove();
		this.emojiPopover = null;
	}

	/* ---------------- callout picker ---------------- */

	/** Pick a callout flavor, or a collapsible toggle block. Each row carries
	 *  its emoji so the menu shows exactly what the callout will wear. */
	private showCalloutMenu(pick: (spec: CalloutSpec) => void, at?: { x: number; y: number }) {
		const menu = new Menu();
		for (const f of CALLOUT_FLAVORS) {
			menu.addItem((i) =>
				i
					.setTitle(`${f.emoji}  ${f.label}`)
					.setIcon(f.icon)
					.onClick(() => pick({ type: f.type, emoji: f.emoji }))
			);
		}
		menu.addSeparator();
		menu.addItem((i) =>
			i.setTitle("Toggle block (collapsible)").setIcon("chevron-right").onClick(() => pick({ type: "toggle", folded: true }))
		);
		menu.showAtPosition(at ?? this.cursorPoint());
	}

	pickCalloutAtCursor(ed: Editor, at?: { x: number; y: number }) {
		this.showCalloutMenu((spec) => this.turnCurrentInto(ed, "callout", spec), at ?? this.cursorPoint());
	}

	/** Turn the block at the cursor into one named flavor, skipping the picker
	 *  what the toolbar's flavor rows and the `/tip`-style slash items use. */
	calloutOfType(ed: Editor, type: string) {
		const f = CALLOUT_FLAVORS.find((x) => x.type === type);
		this.turnCurrentInto(ed, "callout", { type, emoji: f?.emoji });
	}

	/* ---------------- converting older notes ---------------- */

	/** Upgrade the "Tip:" lead-ins in the note under the cursor, in place and as
	 *  one undo step. Bare (unemphasized) labels only come along when asked,
	 *  because ordinary prose opens with a word and a colon too. */
	/** The paste-time tag escaping, run over a note that already has
	 *  placeholders sitting in it. Deliberately only the escaping: the rest of
	 *  postCleanMarkdown collapses blank runs and strips trailing spaces, which
	 *  in an existing note would quietly eat deliberate spacing and Markdown's
	 *  two-space line breaks. */
	escapeTagsInNote(ed: Editor) {
		const lines = ed.getValue().split("\n");
		const next = escapePlaceholderTags(lines.join("\n")).split("\n");
		const changed = next.filter((l, i) => l !== lines[i]).length;
		if (!changed) {
			new Notice("No placeholder tags to escape in this note.");
			return;
		}
		this.applyDoc(ed, lines, next, next.findIndex((l, i) => l !== lines[i]));
		new Notice(`Escaped placeholder tags on ${changed} line${changed === 1 ? "" : "s"}.`);
	}

	/** Scan every markdown file under `root` ("" is the whole vault) for
	 *  placeholders and hand the results to the preview modal. Nothing is
	 *  written here, a vault-wide rewrite gets looked at before it happens. */
	openPlaceholderSweep(root = "") {
		const prefix = root ? root.replace(/\/$/, "") + "/" : "";
		const files = this.app.vault.getMarkdownFiles().filter((f) => f.path.startsWith(prefix));
		new PlaceholderSweepModal(this, files, root).open();
	}

	/** Escape one file's placeholders. Returns how many landed. The count is
	 *  taken inside `process` from the same text the rewrite sees, so a note
	 *  edited between the scan and the run is reported as it actually was. */
	async escapeTagsInFile(file: TFile): Promise<number> {
		let found = 0;
		await this.app.vault.process(file, (cur) => {
			found = findPlaceholderTags(cur).length;
			return found ? escapePlaceholderTags(cur) : cur;
		});
		return found;
	}

	convertLeadsInNote(ed: Editor, bare: boolean) {
		const lines = ed.getValue().split("\n");
		const leads = findCalloutLeads(lines).filter((l) => bare || !l.bare);
		if (!leads.length) {
			new Notice("No Tip/Note/Warning lead-ins found in this note.");
			return;
		}
		this.applyDoc(ed, lines, convertCalloutLeads(lines, leads), leads[0].line);
		new Notice(`Converted ${leads.length} lead-in${leads.length === 1 ? "" : "s"} into callouts.`);
	}

	/** Scan every markdown file under `root` ("" is the whole vault) for lead-ins
	 *  and hand the results to the preview modal. Nothing is written here, the
	 *  modal is where a vault-wide rewrite gets looked at before it happens. */
	openCalloutConverter(root = "") {
		const prefix = root ? root.replace(/\/$/, "") + "/" : "";
		const files = this.app.vault.getMarkdownFiles().filter((f) => f.path.startsWith(prefix));
		new CalloutConvertModal(this, files, root).open();
	}

	/** Rewrite one file's lead-ins. Returns how many landed. */
	async convertLeadsInFile(file: TFile, bare: boolean): Promise<number> {
		const lines = (await this.app.vault.read(file)).split("\n");
		const leads = findCalloutLeads(lines).filter((l) => bare || !l.bare);
		if (!leads.length) return 0;
		await this.app.vault.modify(file, convertCalloutLeads(lines, leads).join("\n"));
		return leads.length;
	}

	private cursorPoint(): { x: number; y: number } {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		const cm = view ? this.cmOf(view) : null;
		const c = cm?.coordsAtPos(cm.state.selection.main.head);
		return c ? { x: c.left, y: c.bottom + 6 } : { x: window.innerWidth / 2 - 90, y: window.innerHeight / 3 };
	}

	/* ---------------- block menu ---------------- */

	private openBlockMenu(view: MarkdownView, range: BlockRange) {
		const ed = view.editor;
		// The grip already skips Power Assistant's transcript; guard here too so
		// the callout menu can never open over it from any other entry point.
		if (this.isTranscriptCallout(null, ed.getValue().split("\n"), range.from)) return;
		const menu = new Menu();
		const lines = () => ed.getValue().split("\n");
		const kinds: [string, BlockKind, string][] = [
			["Paragraph", "paragraph", "pilcrow"],
			["Heading 1", "h1", "heading-1"],
			["Heading 2", "h2", "heading-2"],
			["Heading 3", "h3", "heading-3"],
			["Bulleted list", "bullet", "list"],
			["Numbered list", "ordered", "list-ordered"],
			["Checklist", "task", "list-checks"],
			["Quote", "quote", "quote"],
			["Callout", "callout", "megaphone"],
			["Toggle list (Notion-style)", "toggleList", "chevron-down"],
		];
		menu.addItem((i: MenuItem) => {
			i.setTitle("Turn into").setIcon("replace");
			const sub = (i as unknown as { setSubmenu?: () => Menu }).setSubmenu?.();
			if (sub) {
				for (const [title, kind, icon] of kinds) {
					sub.addItem((s) =>
						s.setTitle(title).setIcon(icon).onClick(() => {
							if (kind === "callout") {
								this.showCalloutMenu((spec) => {
									const prev = lines();
									this.applyDoc(ed, prev, transformBlock(prev, range, "callout", spec), range.from);
								});
								return;
							}
							const prev = lines();
							this.applyDoc(ed, prev, transformBlock(prev, range, kind), range.from);
						})
					);
				}
			} else {
				i.onClick(() => new Notice("Turn into needs Obsidian 1.5+ submenus."));
			}
		});
		// Notion-style block color: text color or background across the block,
		// applied per line so headings/lists keep their markers.
		const colorBlock = (mode: "text" | "hl", hex: string | null) => {
			const prev = lines();
			const next = prev.map((l, idx) => (idx >= range.from && idx <= range.to ? colorBlockLine(l, mode, hex) : l));
			this.applyDoc(ed, prev, next, range.from);
		};
		menu.addItem((i: MenuItem) => {
			i.setTitle("Color").setIcon("palette");
			const sub = (i as unknown as { setSubmenu?: () => Menu }).setSubmenu?.();
			if (sub) {
				sub.addItem((s) =>
					s.setTitle("Default").setIcon("ban").onClick(() => {
						const prev = lines();
						const next = prev.map((l, idx) =>
							idx >= range.from && idx <= range.to ? colorBlockLine(colorBlockLine(l, "text", null), "hl", null) : l
						);
						this.applyDoc(ed, prev, next, range.from);
					})
				);
				for (const [name, hex] of TEXT_COLORS)
					sub.addItem((s) => s.setTitle(name).setIcon("baseline").onClick(() => colorBlock("text", hex)));
				sub.addSeparator();
				for (const [name, hex] of BG_COLORS)
					sub.addItem((s) => s.setTitle(`${name} background`).setIcon("paint-bucket").onClick(() => colorBlock("hl", hex)));
			} else {
				i.onClick(() => new Notice("Color needs Obsidian 1.5+ submenus."));
			}
		});
		menu.addSeparator();
		menu.addItem((i) =>
			i.setTitle("Duplicate").setIcon("copy").onClick(() => {
				const prev = lines();
				const res = duplicateBlock(prev, range);
				this.applyDoc(ed, prev, res.lines, res.newStart);
			})
		);
		menu.addItem((i) =>
			i.setTitle("Copy link to block").setIcon("link").onClick(async () => {
				const prev = lines();
				const id = "b" + Math.random().toString(36).slice(2, 8);
				const res = ensureBlockId(prev, range, id);
				if (res.changed) this.applyDoc(ed, prev, res.lines, range.from);
				const file = view.file as TFile | null;
				const name = file ? file.basename : "";
				await navigator.clipboard.writeText(`[[${name}#^${res.id}]]`);
				new Notice("Block link copied.");
			})
		);
		menu.addSeparator();
		menu.addItem((i) =>
			i.setTitle("Move to top").setIcon("arrow-up-to-line").onClick(() => {
				const prev = lines();
				const starts = blockStarts(prev);
				const res = starts.length ? moveBlock(prev, range, starts[0]) : null;
				if (res) this.applyDoc(ed, prev, res.lines, res.newStart, true);
			})
		);
		menu.addItem((i) =>
			i.setTitle("Move to bottom").setIcon("arrow-down-to-line").onClick(() => {
				const prev = lines();
				const res = moveBlock(prev, range, prev.length);
				if (res) this.applyDoc(ed, prev, res.lines, res.newStart, true);
			})
		);
		menu.addSeparator();
		menu.addItem((i) =>
			i.setTitle("Delete block").setIcon("trash-2").onClick(() => {
				const prev = lines();
				this.applyDoc(ed, prev, deleteBlock(prev, range), Math.max(0, range.from - 1));
			})
		);
		// The hover handle hides by the time the menu opens, zeroing its rect
		// and dumping the menu at the window corner, anchor on the block's
		// first visible glyph (robust when a heading's "#" is hidden), with a
		// still-visible handle winning when it has real bounds.
		let at = { x: 100, y: 100 };
		const cm = this.cmOf(view);
		try {
			const a = cm ? this.blockAnchor(cm, range.from) : null;
			if (a) at = { x: a.x, y: a.top + a.h + 4 };
		} catch {
			/* keep fallback */
		}
		const r = this.handleEl?.getBoundingClientRect();
		if (r && (r.left > 0 || r.top > 0)) at = { x: r.left + 8, y: r.bottom + 4 };
		menu.showAtPosition(at);
	}

	/* ---------------- image resize handles ---------------- */

	/** Free room in px on each side of the readable column in this pane. A
	 *  sized image may spend it to grow past the column while staying inside
	 *  the pane. 0 when the column already fills the pane (readable line
	 *  length off, phones, narrow splits). Content may safely overflow into
	 *  the scroller's own padding (scrollbars only appear past the padding
	 *  box), so the scroller's clientWidth is the honest ceiling. */
	private imageBleed(view: MarkdownView): number {
		const pad = 16; // air at the pane edge so grips and shadows stay visible
		const root = view.containerEl;
		const preview = view.getMode() === "preview";
		const scroller = root.querySelector(preview ? ".markdown-preview-view" : ".cm-scroller") as HTMLElement | null;
		const column = root.querySelector(preview ? ".markdown-preview-sizer" : ".cm-content") as HTMLElement | null;
		if (!scroller || !column) return 0;
		return Math.max(0, Math.floor((scroller.clientWidth - column.clientWidth) / 2) - pad);
	}

	/** Publish each pane's bleed as --ped-img-bleed for styles.css, which
	 *  lets img[width] grow past the readable column but never past the
	 *  pane. Unmeasured contexts (hover popovers, PDF export) default to 0
	 *  and keep the fit-to-column cap. */
	private updateImageBleed() {
		for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
			const view = leaf.view as MarkdownView;
			view.containerEl.style.setProperty("--ped-img-bleed", this.imageBleed(view) + "px");
		}
	}

	private ensureImgGrips(): HTMLElement[] {
		if (this.imgGrips.length) return this.imgGrips;
		// dir is the sign the horizontal drag delta applies to width: right-edge
		// corners grow with the pointer, left-edge corners grow against it.
		for (const c of IMG_CORNERS) {
			const g = document.body.createDiv({
				cls: `ped-imgrip ped-imgrip-${c.corner}`,
				attr: { "aria-label": "Drag to resize" },
			});
			g.dataset.corner = c.corner;
			g.style.cursor = c.cursor;
			g.addEventListener("pointerdown", (e) => this.beginImageDrag(e, c.dir, c.cursor));
			this.imgGrips.push(g);
		}
		return this.imgGrips;
	}

	private trackImageHover(e: PointerEvent) {
		if (this.imgDrag) return;
		const t = e.target as HTMLElement | null;
		if (t?.closest(".ped-imgrip")) return;
		const img = t instanceof HTMLImageElement && t.closest(".markdown-source-view") ? t : null;
		if (img) {
			this.imgHover = img;
			this.positionImgGrips(img);
			return;
		}
		if (this.imgHover) {
			const r = this.imgHover.getBoundingClientRect();
			const pad = 16; // handles sit at every corner now, so pad all sides evenly
			const near = e.clientX >= r.left - pad && e.clientX <= r.right + pad && e.clientY >= r.top - pad && e.clientY <= r.bottom + pad;
			if (!near) this.hideImgGrip();
		}
	}

	private positionImgGrips(img: HTMLImageElement) {
		const grips = this.ensureImgGrips();
		const r = img.getBoundingClientRect();
		const xy: Record<string, [number, number]> = {
			nw: [r.left - 7, r.top - 7],
			ne: [r.right - 7, r.top - 7],
			sw: [r.left - 7, r.bottom - 7],
			se: [r.right - 7, r.bottom - 7],
		};
		for (const g of grips) {
			const [x, y] = xy[g.dataset.corner ?? "se"];
			g.style.left = x + "px";
			g.style.top = y + "px";
			g.show();
		}
	}

	private hideImgGrip() {
		this.imgHover = null;
		for (const g of this.imgGrips) g.hide();
		this.imgBadge?.hide();
	}

	private beginImageDrag(e: PointerEvent, dir: 1 | -1, cursor: string) {
		const img = this.imgHover;
		if (!img) return;
		e.preventDefault();
		e.stopPropagation();
		const startW = img.getBoundingClientRect().width;
		this.imgDrag = { img, startW, startX: e.clientX, dir };
		document.body.addClass("ped-imgresizing");
		document.body.style.setProperty("--ped-resize-cursor", cursor);
		if (!this.imgBadge) this.imgBadge = document.body.createDiv({ cls: "ped-imgbadge" });
		const badge = this.imgBadge;
		// Clamp to the pane, not just the readable column: the column width
		// plus the measured bleed on both sides, matching what styles.css
		// will let the committed image render at.
		this.updateImageBleed();
		const host = img.closest(".markdown-source-view") as HTMLElement | null;
		const win = img.ownerDocument.defaultView ?? window;
		const bleed = host ? parseFloat(win.getComputedStyle(host).getPropertyValue("--ped-img-bleed")) || 0 : 0;
		const col = (img.closest(".cm-content") as HTMLElement | null)?.clientWidth;
		const max = Math.max(120, col != null ? col + 2 * bleed : 2000);
		const move = (ev: PointerEvent) => {
			const drag = this.imgDrag;
			if (!drag) return;
			const w = Math.round(Math.min(max, Math.max(40, startW + drag.dir * (ev.clientX - drag.startX))));
			img.style.width = w + "px";
			img.addClass("ped-img-resizing");
			// Mirror the stylesheet's centering live so the drag preview sits
			// where the committed image will land: overflow past the column
			// splits evenly, images inside the column stay put.
			if (col != null) img.style.marginLeft = Math.min(0, Math.max((col - w) / 2, -bleed)) + "px";
			this.positionImgGrips(img);
			const r = img.getBoundingClientRect();
			badge.setText(Math.round(r.width) + " px");
			badge.style.left = r.left + r.width / 2 - badge.offsetWidth / 2 + "px";
			badge.style.top = r.top - 26 + "px";
			badge.show();
		};
		const up = () => {
			document.removeEventListener("pointermove", move);
			document.removeEventListener("pointerup", up);
			document.body.removeClass("ped-imgresizing");
			document.body.style.removeProperty("--ped-resize-cursor");
			badge.hide();
			const w = Math.round(img.getBoundingClientRect().width);
			this.imgDrag = null;
			this.commitImageResize(img, w);
		};
		document.addEventListener("pointermove", move);
		document.addEventListener("pointerup", up);
	}

	/** The doc line holding this rendered image's embed, plus its view. */
	private embedLineOf(img: HTMLImageElement): { view: MarkdownView; lineNo: number; text: string; target: string } | null {
		const container = img.closest(".internal-embed") as HTMLElement | null;
		const target = container?.getAttribute("src") ?? img.getAttribute("src") ?? "";
		if (!target) return null;
		for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
			const view = leaf.view as MarkdownView;
			if (!view.containerEl.contains(img)) continue;
			const cm = this.cmOf(view);
			if (!cm) return null;
			try {
				const pos = cm.posAtDOM(container ?? img);
				const ln = cm.state.doc.lineAt(pos);
				return { view, lineNo: ln.number - 1, text: ln.text, target };
			} catch {
				return null;
			}
		}
		return null;
	}

	/** Re-resolve the image's line and rewrite it via `fn` (pure). */
	private editImageLine(img: HTMLImageElement, fn: (text: string, target: string) => string | null) {
		const info = this.embedLineOf(img);
		if (!info) {
			new Notice("Power Editor: couldn't find that image's embed.");
			return;
		}
		const next = fn(info.text, info.target);
		if (next == null) {
			new Notice("Power Editor: couldn't find that image's embed.");
			return;
		}
		if (next !== info.text) {
			info.view.editor.transaction({
				changes: [{ from: { line: info.lineNo, ch: 0 }, to: { line: info.lineNo, ch: info.text.length }, text: next }],
			});
		}
	}

	/** Write the dragged width back into the embed under the image. */
	private commitImageResize(img: HTMLImageElement, width: number) {
		this.editImageLine(img, (text, target) => resizeEmbed(text, target, width));
	}

	/* ---------------- image toolbar (click an image) ---------------- */

	private imgBar: HTMLElement | null = null;

	private closeImageBar() {
		this.imgBar?.remove();
		this.imgBar = null;
	}

	private showImageBar(img: HTMLImageElement) {
		this.closeImageBar();
		const info = this.embedLineOf(img);
		if (!info) return;
		const cur = embedInfo(info.text, info.target);
		const bar = document.body.createDiv({ cls: "ped-imgbar" });
		this.imgBar = bar;
		this.register(() => this.closeImageBar());
		const mk = (icon: string, tip: string, fn: () => void) => {
			const b = bar.createEl("button", { cls: "ped-btn", attr: { "aria-label": tip } });
			setIcon(b, icon);
			b.addEventListener("pointerdown", (e) => {
				e.preventDefault();
				e.stopPropagation();
				fn();
			});
			return b;
		};
		const alignTo = (dir: Align) => {
			const fresh = this.embedLineOf(img);
			if (!fresh) return;
			fresh.view.editor.setCursor({ line: fresh.lineNo, ch: 0 });
			this.applyAlign(fresh.view.editor, dir);
			this.closeImageBar();
		};
		mk("align-left", "Align image left", () => alignTo("left"));
		mk("align-center", "Align image center", () => alignTo("center"));
		mk("align-right", "Align image right", () => alignTo("right"));
		bar.createDiv({ cls: "ped-sep" });
		mk("ruler", "Size (presets or exact width)", () => {
			const menu = new Menu();
			const natural = img.naturalWidth || Math.round(img.getBoundingClientRect().width);
			menu.addItem((i) =>
				i.setTitle("Original size").onClick(() => {
					this.editImageLine(img, (t, tg) => editEmbed(t, tg, { width: null }));
					this.closeImageBar();
				})
			);
			for (const pct of [25, 50, 75]) {
				menu.addItem((i) =>
					i.setTitle(`${pct}% (${Math.round((natural * pct) / 100)}px)`).onClick(() => {
						this.editImageLine(img, (t, tg) => editEmbed(t, tg, { width: Math.round((natural * pct) / 100) }));
						this.closeImageBar();
					})
				);
			}
			menu.addItem((i) =>
				i.setTitle("Custom width…").onClick(() => {
					this.closeImageBar();
					new TextPromptModal(this.app, "Image width (pixels)", String(cur?.width ?? natural), (raw) => {
						const w = parseInt(raw, 10);
						if (!Number.isFinite(w) || w <= 0) return;
						this.editImageLine(img, (t, tg) => editEmbed(t, tg, { width: Math.round(w) }));
					}).open();
				})
			);
			const r = bar.getBoundingClientRect();
			menu.showAtPosition({ x: r.left, y: r.bottom + 4 });
		});
		mk("captions", "Alt / caption text", () => {
			this.closeImageBar();
			new TextPromptModal(this.app, "Alt / caption text (empty removes it)", cur?.alt ?? "", (raw) => {
				this.editImageLine(img, (t, tg) => editEmbed(t, tg, { alt: raw.trim() ? raw.trim() : null }));
			}).open();
		});
		bar.createDiv({ cls: "ped-sep" });
		mk("image", "Replace with another vault image", () => {
			this.closeImageBar();
			new ImageSuggestModal(this.app, (f) => {
				this.editImageLine(img, (t, tg) => {
					const kind = embedInfo(t, tg)?.kind ?? "wiki";
					const link = this.app.metadataCache.fileToLinktext(f, info.view.file?.path ?? "");
					return editEmbed(t, tg, { file: kind === "md" ? encodeURI(link) : link });
				});
			}).open();
		});
		mk("trash-2", "Remove image", () => {
			const fresh = this.embedLineOf(img);
			this.closeImageBar();
			if (!fresh) return;
			const next = removeEmbed(fresh.text, fresh.target);
			if (next == null) return;
			const ed = fresh.view.editor;
			if (!next.trim()) {
				const lastLine = ed.lineCount() - 1;
				const from = { line: fresh.lineNo, ch: 0 };
				const to = fresh.lineNo < lastLine ? { line: fresh.lineNo + 1, ch: 0 } : { line: fresh.lineNo, ch: fresh.text.length };
				ed.transaction({ changes: [{ from, to, text: "" }] });
			} else {
				ed.transaction({
					changes: [{ from: { line: fresh.lineNo, ch: 0 }, to: { line: fresh.lineNo, ch: fresh.text.length }, text: next }],
				});
			}
		});
		const r = img.getBoundingClientRect();
		const w = 258;
		bar.style.left = Math.max(8, Math.min(r.left + r.width / 2 - w / 2, window.innerWidth - w - 8)) + "px";
		bar.style.top = Math.max(8, (r.top > 60 ? r.top - 44 : r.bottom + 8)) + "px";
	}

	/* ---------------- active states ---------------- */

	private queueStateRefresh() {
		if (this.stateTimer) return;
		this.stateTimer = window.setTimeout(() => {
			this.stateTimer = null;
			this.refreshStates();
		}, 40);
	}

	/** Parity of a symmetric marker before the cursor tells whether we're inside it. */
	private inMark(line: string, ch: number, marker: string): boolean {
		let count = 0;
		let at = 0;
		while (true) {
			const i = line.indexOf(marker, at);
			if (i < 0 || i >= ch) break;
			count++;
			at = i + marker.length;
		}
		return count % 2 === 1;
	}

	private refreshStates() {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!view) return;
		const bar = this.bars.get(view);
		if (!bar || !bar.el.isConnected) return;
		const ed = view.editor;
		const cur = ed.getCursor();
		const line = ed.getLine(cur.line) ?? "";
		const set = (id: string, on: boolean) => {
			bar.buttons.get(id)?.toggleClass("is-active", on);
			this.bubbleButtons.get(id)?.toggleClass("is-active", on);
		};
		// prefer the real parse tree; fall back to marker parity when it's coy
		const marks = this.treeMarks(view) ?? {
			bold: this.inMark(line, cur.ch, "**"),
			italic: false,
			highlight: this.inMark(line, cur.ch, "=="),
			strike: this.inMark(line, cur.ch, "~~"),
			code: this.inMark(line, cur.ch, "`"),
		};
		// HTML emphasis (used inside highlights) is invisible to both the parse
		// tree and marker parity, so light the buttons from the tags directly
		set("bold", marks.bold || this.inHtmlTag(line, cur.ch, ["strong", "b"]));
		set("italic", marks.italic || this.inHtmlTag(line, cur.ch, ["em", "i"]));
		set("highlight", marks.highlight);
		set("strike", marks.strike);
		set("code", marks.code);
		const kind = listKind(line);
		set("bullet", kind === "bullet");
		set("ordered", kind === "ordered");
		set("task", kind === "task");
		set("quote", isQuote(line));
		const h = headingLevel(line);
		const hlabel = h ? "H" + h : "¶";
		bar.headingLabel.setText(hlabel);
		this.bubbleHeadingLabel?.setText(hlabel);
	}

	/** Inline-mark detection straight from CodeMirror's syntax tree, exact
	 *  where marker-counting can be fooled. Null when no tree is available. */
	private treeMarks(view: MarkdownView): { bold: boolean; italic: boolean; highlight: boolean; strike: boolean; code: boolean } | null {
		const cm = this.cmOf(view);
		if (!cm) return null;
		try {
			const pos = cm.state.selection.main.head;
			const tree = syntaxTree(cm.state);
			interface Node { name: string; parent: Node | null }
			let node = tree.resolveInner(pos, -1) as unknown as Node | null;
			const names: string[] = [];
			while (node) {
				names.push(node.name.toLowerCase());
				node = node.parent;
			}
			const all = names.join("|");
			if (!all || all === "document") return null;
			return {
				bold: all.includes("strong"),
				italic: /(^|[^a-z])em([^a-z]|$)|italic/.test(all),
				highlight: all.includes("highlight"),
				strike: all.includes("strikethrough"),
				code: all.includes("inline-code") || all.includes("inlinecode"),
			};
		} catch {
			return null;
		}
	}

	/* ---------------- block drag handles ---------------- */

	private cmOf(view: MarkdownView): CMView | null {
		return ((view.editor as unknown as { cm?: CMView }).cm as CMView | undefined) ?? null;
	}

	private docLines(cm: CMView, ed: Editor): string[] {
		if (this.linesCache?.doc === cm.state.doc) return this.linesCache.lines;
		const lines = ed.getValue().split("\n");
		this.linesCache = { doc: cm.state.doc, lines };
		return lines;
	}

	private ensureHandle(): HTMLElement {
		if (!this.handleEl) {
			this.handleEl = document.body.createDiv({ cls: "ped-handle", attr: { "aria-label": "Drag to move block" } });
			setIcon(this.handleEl, "grip-vertical");
			this.handleEl.addEventListener("pointerdown", (e) => this.startDrag(e));
		}
		return this.handleEl;
	}

	private ensureDrop(): HTMLElement {
		if (!this.dropEl) this.dropEl = document.body.createDiv({ cls: "ped-dropline" });
		return this.dropEl;
	}

	/** The block-widget element under `node`: the top-level child of .cm-content
	 *  that isn't a text line. Live Preview renders tables and .base / note
	 *  embeds as block widgets in place of their source lines, and posAtCoords
	 *  reads null over a widget's interior, so the grip has to be resolved
	 *  through the DOM instead. Null when the pointer is over real text or the
	 *  content's own padding. */
	private topWidgetAt(content: Element, node: EventTarget | null): HTMLElement | null {
		if (!(node instanceof Element) || node === content || !content.contains(node)) return null;
		if (node.closest(".cm-line")) return null;
		let w: HTMLElement | null = node as HTMLElement;
		while (w && w.parentElement !== content) w = w.parentElement;
		return w && w.parentElement === content ? w : null;
	}

	/** The rendered box of the block widget standing in for `lineNo`, found by
	 *  matching each non-line child of .cm-content back to its source position.
	 *  Lets the drop indicator land against a table or embed edge when
	 *  coordsAtPos collapses onto the widget's anchor. */
	private widgetRectForLine(cm: CMView, lineNo: number): DOMRect | null {
		for (const child of Array.from(cm.contentDOM.children)) {
			if (child.classList.contains("cm-line")) continue;
			try {
				if (cm.state.doc.lineAt(cm.posAtDOM(child)).number - 1 === lineNo) return child.getBoundingClientRect();
			} catch {
				/* a child CM can't map, skip it */
			}
		}
		return null;
	}

	/** Power Assistant owns the meeting transcript and its own speaker, avatar,
	 *  highlight and comment interactions. Recognize it so our block grip and
	 *  callout menu leave it alone instead of shadowing that UI. Two shapes exist:
	 *  the legacy purpose-built `[!transcript]` callout
	 *  (`.callout[data-callout="transcript"]` / `.pa-transcript`, source header
	 *  `> [!transcript]`), and the migrated plain speaker lines under a
	 *  `## Transcript` heading: each turn stamped `.cm-line.pa-lp-tr` in Live
	 *  Preview and matched in source by isTranscriptTurnAt. Detect either by the
	 *  rendered marker under the pointer or by the hovered source line. Narrow on
	 *  purpose: every other callout, and ordinary prose, keeps its affordances. */
	private isTranscriptCallout(target: EventTarget | null, lines: string[], lineNo: number): boolean {
		if (target instanceof Element && target.closest('.callout[data-callout="transcript"], .pa-transcript, .cm-line.pa-lp-tr')) return true;
		return isTranscriptCalloutAt(lines, lineNo) || isTranscriptTurnAt(lines, lineNo);
	}

	private onPointerMove(e: PointerEvent) {
		if (this.dragging) {
			this.dragMove(e);
			return;
		}
		if (!this.settings.blockHandles) return;
		const target = e.target as HTMLElement | null;
		if (target?.closest(".ped-handle")) return; // hovering the handle itself keeps it
		// keep the handle alive while the pointer travels the corridor between
		// the text and the grip, hiding here was why grabs kept failing
		if (this.handleEl && this.handleEl.isShown()) {
			const r = this.handleEl.getBoundingClientRect();
			if (e.clientX > r.left - 16 && e.clientX < r.right + 40 && e.clientY > r.top - 14 && e.clientY < r.bottom + 14) {
				return;
			}
		}
		const content = target?.closest?.(".cm-content");
		if (!content) {
			this.hideHandle();
			return;
		}
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!view || view.getMode() !== "source" || !view.containerEl.contains(content)) {
			this.hideHandle();
			return;
		}
		const cm = this.cmOf(view);
		if (!cm) return;
		// over a rendered table or embed, resolve the source line through the
		// widget's DOM and anchor to its box; over text, use the pointer coords
		const widget = this.topWidgetAt(content, e.target);
		let lineNo: number;
		let widgetRect: DOMRect | null = null;
		if (widget) {
			try {
				lineNo = cm.state.doc.lineAt(cm.posAtDOM(widget)).number - 1;
			} catch {
				this.hideHandle();
				return;
			}
			widgetRect = widget.getBoundingClientRect();
		} else {
			const pos = cm.posAtCoords({ x: e.clientX, y: e.clientY });
			if (pos == null) {
				this.hideHandle();
				return;
			}
			lineNo = cm.state.doc.lineAt(pos).number - 1;
		}
		const lines = this.docLines(cm, view.editor);
		const range = this.rangeFor(view.editor, lines, lineNo);
		if (!range) {
			this.hideHandle();
			return;
		}
		// Power Assistant's [!transcript] callout owns its own speaker/comment
		// interactions, don't shadow them with our grip (or the menu it opens).
		if (this.isTranscriptCallout(e.target, lines, lineNo)) {
			this.hideHandle();
			return;
		}
		this.hover = { view, cm, range };
		// tall embeds keep the grip near their top edge, not centered over the
		// whole block, so it stays reachable
		const a = widgetRect
			? { x: widgetRect.left, top: widgetRect.top, h: Math.min(widgetRect.height, 40) }
			: this.blockAnchor(cm, range.from);
		if (!a) {
			this.hideHandle();
			return;
		}
		const editorRect = (cm.dom as HTMLElement).getBoundingClientRect();
		const h = this.ensureHandle();
		h.style.left = Math.max(editorRect.left + 2, a.x - 30) + "px";
		h.style.top = a.top + Math.max(0, (a.h - 22) / 2) + "px";
		h.show();
	}

	private hideHandle() {
		this.hover = null;
		this.handleEl?.hide();
	}

	/** Screen anchor for a block's first line: x/top of its first VISIBLE glyph
	 *  and that glyph's height. Measuring the visible char (after any hidden
	 *  "# " marker) instead of line offset 0 is what makes the grip and the
	 *  block menu land correctly on headings, whose hash is display:none. */
	private blockAnchor(cm: CMView, lineIndex: number): { x: number; top: number; h: number } | null {
		const line = cm.state.doc.line(lineIndex + 1);
		const mk = line.text.match(/^\s*(?:>\s*)?#{1,6}\s+/);
		const visPos = Math.min(line.from + (mk ? mk[0].length : 0), line.to);
		const c = cm.coordsAtPos(visPos);
		if (c) return { x: c.left, top: c.top, h: c.bottom - c.top || 20 };
		const node = cm.domAtPos(line.from).node;
		const lineEl = (node instanceof Element ? node : node.parentElement)?.closest(".cm-line") as HTMLElement | null;
		if (!lineEl) return null;
		const lr = lineEl.getBoundingClientRect();
		return { x: lr.left, top: lr.top, h: lr.height || 20 };
	}

	private startDrag(e: PointerEvent) {
		if (!this.hover) return;
		e.preventDefault();
		(e.target as HTMLElement | null)?.setPointerCapture?.(e.pointerId);
		const { view, cm, range } = this.hover;
		const lines = this.docLines(cm, view.editor);
		this.dragging = { view, cm, range, starts: blockStarts(lines), target: null, startX: e.clientX, startY: e.clientY, moved: false };
		document.body.addClass("ped-dragging");
	}

	private dragMove(e: PointerEvent) {
		const d = this.dragging;
		if (!d) return;
		if (!d.moved && Math.abs(e.clientX - d.startX) < 4 && Math.abs(e.clientY - d.startY) < 4) return;
		d.moved = true;
		const scroller = d.cm.scrollDOM;
		const srect = scroller.getBoundingClientRect();
		// auto-scroll near the pane edges so long notes are reachable
		if (e.clientY < srect.top + 40) scroller.scrollTop -= 12;
		else if (e.clientY > srect.bottom - 40) scroller.scrollTop += 12;
		let lineNo: number;
		let hoverRect: DOMRect | null = null;
		const pos = d.cm.posAtCoords({ x: e.clientX, y: e.clientY });
		if (pos != null) {
			lineNo = d.cm.state.doc.lineAt(pos).number - 1;
		} else {
			// posAtCoords is null over a block widget; pointer capture routes the
			// event to the grip, so hit-test the drop point through the DOM
			const under = document.elementFromPoint(e.clientX, e.clientY);
			const widget = this.topWidgetAt(d.cm.contentDOM, under);
			if (!widget) return;
			try {
				lineNo = d.cm.state.doc.lineAt(d.cm.posAtDOM(widget)).number - 1;
			} catch {
				return;
			}
			hoverRect = widget.getBoundingClientRect();
		}
		const lines = this.docLines(d.cm, d.view.editor);
		// nearest boundary: before the hovered block, or after it when the
		// pointer is past its midpoint (which is the next start, or EOF).
		// A widget's rendered box gives the true midpoint, its source is one
		// line, so coordsAtPos would collapse top and bottom together.
		const r = blockRangeAt(lines, lineNo);
		let target: number;
		if (!r) {
			const after = d.starts.find((s) => s > lineNo);
			target = after ?? lines.length;
		} else {
			const topPos = d.cm.state.doc.line(r.from + 1).from;
			const botLine = d.cm.state.doc.line(Math.min(r.to + 1, d.cm.state.doc.lines));
			const top = hoverRect?.top ?? d.cm.coordsAtPos(topPos)?.top ?? e.clientY;
			const bottom = hoverRect?.bottom ?? d.cm.coordsAtPos(botLine.to)?.bottom ?? e.clientY;
			if (e.clientY < (top + bottom) / 2) target = r.from;
			else target = d.starts.find((s) => s > r.to) ?? lines.length;
		}
		d.target = target;
		const drop = this.ensureDrop();
		let y: number | null = null;
		if (target >= lines.length) {
			const lastLine = d.cm.state.doc.line(d.cm.state.doc.lines);
			y = d.cm.coordsAtPos(lastLine.to)?.bottom ?? this.widgetRectForLine(d.cm, lines.length - 1)?.bottom ?? null;
		} else {
			y = d.cm.coordsAtPos(d.cm.state.doc.line(target + 1).from)?.top ?? this.widgetRectForLine(d.cm, target)?.top ?? null;
		}
		if (y == null) {
			drop.hide();
			return;
		}
		const editorRect = (d.cm.dom as HTMLElement).getBoundingClientRect();
		drop.style.left = editorRect.left + 8 + "px";
		drop.style.width = editorRect.width - 24 + "px";
		drop.style.top = y - 1 + "px";
		drop.show();
	}

	/** Complete or cancel the drag; a null event cancels. */
	private endDrag(apply: { target: number } | null) {
		const d = this.dragging;
		this.dragging = null;
		document.body.removeClass("ped-dragging");
		this.dropEl?.hide();
		this.handleEl?.hide();
		this.hover = null;
		if (!d || !apply) return;
		const ed = d.view.editor;
		const lines = this.docLines(d.cm, ed);
		const res = moveBlock(lines, d.range, apply.target);
		if (!res) return;
		this.applyDoc(ed, lines, res.lines, res.newStart);
	}

	/* ---------------- move commands ---------------- */

	private moveBlockBy(ed: Editor, dir: -1 | 1) {
		const lines = ed.getValue().split("\n");
		const range = this.rangeFor(ed, lines, ed.getCursor().line);
		if (!range) return;
		const starts = blockStarts(lines).filter((s) => s <= range.from || s > range.to);
		const idx = starts.findIndex((s) => s === range.from);
		if (idx < 0) return;
		let target: number;
		if (dir === -1) {
			if (idx === 0) return;
			target = starts[idx - 1];
		} else {
			if (idx === starts.length - 1) return; // already the last block
			target = idx + 2 <= starts.length - 1 ? starts[idx + 2] : lines.length;
		}
		const res = moveBlock(lines, range, target);
		if (!res) return;
		this.applyDoc(ed, lines, res.lines, res.newStart, true);
	}
}

/** A document with a cursor: the whole surface the Link dialog needs, so it can
 *  be handed the note's editor or a table cell's without knowing which. */
interface CursorDoc {
	from: EditorPosition;
	to: EditorPosition;
	selection: string;
	line(n: number): string;
	replace(from: EditorPosition, to: EditorPosition, text: string): void;
}

/** The Link dialog: text to display, an address, or pick a note in the
 *  vault. Inserts a Markdown link or a [[wikilink]] and edits links in place. */
class LinkModal extends Modal {
	private text: string;
	private address: string;
	private picked: TFile | null = null;
	private pickedEl!: HTMLElement;
	private resultsEl!: HTMLElement;

	constructor(
		private plugin: PowerEditorPlugin,
		private doc: CursorDoc,
		private view: MarkdownView,
		private replaceFrom: EditorPosition,
		private replaceTo: EditorPosition,
		prefill: { text: string; address: string; noteQuery: string }
	) {
		super(plugin.app);
		this.text = prefill.text;
		this.address = prefill.address;
		this.noteQuery = prefill.noteQuery;
	}
	private noteQuery = "";

	onOpen() {
		this.titleEl.setText("Link");
		const c = this.contentEl;
		c.addClass("ped-linkmodal");
		this.floatify();
		let textInput: HTMLInputElement;
		new Setting(c).setName("Text to display").addText((t) => {
			textInput = t.inputEl;
			t.setValue(this.text).onChange((v) => (this.text = v));
			t.inputEl.addEventListener("keydown", (e) => {
				if (e.key === "Enter") this.insert();
			});
		});
		new Setting(c)
			.setName("Address")
			.setDesc("A web URL, or pick a note below instead.")
			.addText((t) => {
				t.setPlaceholder("https://…").setValue(this.address).onChange((v) => {
					this.address = v;
					if (v.trim() && this.picked) this.setPicked(null);
				});
				t.inputEl.addEventListener("keydown", (e) => {
					if (e.key === "Enter") this.insert();
				});
			});
		c.createDiv({ cls: "ped-label", text: "Or link to a note in your vault" });
		const search = c.createEl("input", {
			type: "text",
			cls: "ped-link-search",
			attr: { placeholder: "Search notes by name…" },
		});
		search.value = this.noteQuery;
		this.pickedEl = c.createDiv({ cls: "ped-link-picked" });
		this.resultsEl = c.createDiv({ cls: "ped-link-results" });
		search.addEventListener("input", () => this.populate(search.value));
		this.populate(this.noteQuery);
		this.renderPicked();
		const btns = c.createDiv({ cls: "ped-modal-btns" });
		btns.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.close());
		btns.createEl("button", { text: "Insert", cls: "mod-cta" }).addEventListener("click", () => this.insert());
		window.setTimeout(() => textInput.focus(), 20);
	}

	/** Make the dialog float: the page stays visible behind a barely-dimmed
	 *  overlay and the title bar drags the window around. */
	private floatify() {
		const bg = this.containerEl.querySelector<HTMLElement>(".modal-bg");
		if (bg) bg.addClass("ped-float-bg");
		const el = this.modalEl;
		const grip = this.titleEl;
		grip.addClass("ped-drag-grip");
		grip.addEventListener("pointerdown", (e: PointerEvent) => {
			if ((e.target as HTMLElement).closest(".modal-close-button")) return;
			const r = el.getBoundingClientRect();
			const ox = e.clientX - r.left;
			const oy = e.clientY - r.top;
			el.addClass("ped-floating");
			el.style.left = `${r.left}px`;
			el.style.top = `${r.top}px`;
			const move = (ev: PointerEvent) => {
				el.style.left = `${Math.max(8, Math.min(window.innerWidth - r.width - 8, ev.clientX - ox))}px`;
				el.style.top = `${Math.max(8, Math.min(window.innerHeight - 48, ev.clientY - oy))}px`;
			};
			const up = () => {
				document.removeEventListener("pointermove", move);
				document.removeEventListener("pointerup", up);
			};
			document.addEventListener("pointermove", move);
			document.addEventListener("pointerup", up);
			e.preventDefault();
		});
	}

	private populate(query: string) {
		this.resultsEl.empty();
		const q = query.trim().toLowerCase();
		let files = this.app.vault.getMarkdownFiles();
		if (q) files = files.filter((f) => f.basename.toLowerCase().includes(q) || f.path.toLowerCase().includes(q));
		files.sort((a, b) => {
			const as = a.basename.toLowerCase().startsWith(q) ? 0 : 1;
			const bs = b.basename.toLowerCase().startsWith(q) ? 0 : 1;
			return as - bs || b.stat.mtime - a.stat.mtime;
		});
		for (const f of files.slice(0, 50)) {
			const row = this.resultsEl.createDiv({ cls: "ped-link-row" + (this.picked === f ? " is-picked" : "") });
			row.createSpan({ cls: "ped-link-name", text: f.basename });
			if (f.parent && f.parent.path !== "/") row.createSpan({ cls: "ped-link-path", text: f.parent.path });
			row.addEventListener("click", () => {
				this.setPicked(f);
				this.populate(query);
			});
		}
		if (!this.resultsEl.childElementCount) this.resultsEl.createDiv({ cls: "ped-link-empty", text: "No notes match." });
	}

	private setPicked(f: TFile | null) {
		this.picked = f;
		if (f && !this.text.trim()) this.text = f.basename;
		this.renderPicked();
	}

	private renderPicked() {
		this.pickedEl.empty();
		if (!this.picked) return;
		this.pickedEl.createSpan({ text: "Linking to: " });
		this.pickedEl.createSpan({ cls: "ped-link-target", text: this.picked.basename });
		const clear = this.pickedEl.createEl("button", { text: "clear", cls: "ped-colorpop-btn" });
		clear.addEventListener("click", () => {
			this.setPicked(null);
			this.populate("");
		});
	}

	private insert() {
		let out: string;
		const display = this.text.trim();
		if (this.picked) {
			const linktext = this.app.metadataCache.fileToLinktext(this.picked, this.view.file?.path ?? "");
			out = display && display !== linktext ? `[[${linktext}|${display}]]` : `[[${linktext}]]`;
		} else {
			const addr = this.address.trim();
			if (!addr) {
				new Notice("Enter an address or pick a note.");
				return;
			}
			out = `[${display || addr}](${addr})`;
		}
		this.close();
		this.doc.replace(this.replaceFrom, this.replaceTo, out);
	}

	onClose() {
		this.contentEl.empty();
	}
}

interface SlashItem {
	title: string;
	icon: string;
	action: (ed: Editor, plugin: PowerEditorPlugin) => void;
}

/** Type "/" at the start of a line (or after a space) for the insert menu
 *  structure, snippets, and the rest of the Power family. */
class SlashSuggest extends EditorSuggest<SlashItem> {
	constructor(private plugin: PowerEditorPlugin) {
		super(plugin.app);
	}

	onTrigger(cursor: EditorPosition, editor: Editor): EditorSuggestTriggerInfo | null {
		const before = editor.getLine(cursor.line).slice(0, cursor.ch);
		const m = before.match(/(?:^|\s)\/([\w-]*)$/);
		if (!m) return null;
		const start = before.length - m[1].length - 1;
		return { start: { line: cursor.line, ch: start }, end: cursor, query: m[1] };
	}

	private items(): SlashItem[] {
		const kind = (title: string, icon: string, k: BlockKind): SlashItem => ({
			title,
			icon,
			action: (ed, plugin) => plugin.turnCurrentInto(ed, k),
		});
		const snippet = (title: string, icon: string, text: string, cursorUp = 0, ch = 0): SlashItem => ({
			title,
			icon,
			action: (ed, plugin) => {
				const cur = ed.getCursor();
				// the block may gain a line on the way in, and inside a list step
				// it gains an indent as well, so the caret is placed from what was
				// actually written rather than from what was asked for
				const written = plugin.insertBlockAt(ed, text, cur);
				const target = Math.max(0, written.length - 1 - cursorUp);
				ed.setCursor({ line: cur.line + target, ch: (target ? leadOf(written[target]) : cur.ch) + ch });
			},
		});
		const out: SlashItem[] = [
			kind("Heading 1", "heading-1", "h1"),
			kind("Heading 2", "heading-2", "h2"),
			kind("Heading 3", "heading-3", "h3"),
			kind("Bulleted list", "list", "bullet"),
			kind("Numbered list", "list-ordered", "ordered"),
			kind("Checklist", "list-checks", "task"),
			kind("Quote", "quote", "quote"),
			{ title: "Callout", icon: "megaphone", action: (ed, plugin) => plugin.pickCalloutAtCursor(ed) },
			// every flavor also stands on its own, so "/tip" lands a lightbulb
			// callout without a second menu to steer through
			...CALLOUT_FLAVORS.map(
				(f): SlashItem => ({
					title: `${f.label} callout`,
					icon: f.icon,
					action: (ed, plugin) => plugin.calloutOfType(ed, f.type),
				})
			),
			{ title: "Toggle block (collapsible)", icon: "chevron-right", action: (ed, plugin) => plugin.toggleBlock(ed) },
			{ title: "Toggle list (Notion-style)", icon: "chevron-down", action: (ed, plugin) => plugin.toggleListBlock(ed) },
			{ title: "Code block", icon: "code-square", action: (ed, plugin) => plugin.insertCodeBlock(ed) },
			{ title: "Code block language", icon: "code-square", action: (ed, plugin) => plugin.setCodeBlockLanguage(ed) },
			snippet("Table", "table", "|     |     |     |\n| --- | --- | --- |\n|     |     |     |", 2, 2),
			snippet("Tabs (Notion-style)", "panels-top-left", "```tabs\n--- Tab 1\n\n--- Tab 2\n\n```", 3, 0),
			{ title: "Columns (Notion-style)", icon: "columns-2", action: (ed, plugin) => plugin.insertColumnsMenu(ed) },
			{ title: "Add cover (Notion-style)", icon: "image", action: (_ed, plugin) => plugin.openCoverMenu() },
			{ title: "Page options (width, font)", icon: "layout", action: (_ed, plugin) => plugin.openPageOptions() },
			{ title: "Comment", icon: "message-circle", action: (ed, plugin) => plugin.addComment(ed) },
			snippet("To-do dashboard", "list-checks", "```todo\nnot done\ndue this week\n```", 1, 0),
			snippet("Table of contents", "list-tree", "```toc\n```", 1, 0),
			snippet("Horizontal rule", "minus", "---\n"),
			snippet("Today's date", "calendar", new Date().toISOString().slice(0, 10)),
		];
		out.push({ title: "Dictate (speech to text)", icon: "mic", action: (ed, plugin) => void plugin.toggleDictation(ed) });
		const family = (title: string, icon: string, commandId: string): SlashItem | null => {
			const commands = (this.app as unknown as { commands?: { commands?: Record<string, unknown> } }).commands?.commands;
			if (!commands || !commands[commandId]) return null;
			return {
				title,
				icon,
				action: (ed, plugin) =>
					(plugin.app as unknown as { commands: { executeCommandById(id: string): void } }).commands.executeCommandById(commandId),
			};
		};
		// Power Assistant was previously Power Capture: offer whichever id is
		// live, never both (the first resolvable command wins)
		const familyEither = (title: string, icon: string, ...ids: string[]): SlashItem | null => {
			for (const id of ids) {
				const it = family(title, icon, id);
				if (it) return it;
			}
			return null;
		};
		for (const it of [
			familyEither("Record a meeting (Power Assistant)", "mic", "powerassistant:toggle-recording", "powercapture:toggle-recording"),
			familyEither("Capture a YouTube video (Power Assistant)", "youtube", "powerassistant:capture-youtube", "powercapture:capture-youtube"),
			familyEither("Ask your vault (Power Assistant)", "sparkles", "powerassistant:ask-vault", "powercapture:ask-vault"),
			family("Insert totals row (Power Tables)", "sigma", "powertables:totals-row"),
			family("Embed a new base (Power Bases)", "database", "powerbases:insert-base-embed"),
			family("Open Recent Pages (Power Explorer)", "history", "powerexplorer:open-recent-pages"),
		]) {
			if (it) out.push(it);
		}
		return out;
	}

	getSuggestions(ctx: EditorSuggestContext): SlashItem[] {
		const q = ctx.query.toLowerCase();
		return this.items().filter((i) => i.title.toLowerCase().includes(q));
	}

	renderSuggestion(item: SlashItem, el: HTMLElement) {
		const row = el.createDiv({ cls: "ped-slash" });
		const ic = row.createSpan({ cls: "ped-slash-icon" });
		setIcon(ic, item.icon);
		row.createSpan({ text: item.title });
	}

	selectSuggestion(item: SlashItem) {
		const ctx = this.context;
		if (!ctx) return;
		ctx.editor.replaceRange("", ctx.start, ctx.end);
		item.action(ctx.editor, this.plugin);
	}
}

/** The vault-wide "Tip:" → callout upgrade, shown before it happens. Notes
 *  written before callouts existed carry their type as a bold lead-in; this
 *  scans for those, lists exactly which lines in which files would change, and
 *  only rewrites once you have looked at the list. */
class CalloutConvertModal extends Modal {
	private found = new Map<TFile, CalloutLead[]>();
	private bare = false;
	private scanning = true;
	private canceled = false;
	private listEl!: HTMLElement;
	private summaryEl!: HTMLElement;
	private go!: HTMLButtonElement;

	constructor(private plugin: PowerEditorPlugin, private files: TFile[], private root: string) {
		super(plugin.app);
	}

	onOpen() {
		this.titleEl.setText("Convert lead-ins into callouts");
		const where = this.root ? `“${this.root}”` : "your vault";
		this.contentEl.createEl("p", {
			cls: "ped-convert-intro",
			text: `Looks through ${where} for lines that open with a label (“Tip:”, “**Note:**”, “Warning:”) and turns each one into a real callout with its icon and color. The label itself goes, because the callout already says it.`,
		});
		new Setting(this.contentEl)
			.setName("Include labels without bold")
			.setDesc("Also convert plain “Note: …” lines. Less certain: ordinary prose can open with a word and a colon too, so check the list below before converting.")
			.addToggle((t) =>
				t.setValue(this.bare).onChange((v) => {
					this.bare = v;
					this.render();
				})
			);
		this.summaryEl = this.contentEl.createDiv({
			cls: "ped-convert-summary",
			text: `Scanning 0 of ${this.files.length.toLocaleString()} notes…`,
		});
		this.listEl = this.contentEl.createDiv({ cls: "ped-convert-list" });
		const btns = this.contentEl.createDiv({ cls: "ped-prompt-btns" });
		btns.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.close());
		this.go = btns.createEl("button", { text: "Convert", cls: "mod-cta" });
		this.go.disabled = true;
		this.go.addEventListener("click", () => void this.run());
		void this.scan();
	}

	/** Read in parallel chunks rather than one file at a time. A big vault is
	 *  thousands of notes, and awaiting each read in turn spends the whole scan
	 *  waiting on disk latency with nothing else in flight. Progress is reported
	 *  every chunk, so a long scan looks like a scan and not a hang. */
	private async scan() {
		const CHUNK = 64;
		for (let i = 0; i < this.files.length && !this.canceled; i += CHUNK) {
			const batch = this.files.slice(i, i + CHUNK);
			const reads = await Promise.all(
				batch.map(async (f): Promise<[TFile, CalloutLead[]]> => {
					try {
						return [f, findCalloutLeads((await this.app.vault.cachedRead(f)).split("\n"))];
					} catch {
						return [f, []]; // unreadable file: skip it, never fail the scan
					}
				})
			);
			for (const [f, leads] of reads) if (leads.length) this.found.set(f, leads);
			const done = Math.min(i + CHUNK, this.files.length);
			this.summaryEl.setText(`Scanning ${done.toLocaleString()} of ${this.files.length.toLocaleString()} notes…`);
		}
		if (this.canceled) return;
		this.scanning = false;
		this.render();
	}

	/** What the current toggle would actually change.
	 *
	 *  Named `pendingLeads`, not `selection`: Obsidian's Modal assigns a
	 *  `selection` property on the instance at runtime (it restores the
	 *  editor's selection on close), which silently shadows a method of that
	 *  name on the prototype. The failure is a "not a function" TypeError from
	 *  inside a promise, so it does not surface as a broken build. */
	private pendingLeads(): [TFile, CalloutLead[]][] {
		const out: [TFile, CalloutLead[]][] = [];
		for (const [file, leads] of this.found) {
			const keep = leads.filter((l) => this.bare || !l.bare);
			if (keep.length) out.push([file, keep]);
		}
		return out.sort((a, b) => a[0].path.localeCompare(b[0].path));
	}

	private render() {
		if (this.scanning) return; // the progress line owns the summary until the scan lands
		const sel = this.pendingLeads();
		const lines = sel.reduce((n, [, l]) => n + l.length, 0);
		this.go.disabled = lines === 0;
		this.go.setText(lines ? `Convert ${lines}` : "Convert");
		const byType = new Map<string, number>();
		for (const [, leads] of sel) for (const l of leads) byType.set(l.type, (byType.get(l.type) ?? 0) + 1);
		const breakdown = [...byType.entries()]
			.sort((a, b) => b[1] - a[1])
			.map(([t, n]) => `${CALLOUT_FLAVORS.find((f) => f.type === t)?.emoji ?? ""} ${n} ${t}`)
			.join(" · ");
		this.summaryEl.setText(
			lines
				? `${lines} lead-in${lines === 1 ? "" : "s"} in ${sel.length} note${sel.length === 1 ? "" : "s"}${breakdown ? ` (${breakdown})` : ""}`
				: "Nothing to convert."
		);
		this.listEl.empty();
		for (const [file, leads] of sel) {
			const group = this.listEl.createDiv({ cls: "ped-convert-file" });
			group.createDiv({ cls: "ped-convert-path", text: file.path });
			for (const l of leads) {
				const row = group.createDiv({ cls: "ped-convert-row" });
				row.createSpan({ cls: "ped-convert-emoji", text: CALLOUT_FLAVORS.find((f) => f.type === l.type)?.emoji ?? "" });
				row.createSpan({ cls: "ped-convert-line", text: `line ${l.line + 1}: ${l.label}` });
			}
		}
	}

	private async run() {
		const sel = this.pendingLeads();
		this.go.disabled = true;
		this.go.setText("Converting…");
		let files = 0;
		let lines = 0;
		for (const [file] of sel) {
			const n = await this.plugin.convertLeadsInFile(file, this.bare);
			if (n) {
				files++;
				lines += n;
			}
		}
		this.close();
		new Notice(`Converted ${lines} lead-in${lines === 1 ? "" : "s"} into callouts across ${files} note${files === 1 ? "" : "s"}.`);
	}

	onClose() {
		this.canceled = true; // a scan still in flight stops reading the vault
		this.contentEl.empty();
	}
}

/** The vault-wide placeholder sweep. Deliberately the same shape as the
 *  callout converter, chunked scan, a list you read before anything is
 *  written, counts on the button, and it borrows that modal's CSS rather
 *  than growing a second set of classes that look the same. */
class PlaceholderSweepModal extends Modal {
	private found = new Map<TFile, PlaceholderTag[]>();
	private scanning = true;
	private canceled = false;
	private listEl!: HTMLElement;
	private summaryEl!: HTMLElement;
	private go!: HTMLButtonElement;

	constructor(private plugin: PowerEditorPlugin, private files: TFile[], private root: string) {
		super(plugin.app);
	}

	onOpen() {
		this.titleEl.setText("Escape placeholder tags");
		const where = this.root ? `“${this.root}”` : "your vault";
		this.contentEl.createEl("p", {
			cls: "ped-convert-intro",
			text: `Looks through ${where} for angle-bracket placeholders like <AppFeature>. Obsidian reads one of those as an HTML tag that never closes, and from there Live Preview stops rendering Markdown for the rest of the note, headings, bold and links below it all come out as raw source. Escaping leaves the text reading exactly as written and gets the rendering back. Real HTML and anything inside code is left alone.`,
		});
		this.summaryEl = this.contentEl.createDiv({
			cls: "ped-convert-summary",
			text: `Scanning 0 of ${this.files.length.toLocaleString()} notes…`,
		});
		this.listEl = this.contentEl.createDiv({ cls: "ped-convert-list" });
		const btns = this.contentEl.createDiv({ cls: "ped-prompt-btns" });
		btns.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.close());
		this.go = btns.createEl("button", { text: "Escape", cls: "mod-cta" });
		this.go.disabled = true;
		this.go.addEventListener("click", () => void this.run());
		void this.scan();
	}

	/** Read in parallel chunks rather than one file at a time, for the same
	 *  reason the callout scan does: a big vault is thousands of notes, and
	 *  awaiting each read in turn spends the scan waiting on disk latency. */
	private async scan() {
		const CHUNK = 64;
		for (let i = 0; i < this.files.length && !this.canceled; i += CHUNK) {
			const batch = this.files.slice(i, i + CHUNK);
			const reads = await Promise.all(
				batch.map(async (f): Promise<[TFile, PlaceholderTag[]]> => {
					try {
						return [f, findPlaceholderTags(await this.app.vault.cachedRead(f))];
					} catch {
						return [f, []]; // unreadable file: skip it, never fail the scan
					}
				})
			);
			for (const [f, tags] of reads) if (tags.length) this.found.set(f, tags);
			const done = Math.min(i + CHUNK, this.files.length);
			this.summaryEl.setText(`Scanning ${done.toLocaleString()} of ${this.files.length.toLocaleString()} notes…`);
		}
		if (this.canceled) return;
		this.scanning = false;
		this.render();
	}

	/** Named `pendingTags`, not `selection`, for the reason spelled out on the
	 *  callout modal: Obsidian's Modal assigns a `selection` property at
	 *  runtime, which would silently shadow a method of that name. */
	private pendingTags(): [TFile, PlaceholderTag[]][] {
		return [...this.found].sort((a, b) => a[0].path.localeCompare(b[0].path));
	}

	private render() {
		if (this.scanning) return; // the progress line owns the summary until the scan lands
		const sel = this.pendingTags();
		const total = sel.reduce((n, [, tags]) => n + tags.length, 0);
		this.go.disabled = total === 0;
		this.go.setText(total ? `Escape ${total}` : "Escape");
		const byTag = new Map<string, number>();
		for (const [, tags] of sel) for (const t of tags) byTag.set(t.tag, (byTag.get(t.tag) ?? 0) + 1);
		const breakdown = [...byTag.entries()]
			.sort((a, b) => b[1] - a[1])
			.slice(0, 4)
			.map(([tag, n]) => `${n}× ${tag}`)
			.join(" · ");
		this.summaryEl.setText(
			total
				? `${total} placeholder${total === 1 ? "" : "s"} in ${sel.length} note${sel.length === 1 ? "" : "s"}${breakdown ? ` (${breakdown}${byTag.size > 4 ? " …" : ""})` : ""}`
				: "Nothing to escape."
		);
		this.listEl.empty();
		for (const [file, tags] of sel) {
			const group = this.listEl.createDiv({ cls: "ped-convert-file" });
			group.createDiv({ cls: "ped-convert-path", text: file.path });
			for (const t of tags) {
				const row = group.createDiv({ cls: "ped-convert-row" });
				row.createSpan({ cls: "ped-convert-line", text: `line ${t.line + 1}: ${t.tag}` });
			}
		}
	}

	private async run() {
		const sel = this.pendingTags();
		this.go.disabled = true;
		this.go.setText("Escaping…");
		let files = 0;
		let tags = 0;
		for (const [file] of sel) {
			const n = await this.plugin.escapeTagsInFile(file);
			if (n) {
				files++;
				tags += n;
			}
		}
		this.close();
		new Notice(`Escaped ${tags} placeholder${tags === 1 ? "" : "s"} across ${files} note${files === 1 ? "" : "s"}.`);
	}

	onClose() {
		this.canceled = true; // a scan still in flight stops reading the vault
		this.contentEl.empty();
	}
}

/** One row of the settings tab. `build` is handed a Setting whose name and
 *  description are already set, so it only adds the controls. Rows are data
 *  rather than drawing code so the two renderers cannot disagree about what
 *  the tab holds. */
type Row = { name: string; desc?: string; help?: string; aliases?: string[]; build?: (st: Setting) => void | (() => void) };

/** A run of rows under one heading. A tab with more than one becomes a page
 *  of headed groups on 1.13, and one section div each in the fallback. */
type Group = { heading?: string; help?: string; rows: Row[] };

/** One tab: a native settings page on Obsidian 1.13 and up, a tab button in
 *  the fallback renderer for older builds. */
type Page = { id: string; label: string; groups: Group[] };

class PowerEditorSettingTab extends PluginSettingTab {
	constructor(private plugin: PowerEditorPlugin) {
		super(plugin.app, plugin);
	}

	/** Which settings tab is showing; kept across re-renders. */
	private activeTab = "toolbar";
	/** Current search filter; when set, matching settings show across all tabs. */
	private query = "";
	/** The one open help popover, if any, and the icon it hangs from. */
	private helpEl: HTMLElement | null = null;
	private helpAnchor: HTMLElement | null = null;
	private helpPinned = false;
	private helpCleanup: (() => void) | null = null;
	/** The button list redraws itself in place, so it keeps a handle on its own
	 *  container and on the row a drag started from. */
	private orderList: HTMLElement | null = null;
	private dragFrom: number | null = null;

	hide() {
		this.closeHelp();
	}

	private closeHelp() {
		this.helpCleanup?.();
		this.helpCleanup = null;
		this.helpEl?.remove();
		this.helpEl = null;
		this.helpAnchor = null;
		this.helpPinned = false;
	}

	/** Show the help popover for `icon`: a soft theme-colored card rather than
	 *  the native black tooltip. Opens on hover; a click pins it so it survives
	 *  the pointer leaving; Esc, a click elsewhere, or scrolling closes it. */
	private openHelp(icon: HTMLElement, text: string, pin: boolean) {
		if (this.helpAnchor === icon && this.helpEl) {
			if (pin) this.helpPinned = true;
			return;
		}
		this.closeHelp();
		const el = document.body.createDiv({ cls: "ped-help-pop", text });
		this.helpEl = el;
		this.helpAnchor = icon;
		this.helpPinned = pin;
		const r = icon.getBoundingClientRect();
		el.style.left = Math.max(8, Math.min(r.left - 12, window.innerWidth - el.offsetWidth - 8)) + "px";
		const below = r.bottom + 8;
		el.style.top = (below + el.offsetHeight > window.innerHeight - 8 ? r.top - el.offsetHeight - 8 : below) + "px";
		const onDocDown = (e: MouseEvent) => {
			if (e.target instanceof Node && (el.contains(e.target) || icon.contains(e.target))) return;
			this.closeHelp();
		};
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") this.closeHelp();
		};
		const onScroll = () => this.closeHelp();
		document.addEventListener("pointerdown", onDocDown, true);
		document.addEventListener("keydown", onKey, true);
		document.addEventListener("scroll", onScroll, true);
		this.helpCleanup = () => {
			document.removeEventListener("pointerdown", onDocDown, true);
			document.removeEventListener("keydown", onKey, true);
			document.removeEventListener("scroll", onScroll, true);
		};
	}

	/** Redraw when the rows themselves change: an AI action added, the outline
	 *  levels appearing. Obsidian 1.13 rebuilds the tab from
	 *  getSettingDefinitions(); older builds have only the fallback renderer. */
	private refresh() {
		this.closeHelp(); // whatever the popover is anchored to is about to go
		// update() arrived with the declarative API in 1.13 and minAppVersion is
		// still 1.7.2, so it is reached through a cast rather than named outright:
		// an older build has no definitions to rebuild from and redraws instead.
		const tab = this as unknown as { update?: () => void };
		if (tab.update) tab.update();
		else this.renderFallback();
	}

	/** Hover shows the popover, a click pins it open so the one-line desc stays
	 *  scannable. No aria-label on the icon, or Obsidian's native black tooltip
	 *  doubles up with it. */
	private wireHelp(ic: HTMLElement, text: string) {
		ic.addEventListener("mouseenter", () => this.openHelp(ic, text, false));
		ic.addEventListener("mouseleave", () => {
			if (!this.helpPinned && this.helpAnchor === ic) this.closeHelp();
		});
		ic.addEventListener("click", (e) => {
			e.preventDefault();
			e.stopPropagation();
			if (this.helpPinned && this.helpAnchor === ic) this.closeHelp();
			else this.openHelp(ic, text, true);
		});
	}

	/** The help icon that follows a setting's name. */
	private addHelp(st: Setting, text: string) {
		const ic = st.nameEl.createSpan({ cls: "ped-setting-help" });
		setIcon(ic, "help-circle");
		this.wireHelp(ic, text);
	}

	/** Obsidian 1.13 and up builds the tab from these and never calls display():
	 *  one native page per tab, standing in for the tab bar the fallback draws
	 *  for older builds. A tab holding more than one section becomes a page of
	 *  headed groups, which is what the headings were doing by hand.
	 *
	 *  Every row renders itself rather than declaring a `control`. A declarative
	 *  control writes through Obsidian's generic setControlValue, which would
	 *  bypass persistSettings and overwrite whatever another device changed. */
	getSettingDefinitions(): SettingDefinitionItem[] {
		const pages = this.buildPages();
		const rowsOf = new Map(pages.map((p) => [p.label, p.groups.flatMap((g) => g.rows)] as const));
		return [
			{
				name: "",
				searchable: false, // it is a masthead, not a setting
				render: (st) => {
					st.settingEl.empty();
					this.renderAbout(st.settingEl);
				},
			},
			{
				type: "group",
				search: {
					placeholder: "Search settings...",
					// the entries here are whole tabs, so a tab stays up when anything
					// inside it matches. Obsidian's own search box, top left, reaches
					// the individual settings.
					match: (def, query) => {
						const q = query.trim().toLowerCase();
						if (!q) return true;
						const has = (v: string | undefined) => (v ?? "").toLowerCase().includes(q);
						return (rowsOf.get(def.name) ?? []).some(
							(r) => has(r.name) || has(r.desc) || (r.aliases ?? []).some(has)
						);
					},
				},
				items: pages.map(
					(p): SettingDefinitionPage => ({
						type: "page",
						name: p.label,
						// a lone unnamed section is the page itself, so it stays flat
						items:
							p.groups.length === 1 && !p.groups[0].heading
								? p.groups[0].rows.map((r) => this.toDefinition(r, p.label))
								: p.groups.map((g) => ({
										type: "group" as const,
										heading: g.heading,
										// the section's own help note, on the header rather
										// than on any one row beneath it
										extraButtons: g.help
											? [
													(b: ExtraButtonComponent) => {
														b.setIcon("help-circle");
														this.wireHelp(b.extraSettingsEl, g.help ?? "");
													},
												]
											: undefined,
										items: g.rows.map((r) => this.toDefinition(r, p.label)),
									})),
					})
				),
			},
		];
	}

	/** One row as a definition Obsidian can draw. The name and description are
	 *  its to render and it rebuilds both on a redraw, so a row only hands back
	 *  what it hung on the row element itself. */
	private toDefinition(r: Row, page: string): SettingDefinitionRender {
		return {
			name: r.name,
			desc: r.desc,
			// searching the tab name still finds its rows, the way a heading match
			// opened the whole section in the tab bar
			aliases: [...(r.aliases ?? []), page],
			render: (st) => {
				const teardown = r.build?.(st);
				if (r.help) this.addHelp(st, r.help);
				return teardown;
			},
		};
	}

	/** What this plugin is and which build is running, above the section list.
	 *  Read off the manifest so it cannot drift from the released version. */
	private renderAbout(el: HTMLElement) {
		el.addClass("ped-about");
		const head = el.createDiv({ cls: "ped-about-head" });
		head.createSpan({ cls: "ped-about-name", text: this.plugin.manifest.name });
		head.createSpan({ cls: "ped-about-version", text: "v" + this.plugin.manifest.version });
		el.createDiv({ cls: "ped-about-desc", text: this.plugin.manifest.description });
	}

	/** The pre-1.13 renderer: every section on one page, with a tab bar and a
	 *  search box of our own because there was no declarative API to hand the
	 *  work to. Obsidian 1.13 and up ignores this and renders the definitions
	 *  above instead, so the two only ever differ in how they draw, never in
	 *  what they draw. */
	display() {
		this.renderFallback();
	}

	private renderFallback() {
		const root = this.containerEl;
		root.empty();
		this.closeHelp(); // a re-render orphans any popover anchored to the old DOM

		const pages = this.buildPages();
		if (!pages.some((p) => p.id === this.activeTab)) this.activeTab = pages[0].id;

		// the same masthead the declarative tab shows, minus the setting-item
		// wrapper it gets there
		this.renderAbout(root.createDiv({ cls: "ped-about-standalone" }));

		const searchWrap = root.createDiv({ cls: "ped-settings-search" });
		const searchInput = searchWrap.createEl("input", { cls: "ped-settings-search-input" });
		searchInput.type = "search";
		searchInput.placeholder = "Search settings...";
		searchInput.value = this.query;

		const tabBar = root.createDiv({ cls: "ped-settings-tabs" });
		const body = root.createDiv({ cls: "ped-settings-body" });

		// one section div per group, tagged with its tab so the tab bar and the
		// search box below can show and hide whole sections at a time
		for (const p of pages) {
			for (const g of p.groups) {
				const sec = body.createDiv({ cls: "ped-settings-section" });
				sec.dataset.tab = p.id;
				sec.dataset.name = (g.heading ?? p.label).toLowerCase();
				const h = new Setting(sec).setName(g.heading ?? p.label).setHeading();
				if (g.help) this.addHelp(h, g.help);
				// name and description first, then the row's own content: the same
				// order Obsidian applies a definition in, so a row that appends to
				// either element lands in the same place under both renderers
				for (const r of g.rows) {
					const st = new Setting(sec).setName(r.name);
					if (r.desc) st.setDesc(r.desc);
					if (r.aliases?.length) st.settingEl.dataset.pedAlias = r.aliases.join(" ").toLowerCase();
					r.build?.(st);
					if (r.help) this.addHelp(st, r.help);
				}
			}
		}

		// search filters across every tab; picking a tab shows just its sections
		const setVisible = (el: HTMLElement, v: boolean) => (el.style.display = v ? "" : "none");
		const applyView = () => {
			const q = this.query.trim().toLowerCase();
			setVisible(tabBar, !q);
			for (const sec of Array.from(body.children) as HTMLElement[]) {
				const items = Array.from(sec.querySelectorAll(":scope > .setting-item:not(.setting-item-heading)")) as HTMLElement[];
				if (!q) {
					for (const it of items) setVisible(it, true);
					setVisible(sec, sec.dataset.tab === this.activeTab);
					continue;
				}
				// a heading-name match reveals the whole section; otherwise match each row
				const nameHit = (sec.dataset.name ?? "").includes(q);
				let anyHit = false;
				for (const it of items) {
					const name = it.querySelector(".setting-item-name")?.textContent?.toLowerCase() ?? "";
					const desc = it.querySelector(".setting-item-description")?.textContent?.toLowerCase() ?? "";
					const hit = nameHit || name.includes(q) || desc.includes(q) || (it.dataset.pedAlias ?? "").includes(q);
					setVisible(it, hit);
					if (hit) anyHit = true;
				}
				setVisible(sec, anyHit);
			}
		};

		for (const p of pages) {
			const btn = tabBar.createEl("button", { text: p.label, cls: "ped-settings-tab" });
			btn.toggleClass("is-active", p.id === this.activeTab);
			btn.onclick = () => {
				if (this.activeTab === p.id) return;
				this.activeTab = p.id;
				for (const other of Array.from(tabBar.children) as HTMLElement[]) other.toggleClass("is-active", other === btn);
				applyView();
			};
		}

		searchInput.addEventListener("input", () => {
			this.query = searchInput.value;
			applyView();
		});

		applyView();
	}

	/** Every row of the settings tab, in order, as plain data: the one source
	 *  both renderers draw from, so they cannot drift apart. Built fresh on each
	 *  render because some sections depend on current settings. */
	private buildPages(): Page[] {
		// through persistSettings, never saveData: a whole-object write reverts
		// whatever another device changed since this one loaded
		const save = () => void this.plugin.persistSettings();
		const s = this.plugin.settings;

		const toolbar: Row[] = [
			{
				name: "Formatting toolbar",
				desc: "A rich formatting toolbar at the top of every note in editing view.",
				help: "The toolbar sits above the note in editing and Live Preview, and hides itself in Reading view. Pick which tools it shows on the Buttons list below.",
				build: (st) => {
					st.addToggle((t) =>
						t.setValue(s.showToolbar).onChange((v) => ((s.showToolbar = v), save(), this.plugin.rebuildToolbars()))
					);
				},
			},
			{
				name: "Show on phones and tablets",
				desc: "Obsidian mobile has its own toolbar, so this is off by default.",
				help: "Leave this off to keep Obsidian's built-in mobile toolbar. Turn it on when you want the full formatting row on a tablet with room to spare.",
				build: (st) => {
					st.addToggle((t) =>
						t.setValue(s.showOnMobile).onChange((v) => ((s.showOnMobile = v), save(), this.plugin.rebuildToolbars()))
					);
				},
			},
			{
				name: "Quick-capture mobile toolbar",
				desc: "Replace the commands on Obsidian's above-keyboard mobile toolbar with a note-taking set: photo, dictate, to-do, bullet and numbered lists, indents, bold, and hide keyboard. Turning this off restores your previous arrangement.",
				help: "This changes the row just above the phone keyboard, not the main toolbar. Your original arrangement is saved and comes straight back when you turn this off.",
				build: (st) => {
					st.addToggle((t) =>
						t.setValue(s.onenoteMobileToolbar).onChange((v) => {
							s.onenoteMobileToolbar = v;
							save();
							this.plugin.applyMobileToolbar();
						})
					);
				},
			},
		];

		const buttons: Row[] = [
			{
				name: "Arrange",
				desc: "Drag a button by its grip to reorder it (or focus a grip and use the arrow keys). Add a divider, or go back to the original layout.",
				build: (st) => {
					st.addButton((b) =>
						b
							.setButtonText("Add divider")
							.setTooltip("Adds a divider at the end; move it where you want it")
							.onClick(() => {
								s.buttonOrder = [...this.plugin.orderedButtonIds(), "|"];
								save();
								this.plugin.rebuildToolbars();
								this.redrawButtonOrder();
							})
					);
					st.addButton((b) =>
						b.setButtonText("Reset order").onClick(() => {
							s.buttonOrder = [];
							save();
							this.plugin.rebuildToolbars();
							this.redrawButtonOrder();
						})
					);
				},
			},
			{
				// The list owns a container of its own rather than being one row per
				// button, because moving a button is a rapid, repeated action: the
				// rows redraw themselves without redrawing the tab, which would throw
				// you back to the top of the page on every click.
				name: "",
				aliases: ["buttons", "order", "divider", "arrange"],
				build: (st) => {
					st.settingEl.empty();
					st.settingEl.addClass("ped-order-host");
					this.orderList = st.settingEl.createDiv({ cls: "ped-order-list" });
					this.redrawButtonOrder();
					return () => {
						this.orderList = null;
					};
				},
			},
		];

		const editing: Row[] = [
			{
				name: "Selection bubble",
				desc: "A compact formatting bubble appears right at your selection (the fastest way to format).",
				help: "Select text and a small toolbar floats next to it, so you do not have to reach for the top bar. It follows the selection and vanishes when you click away.",
				build: (st) => {
					st.addToggle((t) => t.setValue(s.showBubble).onChange((v) => ((s.showBubble = v), save())));
				},
			},
			{
				name: "Block drag handles",
				desc: "Hover a block for a grip: drag it to move the block, click it for the block menu (turn into, duplicate, copy link, delete…).",
				help: "The grip shows in the left margin when you hover a paragraph, list, table, or embed. Drag it to reorder, or click it for turn-into, duplicate, copy link, and delete.",
				build: (st) => {
					st.addToggle((t) => t.setValue(s.blockHandles).onChange((v) => ((s.blockHandles = v), save())));
				},
			},
			{
				name: "Headings move their section",
				desc: "Dragging a heading takes everything beneath it (until the next heading of the same level). Turn off to move heading lines alone.",
				help: "On, a heading's grip carries its whole section as one block. Off, it moves just the heading line and leaves the body where it is.",
				build: (st) => {
					st.addToggle((t) => t.setValue(s.headingSections).onChange((v) => ((s.headingSections = v), save())));
				},
			},
			{
				name: "Hide formatting characters (WYSIWYG)",
				desc: "Live Preview normally reveals ** and == while the cursor is inside formatted text. This keeps them hidden for a clean look; the markers still exist in the file, you just never see them.",
				help: "Keeps markers like ** and == out of sight even while you edit that line, so text always looks finished. The markers stay in the file, so the Markdown never changes. This is also what renders bold and italics inside a highlight.",
				build: (st) => {
					st.addToggle((t) =>
						t.setValue(s.wysiwygMarks).onChange((v) => {
							s.wysiwygMarks = v;
							save();
							this.plugin.applyWysiwyg();
						})
					);
				},
			},
			{
				name: "Live checkboxes while editing",
				desc: "Keep a task's checkbox rendered on the line you are editing, instead of showing the raw '- [ ]' the way Live Preview does.",
				help: "Most noticeable when a note opens with a task on its first line and the cursor lands there: without this you see '- [ ]', with it you see a checkbox like every other line. Off the active line nothing changes, so there is never a doubled box.",
				build: (st) => {
					st.addToggle((t) =>
						t.setValue(s.liveCheckboxes).onChange((v) => {
							s.liveCheckboxes = v;
							save();
							this.plugin.refreshEditors();
						})
					);
				},
			},
			{
				name: "Rich text on copy",
				desc: "Ctrl+C also puts formatted text on the clipboard, so a paste into email keeps its headings, bold, links, and lettered sub-lists.",
				help: "Plain Markdown goes on the clipboard as well, so pasting into an editor or a terminal is unchanged. Pasting back into Obsidian gives you the Markdown you copied, not a reading of the HTML, because the copy carries its own source inside it. Turn this off if you want Obsidian's own plain copy back.",
				build: (st) => {
					st.addToggle((t) =>
						t.setValue(s.richCopy).onChange((v) => {
							s.richCopy = v;
							save();
						})
					);
				},
			},
			{
				name: "Indent guides on lists",
				desc: "The vertical rule Obsidian draws down each indent level.",
				help: "A numbered list already says how deep an item sits twice over - the numbering itself, and the a, b, c under it - so a third cue reads as a line ruled through your text. A bulleted list has nothing else saying it, which is why hiding those is a separate choice rather than the default. Both views, and Obsidian's own setting still governs whether guides exist at all.",
				build: (st) => {
					st.addDropdown((d) =>
						d
							.addOption("all", "Show on every list")
							.addOption("no-ordered", "Hide on numbered lists")
							.addOption("none", "Hide on every list")
							.setValue(s.indentGuides)
							.onChange((v) => {
								s.indentGuides = v as PowerEditorSettings["indentGuides"];
								save();
								this.plugin.applyListGuides();
							})
					);
				},
			},
			{
				name: "Line spacing",
				desc: "How much your pages breathe (applies to editing and reading views).",
				help: "Sets the gap between lines everywhere you read and write. Compact fits more on screen; Relaxed is gentler for long reading.",
				build: (st) => {
					st.addDropdown((d) =>
						d
							.addOption("compact", "Compact")
							.addOption("normal", "Normal")
							.addOption("relaxed", "Relaxed")
							.setValue(s.lineSpacing)
							.onChange((v) => {
								s.lineSpacing = v as PowerEditorSettings["lineSpacing"];
								save();
								this.plugin.applySpacing();
							})
					);
				},
			},
			this.gapRow(
				"Space under headings",
				"Markdown puts a blank line under a heading, and in editing view that line takes a full line's height. This shrinks it so a heading sits closer to what it introduces.",
				"headingGap",
				"A normal line is about 24px, so Half is half. Type your own number in the box for anything in between (0 to 60). None removes the gap entirely, the blank line stays in the file, so the Markdown is unchanged, it just stops taking up room. Editing view only; the cursor looks short while it sits on that line and returns to normal as soon as you type."
			),
			this.gapRow(
				"Space around tables",
				"A table has a blank line on both sides and Markdown needs both, delete one and the table stops being a table. This shrinks them, and trims the table's own bottom padding to match.",
				"tableGap",
				"Set independently of headings, because a table usually wants a little more room than a paragraph does. Where a table follows a heading directly, the heading setting wins, so a heading sits the same distance from whatever comes next. The table's bottom padding never goes below 6px, so the row drag handles keep their room."
			),
			{
				name: "Show when the note was last edited",
				desc: "A quiet line under the note's title: “Edited 3 minutes ago”. Click it to swap between the relative time and the exact date.",
				help: "Reads the file's own modified time, so it is right without you maintaining anything. If a note has an `updated:` (or `modified:`) property in its frontmatter, that wins instead, useful in a synced vault, where the sync client can rewrite the file's modified time when a note arrives from another device and make it look freshly edited.",
				build: (st) => {
					st.addDropdown((d) =>
						d
							.addOption("labeled", "Yes, with the word Edited")
							.addOption("bare", "Yes, just the time")
							.addOption("off", "Off")
							.setValue(s.showEdited)
							.onChange((v) => {
								s.showEdited = v as PowerEditorSettings["showEdited"];
								save();
								this.plugin.updatePageChrome();
							})
					);
				},
			},
			{
				name: "Where to show it",
				desc: "Under the note's title, at the very end of the note, or in both places.",
				help: "Under the title is the Notion habit: you see it as you arrive. The line variant is the same spot pulled tight against the title with a hairline drawn between them, so the title and the date read as one page header instead of as two stray lines above your first paragraph. At the end is closer to 1Password, where the detail sits out of the way until you go looking. Both is fine on long notes, where the title has scrolled away by the time you wonder.",
				build: (st) => {
					st.addDropdown((d) =>
						d
							.addOption("title", "Under the title")
							.addOption("rule", "Under the title, with a line above it")
							.addOption("bottom", "At the end of the note")
							.addOption("both", "Both")
							.setValue(s.editedPosition)
							.onChange((v) => {
								s.editedPosition = v as PowerEditorSettings["editedPosition"];
								save();
								this.plugin.updatePageChrome();
							})
					);
				},
			},
			{
				name: "Time format",
				desc: "How the time itself reads.",
				help: "Relative answers 'is this stale?' at a glance; exact answers 'which version is this?'. Whichever you pick, clicking the stamp shows both for that note until you click it again, and hovering always shows the exact time.",
				build: (st) => {
					st.addDropdown((d) =>
						d
							.addOption("relative", "Relative (3 minutes ago)")
							.addOption("exact", "Exact date and time")
							.addOption("both", "Relative, then the exact date")
							.setValue(s.editedFormat)
							.onChange((v) => {
								s.editedFormat = v as PowerEditorSettings["editedFormat"];
								save();
								this.plugin.updatePageChrome();
							})
					);
				},
			},
			{
				name: "Code block theme",
				desc: "The syntax palette for fenced code. The dark ones are the editor themes Claude and ChatGPT render code in.",
				help: "A dark code block inside a light note is what Claude, ChatGPT, and most documentation sites do, because saturated syntax colors need a dark surface to sit on. Vivid Light keeps the light background with stronger colors than Obsidian's own. Whichever you pick, code only takes color when the fence names a language, use the language button on the block to set or change it.",
				build: (st) => {
					st.addDropdown((d) =>
						d
							.addOption("vivid", "Vivid Light")
							.addOption("one-dark", "One Dark")
							.addOption("dracula", "Dracula")
							.addOption("monokai", "Monokai")
							.addOption("github-dark", "GitHub Dark")
							.addOption("default", "Follow my Obsidian theme")
							.setValue(s.codeTheme)
							.onChange((v) => {
								s.codeTheme = v as PowerEditorSettings["codeTheme"];
								save();
								this.plugin.applyCodeTheme();
							})
					);
				},
			},
			{
				name: "Line numbers in code blocks",
				desc: "A numbered gutter down the left of every fenced block.",
				help: "Numbers count from 1 within each block, not from the note's line count, so they match what you would see if the file were open in an editor. They are drawn, not written into the note, so copying the block copies the code alone.",
				build: (st) => {
					st.addToggle((t) =>
						t.setValue(s.codeLineNumbers).onChange((v) => {
							s.codeLineNumbers = v;
							save();
							this.plugin.applyCodeTheme();
						})
					);
				},
			},
		];

		const lists: Row[] = [
			{
				name: "Multilevel numbering (outline style)",
				desc: "Style nested numbered lists by level (1, 2, 3 then a, b, c then i, ii, iii) instead of restarting at 1 everywhere. Applies in editing and reading views; the raw number shows while your cursor is on the line.",
				help: "Nested numbered lists cascade through the styles you set per level instead of every level starting at 1. Choose each level below. The plain number reappears while your cursor is on that line so renumbering stays normal.",
				build: (st) => {
					st.addToggle((t) =>
						t.setValue(s.numberedOutline).onChange((v) => {
							s.numberedOutline = v;
							save();
							this.plugin.applyOutlineCss();
							this.plugin.refreshEditors();
							this.refresh(); // the per-level rows below appear or go
						})
					);
				},
			},
		];
		if (s.numberedOutline) {
			const ordinal = (n: number) => ["1st", "2nd", "3rd", "4th", "5th", "6th"][n] ?? `${n + 1}th`;
			for (let level = 0; level < s.outlineStyles.length; level++) {
				const at = level;
				lists.push({
					name: `${ordinal(at)} level`,
					build: (st) => {
						st.addDropdown((d) => {
							for (const [value, label] of OUTLINE_CHOICES) d.addOption(value, label);
							d.setValue(s.outlineStyles[at]).onChange((v) => {
								s.outlineStyles[at] = v;
								save();
								this.plugin.applyOutlineCss();
								this.plugin.refreshEditors();
							});
						});
					},
				});
			}
		}

		const clipboard: Row[] = [
			{
				name: "Clean pasted HTML",
				desc: "Pasting from Word, Outlook, a web page, or an AI chat converts to clean Markdown automatically, tables included. The 'Paste as clean Markdown' command does it on demand.",
				help: "Strips the hidden styling that Word, Outlook, and web pages carry and turns it into plain Markdown. Tables keep their rows and columns, so a comparison copied out of ChatGPT, Claude, or Grok lands as a real table instead of one run-on paragraph. When this is off, the 'Paste as clean Markdown' command still does it on request.",
				build: (st) => {
					st.addToggle((t) => t.setValue(s.cleanPaste).onChange((v) => ((s.cleanPaste = v), save())));
				},
			},
			{
				name: "Clean copied text",
				desc: "Highlighted or colored text stores HTML in the note. Clean removes those tags when you copy, so other apps get readable text and keep bold and italics. Plain text also drops the Markdown so nothing but the words is left. Off leaves copying to Obsidian.",
				help: "Pick Plain text if you want pasted words with no ** or highlight tags at all. Clean keeps bold and italics but removes the color HTML. This only affects copying from editing view; Reading view already copies plain text.",
				build: (st) => {
					st.addDropdown((d) =>
						d
							.addOption("clean", "Clean (remove highlight and color tags)")
							.addOption("plain", "Plain text (remove all formatting)")
							.addOption("off", "Off (Obsidian default)")
							.setValue(s.copyMode)
							.onChange((v) => {
								s.copyMode = v as PowerEditorSettings["copyMode"];
								save();
							})
					);
				},
			},
		];

		const todos: Row[] = [
			{
				name: "Completing a to-do stamps the date",
				desc: "Checking a box appends a ✅ done date so dashboards can show when things got finished. Recurring items (🔁) always create their next occurrence either way. Query them anywhere with a 'todo' code block.",
				help: "The stamped date is what the 'todo' dashboards use to show what got done and when. Recurring items still spawn their next date whether this is on or off.",
				build: (st) => {
					st.addToggle((t) => t.setValue(s.stampDoneDates).onChange((v) => ((s.stampDoneDates = v), save())));
				},
			},
			{
				name: "Quick capture inbox",
				desc: "Where 'To-do: quick capture' appends new items. The note is created if it doesn't exist.",
				help: "Give a path like Inbox.md or Tasks/Inbox.md. The note and any missing folders are created the first time you capture into it.",
				build: (st) => {
					st.addText((t) => t.setPlaceholder("Inbox.md").setValue(s.inboxNote).onChange((v) => ((s.inboxNote = v), save())));
				},
			},
			{
				name: "To-do reminders",
				desc: "A due-today digest when Obsidian opens, and a notice the minute any '⏰ HH:MM' to-do comes due while the app is running.",
				help: "Add a time to any item with the ⏰ emoji, like ⏰ 14:30, and a notice pops when it comes due while Obsidian is open. Phone push notifications are not possible from a plugin.",
				build: (st) => {
					st.addToggle((t) => t.setValue(s.todoReminders).onChange((v) => ((s.todoReminders = v), save())));
				},
			},
		];

		const ai: Row[] = [
			{
				name: "Anthropic API key",
				desc: "Powers the bubble's AI actions (improve, fix grammar, shorten, summarize). Leave empty to reuse Power Assistant's key automatically.",
				help: "Used only by the AI actions on the bubble and menu. It lives in this vault's settings and never appears in a note. Leave it blank and the plugin borrows Power Assistant's key when that plugin is installed.",
				build: (st) => {
					st.addText((t) => {
						t.inputEl.type = "password";
						t.setValue(s.anthropicKey).onChange((v) => ((s.anthropicKey = v.trim()), save()));
					});
				},
			},
			{
				name: "Model",
				help: "The Claude model the AI actions call. Haiku is fast and inexpensive for quick edits; a larger model gives stronger rewrites. Clear the box to restore the default.",
				build: (st) => {
					st.addText((t) => t.setValue(s.aiModel).onChange((v) => ((s.aiModel = v.trim() || "claude-haiku-4-5"), save())));
				},
			},
			{
				name: "Custom AI actions",
				desc: 'Your own one-click instructions on the AI menu, e.g. "Rewrite as a customer-friendly email".',
				help: "Each action is a label plus an instruction. The label shows on the AI menu; the instruction is applied to whatever text you have selected. Handy for repeated jobs like turning notes into a status update.",
				build: (st) => {
					st.addButton((b) =>
						b.setButtonText("Add action").onClick(() => {
							s.aiActions.push({ name: "", prompt: "" });
							save();
							this.refresh();
						})
					);
				},
			},
		];
		s.aiActions.forEach((a, idx) => {
			ai.push({
				name: "",
				aliases: ["custom AI action"],
				build: (st) => {
					st.settingEl.addClass("ped-aiaction-row");
					st.addText((t) => t.setPlaceholder("Menu label").setValue(a.name).onChange((v) => ((a.name = v), save())));
					st.addTextArea((t) =>
						t
							.setPlaceholder("Instruction, e.g. Rewrite this as a friendly status update.")
							.setValue(a.prompt)
							.onChange((v) => ((a.prompt = v), save()))
					);
					st.addExtraButton((b) =>
						b.setIcon("trash-2").setTooltip("Remove").onClick(() => {
							s.aiActions.splice(idx, 1);
							save();
							this.refresh();
						})
					);
					return () => st.settingEl.removeClass("ped-aiaction-row");
				},
			});
		});

		const dictation: Row[] = [
			{
				name: "Transcription endpoint",
				desc: "Any OpenAI-compatible base URL, for example Groq. Leave empty to reuse Power Assistant's transcription automatically.",
				help: "Where the recorded audio is sent to become text; only the /audio/transcriptions path under it is used. Leave it blank and dictation borrows Power Assistant's endpoint and key when that plugin is installed, so a vault running both needs no second setup. Point it at a server on your own machine to keep the audio local, in which case no key is needed.",
				build: (st) => {
					st.addText((t) =>
						t
							.setPlaceholder("https://api.groq.com/openai/v1")
							.setValue(s.transcriptionEndpoint)
							.onChange((v) => ((s.transcriptionEndpoint = v.trim()), save()))
					);
				},
			},
			{
				name: "Transcription API key",
				desc: "The key for the endpoint above. Empty is fine for a server on your own machine, or to fall back to Power Assistant's.",
				help: "The bearer token for the endpoint above. It is stored in this vault's settings and sent only to that endpoint. A transcription server running on your own machine usually needs no key at all.",
				build: (st) => {
					st.addText((t) => {
						t.inputEl.type = "password";
						t.setPlaceholder("Leave empty to use Power Assistant's")
							.setValue(s.transcriptionKey)
							.onChange((v) => ((s.transcriptionKey = v.trim()), save()));
					});
				},
			},
			{
				name: "Transcription model",
				help: "The model name the endpoint expects, for example whisper-large-v3 on Groq. Leave it empty to use whisper-large-v3.",
				build: (st) => {
					st.addText((t) =>
						t
							.setPlaceholder("whisper-large-v3")
							.setValue(s.transcriptionModel)
							.onChange((v) => ((s.transcriptionModel = v.trim()), save()))
					);
				},
			},
			{
				name: "After transcribing",
				desc: "Raw inserts exactly what you said. Tidy removes filler and fixes punctuation; Bullets turns it into a list (both use the AI key). Right-click the mic to switch on the fly.",
				help: "Tidy and Bullets send the transcript through the AI key, so they need a key set above. Raw needs no key. Right-click the microphone button to switch mode without opening settings.",
				build: (st) => {
					st.addDropdown((d) =>
						d
							.addOption("raw", "Insert the raw transcript")
							.addOption("tidy", "Tidy into clean prose")
							.addOption("bullets", "Turn into bullet points")
							.setValue(s.dictationMode)
							.onChange((v) => {
								s.dictationMode = v as PowerEditorSettings["dictationMode"];
								save();
							})
					);
				},
			},
		];

		return [
			{
				id: "toolbar",
				label: "Toolbar",
				groups: [
					{ heading: "Toolbar", rows: toolbar },
					{
						heading: "Buttons",
						help: "Which buttons appear on the toolbar, and in what order. A hidden button still works from the command palette and the slash menu.",
						rows: buttons,
					},
				],
			},
			{ id: "editing", label: "Editing", groups: [{ heading: "Editing", rows: editing }] },
			{ id: "lists", label: "Lists", groups: [{ heading: "Numbered list outline", rows: lists }] },
			{ id: "clipboard", label: "Clipboard", groups: [{ heading: "Clipboard", rows: clipboard }] },
			{ id: "todos", label: "To-dos", groups: [{ heading: "To-dos", rows: todos }] },
			{
				id: "ai",
				label: "AI & dictation",
				groups: [
					{ heading: "AI edits", rows: ai },
					{ heading: "Dictation", rows: dictation },
				],
			},
		];
	}

	/** Headings and tables get the same control twice, so it is built once. */
	private gapRow(name: string, desc: string, key: "headingGap" | "tableGap", hint: string): Row {
		const s = this.plugin.settings;
		const save = () => void this.plugin.persistSettings();
		const GAPS: [string, string][] = [
			["off", "Off (Obsidian default)"],
			["18", "Roomy (18px)"],
			["12", "Half (12px)"],
			["8", "Tight (8px)"],
			["4", "Very tight (4px)"],
			["0", "None (0px)"],
		];
		return {
			name,
			desc,
			help: hint,
			build: (st) => {
				st.addDropdown((d) => {
					for (const [v, label] of GAPS) d.addOption(v, label);
					// a value typed into the box beside it is not one of the presets;
					// show it rather than snapping to something wrong
					if (!GAPS.some(([v]) => v === s[key])) d.addOption(s[key], `Custom (${s[key]}px)`);
					d.setValue(s[key]).onChange((v) => {
						s[key] = v;
						save();
						this.plugin.applyBlockGap();
						this.refresh(); // the Custom entry is rebuilt from the new value
					});
				});
				st.addText((t) =>
					t
						.setPlaceholder("px")
						.setValue(s[key] === "off" ? "" : s[key])
						.onChange((v) => {
							const n = Number(v.trim());
							if (v.trim() === "" || !Number.isFinite(n) || n < 0 || n > 60) return;
							s[key] = String(n);
							save();
							this.plugin.applyBlockGap();
						})
				);
			},
		};
	}

	/** Redraw the button list in place. Kept off the tab's own redraw because
	 *  moving a button is a rapid, repeated action, and rebuilding the tab would
	 *  throw you back to the top of the page on every click. */
	private redrawButtonOrder() {
		const list = this.orderList;
		if (!list) return;
		list.empty();
		const s = this.plugin.settings;
		const save = () => void this.plugin.persistSettings();
		const hidden = new Set(s.hiddenButtons);
		const labelOf = new Map(BUTTON_IDS);
		const order = this.plugin.orderedButtonIds();
		const move = (i: number, delta: number) => {
			const j = i + delta;
			if (j < 0 || j >= order.length) return;
			[order[i], order[j]] = [order[j], order[i]];
			s.buttonOrder = order;
			save();
			this.plugin.rebuildToolbars();
			this.redrawButtonOrder();
		};
		order.forEach((id, i) => {
			const row = new Setting(list);
			if (id === "|") {
				row.setName("Divider").setDesc("A vertical rule between groups.");
				row.nameEl.addClass("ped-order-divider");
			} else {
				row.setName(labelOf.get(id) ?? id);
			}

			// Drag to reorder. The grip is the only handle, so a drag can never
			// start from the toggle you were reaching for, and the row itself
			// carries the drop target.
			const el = row.settingEl;
			el.addClass("ped-order-row");
			const grip = createDiv({ cls: "ped-order-grip", attr: { "aria-label": "Drag to reorder", draggable: "true" } });
			setIcon(grip, "grip-vertical");
			el.prepend(grip);

			// Keyboard parity, since a drag handle is unreachable without a mouse:
			// focus the grip and use the arrow keys.
			grip.tabIndex = 0;
			grip.addEventListener("keydown", (e) => {
				if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
				e.preventDefault();
				move(i, e.key === "ArrowUp" ? -1 : 1);
			});

			grip.addEventListener("dragstart", (ev) => {
				this.dragFrom = i;
				el.addClass("is-dragging");
				ev.dataTransfer?.setData("text/plain", String(i));
				if (ev.dataTransfer) ev.dataTransfer.effectAllowed = "move";
				// drag the whole row, not the little grip glyph
				ev.dataTransfer?.setDragImage(el, 12, el.offsetHeight / 2);
			});
			grip.addEventListener("dragend", () => {
				this.dragFrom = null;
				list.findAll(".ped-order-row").forEach((r) => {
					r.removeClass("is-dragging");
					r.removeClass("drop-above");
					r.removeClass("drop-below");
				});
			});

			el.addEventListener("dragover", (ev) => {
				if (this.dragFrom === null) return;
				ev.preventDefault();
				if (ev.dataTransfer) ev.dataTransfer.dropEffect = "move";
				const r = el.getBoundingClientRect();
				const below = ev.clientY > r.top + r.height / 2;
				el.toggleClass("drop-above", !below);
				el.toggleClass("drop-below", below);
			});
			el.addEventListener("dragleave", () => {
				el.removeClass("drop-above");
				el.removeClass("drop-below");
			});
			el.addEventListener("drop", (ev) => {
				ev.preventDefault();
				if (this.dragFrom === null) return;
				const r = el.getBoundingClientRect();
				const below = ev.clientY > r.top + r.height / 2;
				const next = moveItem(order, this.dragFrom, below ? i + 1 : i);
				this.dragFrom = null;
				s.buttonOrder = next;
				save();
				this.plugin.rebuildToolbars();
				this.redrawButtonOrder();
			});

			if (id === "|") {
				row.addExtraButton((b) =>
					b
						.setIcon("trash-2")
						.setTooltip("Remove this divider")
						.onClick(() => {
							const next = order.slice();
							next.splice(i, 1);
							s.buttonOrder = next;
							save();
							this.plugin.rebuildToolbars();
							this.redrawButtonOrder();
						})
				);
				return;
			}
			row.addToggle((t) =>
				t.setValue(!hidden.has(id)).onChange((v) => {
					if (v) hidden.delete(id);
					else hidden.add(id);
					s.hiddenButtons = [...hidden];
					save();
					this.plugin.rebuildToolbars();
				})
			);
		});
	}
}
