import { mergeForSave, moveItem } from "./settings";
import {
	blockRangeAt,
	blockStarts,
	convertCalloutLeads,
	deleteBlock,
	findCalloutLeads,
	duplicateBlock,
	ensureBlockId,
	guessLanguage,
	insertItemAbove,
	formatFenceInfo,
	narrowEdit,
	parseFenceInfo,
	frontmatterEnd,
	isTranscriptCalloutAt,
	isTranscriptTurnAt,
	listStretchRange,
	moveBlock,
	sectionRangeAt,
	stripTags,
	serializeTabs,
	stripCalloutLead,
	tableSnippet,
	transformBlock,
	unionBlockRange,
} from "./blocks";
import { resizeEmbed } from "./embed";
import {
	editedAt,
	GRADIENTS,
	gradientCss,
	makeComment,
	parseComments,
	parseCover,
	parseIcon,
	parsePageLayout,
	relativeEdited,
	replaceCommentText,
	verificationState,
} from "./page";
import {
	archiveCompleted,
	formatTodo,
	parseDatePhrase,
	parseQuery,
	parseQuickTodo,
	parseTodo,
	runQuery,
	setDueDate,
	setPriority,
	toggleTodo,
} from "./tasks";
import { cleanPastedHtml, escapePlaceholderTags, findPlaceholderTags, isOneMarkdownTable, looksLikeMarkdownTable, padPastedMarkdown, preCleanHtml, postCleanMarkdown, tableToMarkdown, tabbedTextToMarkdown } from "./clean";
import { buildMultipart, planDictationInsert } from "./dictate";
import {
	alignOf,
	cleanCopyText,
	clearAllFormatting,
	mdEmphasisToHtml,
	htmlEmphasisToMd,
	convertEmphasisInWrappers,
	linkAt,
	setFontSize,
	toggleScript,
	applyMarks,
	continueList,
	detectMarks,
	expandStyleRange,
	formatCounter,
	sweepHighlights,
	hasAnyMark,
	headingLevel,
	listKind,
	orderedListInfo,
	setAlign,
	setHeading,
	stripFormatting,
	wrapperAt,
	colorBlockLine,
	emptyHeadingLabel,
	headingCursorSnap,
	isBlankBlock,
	markdownFromMarker,
	olStyleForDepth,
	olTypeForDepth,
	stripFrontmatter,
	wrapWithMarkdown,
} from "./format";

let fails = 0;
function ok(cond: unknown, name: string) {
	if (cond) console.log("  ok -", name);
	else {
		fails++;
		console.log("FAIL -", name);
	}
}
function eq<T>(got: T, want: T, name: string) {
	const pass = JSON.stringify(got) === JSON.stringify(want);
	if (!pass) {
		console.log("   got:", JSON.stringify(got));
		console.log("  want:", JSON.stringify(want));
	}
	ok(pass, name);
}

const L = (s: string) => s.split("\n");
const doc = (lines: string[]) => lines.join("\n");

// --- frontmatter + ranges ---
const FM = L("---\ntitle: x\n---\n\n# Head\n\npara one\npara one b\n\n- item\n  child\n\n| a |\n| - |\n| 1 |");
eq(frontmatterEnd(FM), 3, "frontmatter end found");
eq(blockRangeAt(FM, 1), null, "frontmatter lines are not draggable");
eq(blockRangeAt(FM, 3), null, "blank lines are not blocks");
eq(blockRangeAt(FM, 4), { from: 4, to: 4 }, "a heading travels alone");
eq(blockRangeAt(FM, 7), { from: 6, to: 7 }, "paragraphs are contiguous plain lines");
eq(blockRangeAt(FM, 9), { from: 9, to: 10 }, "a list item carries its indented child");
eq(blockRangeAt(FM, 10), { from: 9, to: 10 }, "hovering the child grabs the owning item");
eq(blockRangeAt(FM, 13), { from: 12, to: 14 }, "tables travel whole");

// a .base or note embed sits on its own line; Live Preview draws it as a
// block widget, and the grip maps that widget back to this single-line block
const EMBED = L("intro\n\n![[Test1 Base.base]]\n\ntail");
eq(blockRangeAt(EMBED, 2), { from: 2, to: 2 }, "an embed on its own line is a one-line block");
eq(blockStarts(EMBED), [0, 2, 4], "the embed line is its own drop boundary");

const FENCE = L("intro\n\n```js\ncode();\nmore();\n```\n\nafter");
eq(blockRangeAt(FENCE, 3), { from: 2, to: 5 }, "hover inside a fence grabs the whole fence");
eq(blockRangeAt(FENCE, 5), { from: 2, to: 5 }, "the closing fence line counts too");

const QUOTE = L("> quoted\n> more\n\ntext");
eq(blockRangeAt(QUOTE, 1), { from: 0, to: 1 }, "quotes and callouts travel whole");

const NESTED = L("- parent\n  - sub\n\n  more child\n- next");
eq(blockRangeAt(NESTED, 0), { from: 0, to: 3 }, "blank-separated deeper content stays with the item");
eq(blockRangeAt(NESTED, 4), { from: 4, to: 4 }, "the next sibling is its own block");

// --- boundaries ---
eq(blockStarts(L("# a\n\npara\npara\n\n- x\n  y")), [0, 2, 5], "block starts skip blanks and group blocks");

// --- moves ---
const A = L("one\n\ntwo\n\nthree");
eq(doc(moveBlock(A, { from: 0, to: 0 }, 4)!.lines), "two\n\none\n\nthree", "moving a paragraph down keeps single gaps");
eq(doc(moveBlock(A, { from: 4, to: 4 }, 0)!.lines), "three\n\none\n\ntwo", "moving to the top gains a gap below");
eq(doc(moveBlock(A, { from: 0, to: 0 }, 5)!.lines), "two\n\nthree\n\none", "moving to the end lands after everything");
eq(moveBlock(A, { from: 2, to: 2 }, 2), null, "dropping a block onto itself is a no-op");
eq(moveBlock(A, { from: 2, to: 2 }, 3), null, "dropping just after itself is a no-op");
const mv = moveBlock(A, { from: 0, to: 0 }, 4)!;
eq(mv.newStart, 2, "newStart points at the moved block");

const LIST = L("- a\n- b\n- c");
eq(doc(moveBlock(LIST, { from: 0, to: 0 }, 3)!.lines), "- b\n- c\n- a", "list items glue to list neighbors without gaps");
eq(doc(moveBlock(LIST, { from: 2, to: 2 }, 0)!.lines), "- c\n- a\n- b", "moving a list item up stays glued");

const MIXED = L("- item\n  child\n\npara here");
eq(
	doc(moveBlock(MIXED, { from: 0, to: 1 }, 4)!.lines),
	"para here\n\n- item\n  child",
	"a list item leaving the list gains paragraph spacing"
);

const FENCED = L("alpha\n\n```\nx\n```\n\nomega");
eq(
	doc(moveBlock(FENCED, { from: 2, to: 4 }, 0)!.lines),
	"```\nx\n```\n\nalpha\n\nomega",
	"fences move intact with spacing"
);

// --- format helpers ---
eq(headingLevel("### Title"), 3, "heading level reads");
eq(headingLevel("Body"), 0, "non-heading is level zero");
eq(setHeading("Body text", 2), "## Body text", "setHeading adds a prefix");
eq(setHeading("### Old", 1), "# Old", "setHeading replaces the level");
eq(setHeading("## Gone", 0), "Gone", "level zero removes the heading");
eq(setHeading("> ## Quoted", 3), "> ### Quoted", "quoted headings keep their quote marker");
eq(listKind("- [x] done"), "task", "task list detected");
eq(listKind("2) step"), "ordered", "numbered list detected");
eq(listKind("* dot"), "bullet", "bullet detected");
eq(listKind("plain"), null, "plain lines are not lists");
eq(stripFormatting("**bold** and *it* and ~~s~~ and ==h== and `c`"), "bold and it and s and h and c", "markdown marks strip");
eq(stripFormatting('<u>u</u> <span style="color:#f00">red</span>'), "u red", "inline html strips to text");
eq(stripFormatting("[link](https://x)"), "[link](https://x)", "links survive clear formatting");
eq(stripFormatting("a_var_name stays"), "a_var_name stays", "intra-word underscores are left alone");

// --- markdown emphasis <-> HTML (so bold survives inside a colored highlight) ---
eq(mdEmphasisToHtml("Use the **demo** skill"), "Use the <strong>demo</strong> skill", "flush bold becomes <strong>");
eq(mdEmphasisToHtml("a *it* b ~~s~~ c"), "a <em>it</em> b <s>s</s> c", "italic and strike convert");
eq(mdEmphasisToHtml("if (x == y) plain"), "if (x == y) plain", "text with no emphasis is untouched");
eq(mdEmphasisToHtml("a ** spaced ** b"), "a ** spaced ** b", "a spaced ** is not a bold pair");
eq(htmlEmphasisToMd("Use the <strong>demo</strong> skill"), "Use the **demo** skill", "<strong> converts back to **");
eq(htmlEmphasisToMd("<em>it</em> and <b>bd</b>"), "*it* and **bd**", "em and b convert back to markdown");
eq(
	convertEmphasisInWrappers('Use the <mark style="background:#E2F5EA">**demo** skill</mark> and **plain** bold'),
	{ text: 'Use the <mark style="background:#E2F5EA"><strong>demo</strong> skill</mark> and **plain** bold', count: 1 },
	"emphasis converts inside the mark but plain markdown bold outside stays"
);
eq(convertEmphasisInWrappers("nothing here").count, 0, "a note without wrapped emphasis reports zero");

// --- clean copied text (highlight/color HTML must not paste into other apps) ---
const GREEN = '<mark style="background:#d3f9d8">Use the **claude-design-to-html** skill on attached zip file.</mark>';
eq(cleanCopyText(GREEN, "clean"), "Use the **claude-design-to-html** skill on attached zip file.", "clean copy peels the highlight tags, keeps markdown");
eq(cleanCopyText(GREEN, "plain"), "Use the claude-design-to-html skill on attached zip file.", "plain copy drops the markdown too");
eq(cleanCopyText('<span style="color:#B42318">red words</span>', "clean"), "red words", "clean copy peels a color span");
eq(cleanCopyText("==noted== and **kept**", "clean"), "noted and **kept**", "clean copy unwraps a highlight but keeps bold");
eq(cleanCopyText("nothing to strip here", "clean"), "nothing to strip here", "unformatted text copies unchanged");
eq(cleanCopyText("if (x == y) return x;", "clean"), "if (x == y) return x;", "an == operator is not a highlight and survives");
eq(cleanCopyText("run `x == y` twice", "plain"), "run `x == y` twice", "inline code is left verbatim even in plain mode");
eq(cleanCopyText("## <mark>Title</mark>", "plain"), "Title", "plain copy drops heading hashes and the highlight");
eq(cleanCopyText("# Heading", "clean"), "# Heading", "clean copy keeps heading hashes");

// --- clear formatting (whole line, "reset to Normal" semantics) ---
eq(clearAllFormatting("## 1. test"), "1. test", "clear formatting resets a heading to plain text");
eq(clearAllFormatting("**bold** and ==glow==<!--al:center-->"), "bold and glow", "clear strips inline marks and the alignment marker");
eq(clearAllFormatting("- [ ] **task** item"), "- [ ] task item", "list structure survives a clear");
eq(clearAllFormatting("> ## Quoted"), "> Quoted", "a quoted heading keeps its quote but loses the heading");

// --- heading sections ---
const SEC = L("# Top\n\n## A\n\ntext a\n\n### A1\n\ndeep\n\n## B\n\ntext b");
eq(sectionRangeAt(SEC, 2), { from: 2, to: 8 }, "a section runs to the next same-level heading");
eq(sectionRangeAt(SEC, 0), { from: 0, to: 12 }, "an H1 section spans everything beneath it");
eq(sectionRangeAt(SEC, 4), { from: 4, to: 4 }, "non-headings still resolve to their own block");

// --- multi-block union ---
eq(unionBlockRange(L("one\n\ntwo\n\nthree"), 0, 2), { from: 0, to: 2 }, "a selection spanning blocks unions them");
eq(unionBlockRange(L("one\n\ntwo"), 1, 1), null, "a blank-only span has no union");

// --- turn into ---
const T = L("- alpha\n- beta");
eq(doc(transformBlock(T, { from: 0, to: 1 }, "paragraph")), "alpha\nbeta", "list to paragraph strips markers");
eq(doc(transformBlock(L("plain"), { from: 0, to: 0 }, "h2")), "## plain", "paragraph to heading");
eq(doc(transformBlock(L("## head"), { from: 0, to: 0 }, "task")), "- [ ] head", "heading to checklist");
eq(doc(transformBlock(L("a\nb"), { from: 0, to: 1 }, "ordered")), "1. a\n2. b", "numbered lists renumber");
eq(doc(transformBlock(L("x"), { from: 0, to: 0 }, "callout")), "> [!note]\n> x", "callout wraps with a note header");
eq(doc(transformBlock(L("> [!note]\n> body"), { from: 0, to: 1 }, "paragraph")), "body", "callout back to paragraph");
eq(doc(transformBlock(L("x"), { from: 0, to: 0 }, "callout", { type: "warning" })), "> [!warning]\n> x", "typed callouts take the chosen flavor");
eq(
	doc(transformBlock(L("Title line\nbody here"), { from: 0, to: 1 }, "callout", { type: "note", folded: true })),
	"> [!note]- Title line\n> body here",
	"a toggle block folds with its first line as the title"
);
eq(
	doc(transformBlock(L("Title\nlots of text\nmore text"), { from: 0, to: 2 }, "callout", { type: "toggle", folded: true })),
	"> [!toggle]- Title\n> lots of text\n> more text",
	"toggle blocks use the toggle flavor"
);
eq(
	doc(transformBlock(L("> [!toggle]- Title\n> lots of text"), { from: 0, to: 1 }, "paragraph")),
	"Title\nlots of text",
	"unwrapping a toggle restores the title as the first line"
);
const BLOB = "Welcome to the show. ".repeat(12).trim();
eq(
	doc(transformBlock(L(BLOB), { from: 0, to: 0 }, "callout", { type: "toggle", folded: true })),
	`> [!toggle]-\n> ${BLOB}`,
	"a one-line blob folds as body under an empty title, never into the title"
);
eq(
	doc(transformBlock(L(`${BLOB}\nsecond line`), { from: 0, to: 1 }, "callout", { type: "toggle", folded: true })),
	`> [!toggle]-\n> ${BLOB}\n> second line`,
	"an overlong first line stays in the body too"
);

// --- transcript guard: Power Editor leaves Power Assistant's purpose-built
// [!transcript] callout alone (no block grip, no callout menu) ---
const TR = L("> [!transcript]\n> **Alice:** hi\n> **Bob:** yo\n\n> [!note]\n> ordinary\n\nplain para");
ok(isTranscriptCalloutAt(TR, 0), "the transcript header is recognized");
ok(isTranscriptCalloutAt(TR, 1), "a transcript body line is recognized");
ok(isTranscriptCalloutAt(TR, 2), "every transcript body line is recognized");
ok(!isTranscriptCalloutAt(TR, 3), "the blank between callouts is not a transcript");
ok(!isTranscriptCalloutAt(TR, 4), "a normal [!note] callout keeps its affordances");
ok(!isTranscriptCalloutAt(TR, 5), "a normal callout's body keeps its affordances");
ok(!isTranscriptCalloutAt(TR, 7), "a plain paragraph is unaffected");
ok(isTranscriptCalloutAt(L("> [!Transcript]- Meeting\n> body"), 1), "match is case-insensitive and ignores fold/title");
ok(!isTranscriptCalloutAt(L("Alice: hi\n> [!transcript]"), 0), "a plain line above a transcript is not swallowed");
ok(!isTranscriptCalloutAt(L("> [!transcript]\n> body\nplain below"), 2), "a plain line directly below a transcript is not swallowed");
ok(!isTranscriptCalloutAt(L("> [!transcription]\n> body"), 0), "a look-alike callout type is not treated as transcript");
ok(!isTranscriptCalloutAt(L("plain"), 5), "an out-of-range line is safe");

// --- migrated transcript: Power Assistant now writes plain `**Name [m:ss]:**`
// speaker lines under a `## Transcript` heading; those turns keep their own
// avatar/menu UI, so Power Editor's block grip must skip them too ---
const TT = L("# Meeting\n\nSome notes.\n\n## Transcript\n\n**Alice [0:00]:** hi there\n**Bob:** yo\n\n## Actions\n\n**Note:** do the thing");
ok(isTranscriptTurnAt(TT, 6), "a stamped speaker turn under ## Transcript is recognized");
ok(isTranscriptTurnAt(TT, 7), "a stampless speaker turn under ## Transcript is recognized");
ok(!isTranscriptTurnAt(TT, 4), "the ## Transcript heading itself keeps its grip");
ok(!isTranscriptTurnAt(TT, 2), "prose before the transcript is unaffected");
ok(!isTranscriptTurnAt(TT, 11), "a `**Note:**` lead-in under a later heading is not a transcript turn");
ok(!isTranscriptTurnAt(L("**Alice:** hi"), 0), "a speaker-shaped line with no heading above is not a transcript turn");
ok(!isTranscriptTurnAt(L("## Transcript\n\nplain paragraph, not a turn"), 2), "a non-speaker line under ## Transcript is left alone");
ok(!isTranscriptTurnAt(L("### Transcript\n\n**Alice:** hi"), 2), "only a level-2 `## Transcript` bounds the section");
ok(!isTranscriptTurnAt(L("## Transcript\n### Sub\n**Alice:** hi"), 2), "an intervening heading ends the transcript section");
ok(isTranscriptTurnAt(L("## Transcript\n**Alice [1:02:03]:** long meeting"), 1), "an hours stamp still reads as a turn");
ok(!isTranscriptTurnAt(TT, 99), "an out-of-range line is safe");

// --- Word fake-list laundering ---
import { convertWordLists } from "./clean";
const WP = (level: number, marker: string, text: string) =>
	`<p class=MsoListParagraph style='mso-list:l0 level${level} lfo1'><!--[if !supportLists]--><span style='mso-list:Ignore'>${marker}<span>&nbsp;</span></span><!--[endif]-->${text}</p>`;
eq(
	convertWordLists(WP(1, "·", "Alpha") + WP(1, "·", "Beta")),
	"<ul><li>Alpha</li><li>Beta</li></ul>",
	"flat Word bullets become a real ul"
);
eq(
	convertWordLists(WP(1, "1.", "One") + WP(2, "·", "Sub") + WP(1, "2.", "Two")),
	"<ol><li>One<ul><li>Sub</li></ul></li><li>Two</li></ol>",
	"numbered markers make an ol and levels nest"
);
eq(
	convertWordLists("<p>before</p>" + WP(1, "·", "Item") + "<p>after</p>"),
	"<p>before</p><ul><li>Item</li></ul><p>after</p>",
	"surrounding paragraphs pass through untouched"
);
eq(convertWordLists("<p>plain</p>"), "<p>plain</p>", "html without Word lists is unchanged");

// --- Notion callouts ---
eq(
	doc(transformBlock(L("Remember the thing"), { from: 0, to: 0 }, "callout", { type: "question", emoji: "❓" })),
	"> [!question] ❓ Remember the thing",
	"a single-line Notion callout leads with its emoji on one row"
);
eq(
	doc(transformBlock(L("a\nb"), { from: 0, to: 1 }, "callout", { type: "warning", emoji: "⚠️" })),
	"> [!warning] ⚠️\n> a\n> b",
	"multi-line Notion callouts carry the emoji in the header"
);

// --- callout lead-in labels ---
eq(stripCalloutLead("Tip: download from the store", "tip"), "download from the store", "a bare label lead-in goes");
eq(stripCalloutLead("**Tip:** download from the store", "tip"), "download from the store", "a bolded label lead-in goes");
eq(stripCalloutLead("**Note**: keep the receipt", "note"), "keep the receipt", "the colon may sit outside the bold");
eq(stripCalloutLead("Caution: hot surface", "warning"), "hot surface", "aliases resolve to their type");
eq(stripCalloutLead("Important: the limit is removed", "warning"), "the limit is removed", "'Important' is a warning, not a tip");
eq(stripCalloutLead("Important: the limit is removed", "tip"), "Important: the limit is removed", "...so a tip does not claim it");
eq(stripCalloutLead("Tip: something", "warning"), "Tip: something", "a label for another type stays");
eq(stripCalloutLead("Ratio: 3 to 1", "tip"), "Ratio: 3 to 1", "an unrelated label stays");
eq(stripCalloutLead("Tip:", "tip"), "Tip:", "a line that is only the label stays — nothing would be left");
eq(
	doc(transformBlock(L("**Tip:** Download from the Mac App Store"), { from: 0, to: 0 }, "callout", { type: "tip", emoji: "💡" })),
	"> [!tip] 💡 Download from the Mac App Store",
	"converting a labeled line does not say 'tip' twice"
);

// --- converting older notes ---
const conv = (src: string, bare = false) => {
	const lines = src.split("\n");
	const leads = findCalloutLeads(lines).filter((l) => bare || !l.bare);
	return convertCalloutLeads(lines, leads).join("\n");
};
eq(
	conv("intro\n\n> **Tip:** Press **Command + Space** to open Spotlight.\n\nafter"),
	"intro\n\n> [!tip] 💡 Press **Command + Space** to open Spotlight.\n\nafter",
	"a quoted tip becomes a tip callout in place"
);
eq(
	conv("> **Warning:** Bypassing macOS security should be an exception."),
	"> [!warning] ⚠️ Bypassing macOS security should be an exception.",
	"a quoted warning keeps its blockquote and gains the header"
);
eq(
	conv("**Note:** Install on the **D** drive.\nSecond line of the same note.\n\nafter"),
	"> [!note] 📝 Install on the **D** drive.\n> Second line of the same note.\n\nafter",
	"a bare paragraph is pulled into the callout, body and all"
);
eq(
	conv("**Note**: Go to Project Settings."),
	"> [!note] 📝 Go to Project Settings.",
	"the colon outside the bold converts too"
);
eq(
	conv("Note: This time is calculated from the notification."),
	"Note: This time is calculated from the notification.",
	"an unbolded label is left alone by default"
);
eq(
	conv("Note: This time is calculated from the notification.", true),
	"> [!note] 📝 This time is calculated from the notification.",
	"...and converts when plain labels are opted in"
);
eq(
	conv("> [!tip] 💡 Already a callout.\n> **Note:** body line"),
	"> [!tip] 💡 Already a callout.\n> **Note:** body line",
	"a line inside an existing callout is never rewritten"
);
eq(
	conv("```\n**Note:** this is sample markdown\n```"),
	"```\n**Note:** this is sample markdown\n```",
	"code fences are left alone"
);
eq(
	conv("---\ntags: Note: something\n---\n\nbody"),
	"---\ntags: Note: something\n---\n\nbody",
	"frontmatter is data, not prose"
);
eq(
	conv("- **Note:** a list item keeps its bullet"),
	"- **Note:** a list item keeps its bullet",
	"list items are not converted"
);
eq(
	conv("**Address:** 123 Main St"),
	"**Address:** 123 Main St",
	"a label that is not a callout type stays put"
);
eq(
	conv("**Example**: _pg_dump -U postgres_\n\n**Note:** and a second one"),
	"> [!example] 🧪 _pg_dump -U postgres_\n\n> [!note] 📝 and a second one",
	"several lead-ins in one note all convert"
);
eq(
	conv("**Note: You should never enter custom PHP here.**"),
	"**Note: You should never enter custom PHP here.**",
	"a whole-line bold sentence is not a lead-in"
);
eq(
	conv("**IMPORTANT:** Remove your spending limit indefinitely."),
	"> [!warning] ⚠️ Remove your spending limit indefinitely.",
	"'IMPORTANT' converts to a warning"
);

// --- tabs parsing ---
import { parseTabs } from "./blocks";
eq(
	parseTabs("--- Tab 1\nhello\n--- Tab 2\nworld"),
	[
		{ title: "Tab 1", body: "hello" },
		{ title: "Tab 2", body: "world" },
	],
	"panes split on --- markers"
);
eq(parseTabs("plain text only"), [{ title: "Tab 1", body: "plain text only" }], "markerless content becomes Tab 1");
eq(parseTabs("--- Only\n"), [{ title: "Only", body: "" }], "an empty pane survives");

// --- columns parsing ---
import { parseColumns } from "./blocks";
eq(
	parseColumns("left stuff\n---\nright stuff"),
	[
		{ ratio: 1, body: "left stuff" },
		{ ratio: 1, body: "right stuff" },
	],
	"columns split on bare --- lines"
);
eq(
	parseColumns("a\n--- 2\nb"),
	[
		{ ratio: 1, body: "a" },
		{ ratio: 2, body: "b" },
	],
	"a ratio marker widens its column"
);
eq(parseColumns("only one"), [{ ratio: 1, body: "only one" }], "no markers means one column");

import { columnsSnippet, serializeColumns } from "./blocks";
eq(
	serializeColumns([
		{ ratio: 1, body: "A" },
		{ ratio: 2, body: "B" },
	]),
	"A\n--- 2\nB",
	"columns serialize with a ratio marker"
);
eq(
	parseColumns(serializeColumns([
		{ ratio: 3, body: "wide" },
		{ ratio: 1, body: "narrow" },
	])).map((p) => Math.round(p.ratio * 100) / 100),
	[1, 0.33],
	"a resized first column round-trips as a normalized ratio"
);
eq(parseColumns(serializeColumns([{ ratio: 1, body: "" }, { ratio: 1, body: "B" }])).length, 2, "an empty first column survives the round-trip");
eq(parseColumns(columnsSnippet("two").replace(/```columns\n|\n```/g, "")).length, 2, "the two-column template makes two columns");
eq(parseColumns(columnsSnippet("three").replace(/```columns\n|\n```/g, "")).length, 3, "the three-column template makes three columns");
eq(parseColumns(columnsSnippet("sidebar-left").replace(/```columns\n|\n```/g, "")).map((p) => p.ratio), [1, 2], "sidebar-left is a narrow then wide column");
ok(columnsSnippet("two").startsWith("```columns"), "the snippet is a fenced columns block");

// --- callout emoji swap ---
import { setCalloutEmoji } from "./blocks";
eq(setCalloutEmoji("> [!question] ❓ Remember", "💡"), "> [!question] 💡 Remember", "swaps the leading emoji");
eq(setCalloutEmoji("> [!note] Plain title", "📝"), "> [!note] 📝 Plain title", "adds an emoji when there is none");
eq(setCalloutEmoji("not a callout", "💡"), null, "non-callout lines are untouched");

// --- toggle lists ---
eq(
	doc(transformBlock(L("Title\nfirst point\nsecond point"), { from: 0, to: 2 }, "toggleList")),
	"- Title\n    first point\n    second point",
	"a titled toggle list puts the title on the bullet and indents the rest"
);
eq(
	doc(transformBlock(L(BLOB), { from: 0, to: 0 }, "toggleList")),
	`- \n    ${BLOB}`,
	"a one-line blob leaves the bullet empty to type a title into"
);

// --- converting bullet lists (siblings ride along, bullets survive) ---
const FLAT = L("- Toggle List\n- second item\n\nafter");
eq(listStretchRange(FLAT, { from: 0, to: 0 }), { from: 0, to: 1 }, "a flat list stretches over its siblings");
eq(listStretchRange(FLAT, { from: 1, to: 1 }), { from: 0, to: 1 }, "stretching reaches siblings above the cursor too");
eq(listStretchRange(L("para\n- a\n    - a1\n- b\npara2"), { from: 3, to: 3 }), { from: 1, to: 3 }, "the stretch stops at non-list neighbors");
eq(listStretchRange(L("plain\ntext"), { from: 0, to: 1 }), { from: 0, to: 1 }, "non-list blocks never stretch");
eq(
	listStretchRange(L("- a\n    - a1\n\n    - a2\n- b"), { from: 4, to: 4 }),
	{ from: 0, to: 4 },
	"a blank between a sibling's children stays inside the stretch"
);
eq(
	doc(transformBlock(L("- Toggle List\n- second item"), { from: 0, to: 1 }, "toggleList")),
	"- Toggle List\n    - second item",
	"a flat list becomes a title with nested child bullets"
);
eq(
	doc(transformBlock(L("- title\n    - child"), { from: 0, to: 1 }, "toggleList")),
	"- title\n    - child",
	"an already-toggle-shaped list converts in place unchanged"
);
eq(
	doc(transformBlock(L("- T\n    - tc\n- S\n    - sc"), { from: 0, to: 3 }, "toggleList")),
	"- T\n    - tc\n    - S\n        - sc",
	"siblings shift a level deeper while the title keeps its own children"
);
eq(
	doc(transformBlock(L("- top\n    - a\n    - b"), { from: 1, to: 2 }, "toggleList")),
	"- top\n    - a\n        - b",
	"a nested list converts at its own indent, not column zero"
);
eq(doc(transformBlock(L("- lone"), { from: 0, to: 0 }, "toggleList")), "- lone", "a single short item titles an empty toggle, not a stray dash");
eq(
	doc(transformBlock(L("- Toggle Block\n- This doesn't toggle."), { from: 0, to: 1 }, "callout", { type: "toggle", folded: true })),
	"> [!toggle]- Toggle Block\n> - This doesn't toggle.",
	"a flat list folds whole into a toggle block, bullets intact"
);
eq(
	doc(transformBlock(L("- Toggle Block"), { from: 0, to: 0 }, "callout", { type: "toggle", folded: true })),
	"> [!toggle]- Toggle Block",
	"a single short line becomes the toggle block's title"
);
eq(
	doc(transformBlock(L("- T\n    - tc"), { from: 0, to: 1 }, "callout", { type: "toggle", folded: true })),
	"> [!toggle]- T\n> - tc",
	"the title's own children rise a level inside the callout"
);

// --- image embed editing ---
import { editEmbed, embedInfo, removeEmbed } from "./embed";
eq(editEmbed("see ![[pic.png|300]] here", "pic.png", { width: 500 }), "see ![[pic.png|500]] here", "width swap keeps the rest");
eq(editEmbed("![[pic.png|300]]", "pic.png", { width: null }), "![[pic.png]]", "width removal restores the bare embed");
eq(editEmbed("![[pic.png|300]]", "pic.png", { alt: "sunset" }), "![[pic.png|sunset|300]]", "alt slides in before the size");
eq(editEmbed("![[pic.png|sunset|300]]", "pic.png", { alt: null }), "![[pic.png|300]]", "alt removal keeps the size");
eq(editEmbed("![[old.png|cap|200]]", "old.png", { file: "new.png" }), "![[new.png|cap|200]]", "file swap keeps alias and size");
eq(editEmbed("![a|200](img.png)", "img.png", { alt: "b" }), "![b|200](img.png)", "md-form alt edit keeps size");
eq(editEmbed("![a](img.png)", "img.png", { width: 320 }), "![a|320](img.png)", "md-form width lands in the label");
eq(embedInfo("![[pic.png|sunset|300]]", "pic.png"), { alt: "sunset", width: 300, kind: "wiki" }, "embedInfo reads wiki parts");
eq(embedInfo("![cap|240](i.png)", "i.png"), { alt: "cap", width: 240, kind: "md" }, "embedInfo reads md parts");
eq(embedInfo("plain text", "x.png"), null, "embedInfo misses cleanly");
eq(removeEmbed("before ![[pic.png|300]] after", "pic.png"), "before after", "removeEmbed cuts the embed");
eq(removeEmbed("![[pic.png]]", "pic.png"), "", "a lone embed leaves an empty line");

// --- table snippets ---
eq(tableSnippet(2, 2), "|     |     |\n| --- | --- |\n|     |     |", "2x2 grid pick builds header + one body row");
eq(tableSnippet(1, 1).split("\n").length, 2, "1x1 is just a header and its separator");

// --- image embed resizing ---
eq(resizeEmbed("before ![[shot.png]] after", "shot.png", 320), "before ![[shot.png|320]] after", "wiki embeds gain a width");
eq(resizeEmbed("![[shot.png|640]]", "shot.png", 320), "![[shot.png|320]]", "an existing width is replaced");
eq(resizeEmbed("![[shot.png|640x480]]", "shot.png", 320), "![[shot.png|320]]", "WxH sizes are replaced with the new width");
eq(resizeEmbed("![[shot.png|my caption|640]]", "shot.png", 320), "![[shot.png|my caption|320]]", "captions survive a resize");
eq(resizeEmbed("![[Folder/shot.png]]", "shot.png", 200), "![[Folder/shot.png|200]]", "folder-prefixed targets still match by name");
eq(resizeEmbed("![[shot.png|640]]", "shot.png", null), "![[shot.png]]", "null width strips the size");
eq(resizeEmbed("![chart|500](https://x.dev/c.png)", "https://x.dev/c.png", 250), "![chart|250](https://x.dev/c.png)", "markdown image widths rewrite in the alt");
eq(resizeEmbed("![](https://x.dev/c.png)", "https://x.dev/c.png", 250), "![250](https://x.dev/c.png)", "alt-less markdown images take a bare width");
eq(resizeEmbed("no embeds here", "shot.png", 100), null, "lines without the embed return null");

// --- font size + scripts ---
eq(setFontSize("hello", "1.25em"), '<span style="font-size:1.25em">hello</span>', "font size wraps a span");
eq(setFontSize('<span style="font-size:0.85em">hello</span>', "1.6em"), '<span style="font-size:1.6em">hello</span>', "re-sizing replaces, never nests");
eq(setFontSize('<span style="font-size:1.6em">hello</span>', null), "hello", "Normal removes the wrapper");
eq(toggleScript("x2", "sup"), "<sup>x2</sup>", "superscript wraps");
eq(toggleScript("<sup>x2</sup>", "sup"), "x2", "superscript toggles back off");
eq(toggleScript("<sup>x2</sup>", "sub"), "<sub>x2</sub>", "sub replaces sup — they're exclusive");

// --- duplicate / delete / block ids ---
const DUP = duplicateBlock(L("para\n\nnext"), { from: 0, to: 0 });
eq(doc(DUP.lines), "para\n\npara\n\nnext", "duplicate copies with a gap");
eq(DUP.newStart, 2, "duplicate reports the copy's start");
eq(doc(duplicateBlock(L("- a\n- b"), { from: 0, to: 0 }).lines), "- a\n- a\n- b", "list duplicates glue");
eq(doc(deleteBlock(L("one\n\ntwo"), { from: 0, to: 0 })), "two", "delete swallows the trailing gap");
const BID = ensureBlockId(L("para here"), { from: 0, to: 0 }, "abc123");
eq(BID.lines[0], "para here ^abc123", "block ids append to prose");
eq(ensureBlockId(BID.lines, { from: 0, to: 0 }, "zzz").id, "abc123", "existing ids are reused");
eq(
	ensureBlockId(L("| a |\n| - |\n| 1 |"), { from: 0, to: 2 }, "t1").lines[3],
	"^t1",
	"tables take the id on a following line"
);

// --- format painter ---
const marks = detectMarks("**bold** and ==glow==");
ok(marks.bold && marks.highlight && !marks.strike, "marks detect from a styled selection");
ok(hasAnyMark(marks), "detected marks count as marks");
eq(applyMarks("plain", marks), "==**plain**==", "painting reapplies the captured marks");
eq(applyMarks("**already**", { bold: false, italic: false, underline: false, strike: false, highlight: false, color: "#f00" }), '<span style="color:#f00">already</span>', "painting strips before applying");

// --- wrapper context (painter on WYSIWYG selections) ---
const WLINE = 'plain <u>under</u> and <span style="color:#B42318">red text</span> and <mark style="background:#FDF3D7">glow</mark> end';
ok(wrapperAt(WLINE, 9, 14).underline, "selection inside <u> detects underline");
eq(wrapperAt(WLINE, 45, 48).color, "#B42318", "selection inside a color span detects the color");
ok(wrapperAt(WLINE, 90, 94).highlighted, "selection inside <mark> detects highlight");
ok(!wrapperAt(WLINE, 0, 5).underline && wrapperAt(WLINE, 0, 5).color === null, "plain selections detect nothing");

// --- link detection (Link dialog edit-in-place) ---
const LLINE = "see [docs](https://x.dev) and [[Team Reports|the report]] end";
eq(linkAt(LLINE, 8), { start: 4, end: 25, text: "docs", url: "https://x.dev", wiki: false }, "markdown link found under cursor");
eq(linkAt(LLINE, 35), { start: 30, end: 57, text: "the report", url: "Team Reports", wiki: true }, "wikilink with display text found");
eq(linkAt("[[Plain]]", 3), { start: 0, end: 9, text: "Plain", url: "Plain", wiki: true }, "bare wikilink uses target as text");
eq(linkAt(LLINE, 27), null, "cursor between links finds nothing");
eq(
	linkAt("see https://x.com/page now", 10),
	{ start: 4, end: 22, text: "", url: "https://x.com/page", wiki: false },
	"a bare URL under the cursor is a link too"
);
eq(
	linkAt("go https://x.com/a, then", 8),
	{ start: 3, end: 18, text: "", url: "https://x.com/a", wiki: false },
	"trailing sentence punctuation is not part of a bare URL"
);
eq(linkAt("see https://x.com", 2), null, "cursor before a bare URL finds nothing");
eq(
	linkAt("auto <https://x.com/a> link", 12),
	{ start: 5, end: 22, text: "", url: "https://x.com/a", wiki: false },
	"angle-bracket autolinks include their brackets in the range"
);
eq(linkAt("[t](https://x.com)", 8)?.text, "t", "a markdown link still wins over its own URL");

// --- alignment markers ---
eq(setAlign("hello", "center"), "hello<!--al:center-->", "center adds a marker");
eq(setAlign("hello<!--al:center-->", "right"), "hello<!--al:right-->", "changing alignment replaces the marker");
eq(setAlign("hello<!--al:right-->", "left"), "hello", "left removes the marker");
eq(alignOf("x<!--al:center-->"), "center", "alignment reads back");
eq(alignOf("plain"), "left", "no marker means left");

// --- dictation ---
const mp = buildMultipart({ model: "w3" }, "file", "d.webm", "audio/webm", new TextEncoder().encode("AUDIO").buffer as ArrayBuffer, "BB");
eq(mp.contentType, "multipart/form-data; boundary=BB", "multipart content type carries the boundary");
const mpText = new TextDecoder().decode(mp.body);
ok(
	mpText.includes('name="model"\r\n\r\nw3') && mpText.includes('filename="d.webm"') && mpText.includes("AUDIO") && mpText.endsWith("--BB--\r\n"),
	"multipart body has fields, file bytes, and the closing boundary"
);
eq(planDictationInsert("", "  Hello there. "), { atEnd: false, insert: "Hello there." }, "dictation onto an empty line inserts in place");
eq(planDictationInsert("existing text", "New thoughts."), { atEnd: true, insert: "\n\nNew thoughts." }, "dictation after a full line lands as a new block");

// --- paste cleaning ---
const dirty = '<html><!--[if mso]>junk<![endif]--><style>p{}</style><p class="MsoNormal" style="margin:0">Hello&nbsp;<o:p></o:p><b>world</b></p></html>';
const pre = preCleanHtml(dirty);
ok(!pre.includes("mso") && !pre.includes("<style>") && !pre.includes("o:p") && !pre.includes("class="), "word junk stripped");
ok(pre.includes("<b>world</b>"), "real formatting survives the pre-clean");

// --- pasted tables (ChatGPT, Claude, Grok, Word) ---
// Stands in for Obsidian's htmlToMarkdown, which is unavailable outside the app.
const asMd = (html: string) =>
	html
		.replace(/<\/(?:p|div|tr|li|h[1-6])>/gi, "\n")
		.replace(/<br\s*\/?>/gi, "\n")
		.replace(/<\/?(?:strong|b)>/gi, "**")
		.replace(/<[^>]+>/g, "")
		.replace(/\n{3,}/g, "\n\n")
		.trim();

// ChatGPT: a proper thead, so the header is obvious
eq(
	tableToMarkdown(
		"<table><thead><tr><th>Feature</th><th>Air 15</th></tr></thead><tbody><tr><td>Weight</td><td>3.3 lb</td></tr><tr><td>Cooling</td><td>Fanless</td></tr></tbody></table>",
		asMd
	),
	"| Feature | Air 15 |\n| --- | --- |\n| Weight | 3.3 lb |\n| Cooling | Fanless |",
	"a thead table converts row for row"
);
// Claude: no thead at all, row labels as <th> — the old path flattened this into one paragraph
eq(
	tableToMarkdown("<table><tbody><tr><td></td><td>Air 15</td><td>Pro 14</td></tr><tr><th>Chip</th><td>M5</td><td>M5 Pro</td></tr></tbody></table>", asMd),
	"|  | Air 15 | Pro 14 |\n| --- | --- | --- |\n| Chip | M5 | M5 Pro |",
	"a headerless table still gets its first row as the header"
);
// Grok: prose around the table, and formatting inside the cells
eq(
	cleanPastedHtml(
		'<html><body><p>Here they are.</p><div class="tbl"><table><tr><th>Size</th><th>Notes</th></tr><tr><td><strong>15.3"</strong></td><td>Two <b>ports</b></td></tr></table></div><p>Prices move.</p></body></html>',
		asMd
	),
	'Here they are.\n\n| Size | Notes |\n| --- | --- |\n| **15.3"** | Two **ports** |\n\nPrices move.',
	"text around a table survives and cell formatting is kept"
);
eq(
	tableToMarkdown("<table><tr><td>Battery</td><td>66.5Wh<br>15 hrs</td><td>a | b</td></tr></table>", asMd),
	"| Battery | 66.5Wh<br>15 hrs | a \\| b |\n| --- | --- | --- |",
	"a line break inside a cell folds to <br> and a literal pipe is escaped"
);
eq(
	tableToMarkdown('<table><tr><th colspan="2">Ports</th><th>Weight</th></tr><tr><td rowspan="2">Air</td><td>2x TB4</td><td>3.3 lb</td></tr><tr><td>MagSafe</td><td>3.4 lb</td></tr></table>', asMd),
	"| Ports |  | Weight |\n| --- | --- | --- |\n| Air | 2x TB4 | 3.3 lb |\n|  | MagSafe | 3.4 lb |",
	"spans pad instead of shifting the columns out of line"
);
eq(tableToMarkdown("<table><caption>Specs</caption><tr><td>a</td></tr></table>", asMd), "Specs\n\n| a |\n| --- |", "a caption becomes the line above the table");
eq(
	tableToMarkdown("<table><tr><td>outer</td><td><table><tr><td>inner</td></tr></table></td></tr></table>", asMd),
	"| outer | inner |\n| --- | --- |",
	"a nested table stays inside its cell instead of becoming rows"
);
eq(cleanPastedHtml("<p>no table here</p>", asMd), "no table here", "html without a table is left to htmlToMarkdown");
// Claude.ai copies its tables as tab-separated plain text, empty corner cell and all
eq(
	tabbedTextToMarkdown("\tAir 15\tPro 14\nChip\tM5\tM5 Pro\nWeight\t3.3 lb\t3.4 lb"),
	"|  | Air 15 | Pro 14 |\n| --- | --- | --- |\n| Chip | M5 | M5 Pro |\n| Weight | 3.3 lb | 3.4 lb |",
	"tab-separated rows rebuild into a table"
);
eq(tabbedTextToMarkdown("a\tb\nc\td\te"), null, "a ragged grid is left as text");
eq(tabbedTextToMarkdown("\tconst x = 1;\n\treturn x;"), null, "tab-indented code is not a table");
eq(tabbedTextToMarkdown("Air 15\tPro 14"), null, "a single line is not a table");
eq(tabbedTextToMarkdown("no tabs here\nnor here"), null, "untabbed prose is not a table");
eq(tabbedTextToMarkdown("a | b\tc\nd\te")?.split("\n")[0], "| a \\| b | c |", "a literal pipe in a tabbed cell is escaped");
ok(isOneMarkdownTable("| a | b |\n| --- | --- |\n| 1 | 2 |"), "one whole table is recognized as one table");
ok(!isOneMarkdownTable("| a | b |\n| --- | --- |\n\n| c | d |\n| --- | --- |"), "a run of one-row tables is not one table");
ok(!isOneMarkdownTable("Intro line\n\n| a |\n| --- |"), "a table with prose around it is not one table");
ok(!isOneMarkdownTable("| a | b |"), "a lone row is not a table");
ok(looksLikeMarkdownTable("| a | b |\n| --- | --- |\n| 1 | 2 |"), "a Markdown divider row is recognized");
ok(looksLikeMarkdownTable("|---|---|---|"), "a tight divider row is recognized too");
ok(!looksLikeMarkdownTable("a sentence with | a pipe\nand a --- rule"), "prose with a pipe is not a table");
eq(padPastedMarkdown("| a |\n| --- |", "Grok Paste:", ""), "\n\n| a |\n| --- |", "a table pasted onto a line of prose gets its own block");
eq(padPastedMarkdown("| a |\n| --- |", "", "trailing words"), "| a |\n| --- |\n\n", "text after the cursor is pushed clear of the table");
eq(padPastedMarkdown("plain words", "Grok Paste:", "more"), "plain words", "a non-table paste is inserted exactly as before");
eq(postCleanMarkdown("a  \n\n\n\nb c  "), "a\n\nb c", "markdown post-clean tidies blanks and nbsp");

// --- placeholder tags: <AppFeature> reads as an unclosed HTML tag, and from
// there Live Preview stops parsing Markdown for the rest of the note ---
eq(escapePlaceholderTags("a <AppFeature> b"), "a \\<AppFeature> b", "an unknown tag is escaped");
eq(escapePlaceholderTags("</AppFeature>"), "\\</AppFeature>", "a closing placeholder is escaped too");
eq(escapePlaceholderTags('<Foo bar="1">'), '\\<Foo bar="1">', "attributes do not make it real HTML");
eq(escapePlaceholderTags("\\<AppFeature>"), "\\<AppFeature>", "escaping an escaped tag is a no-op");
eq(escapePlaceholderTags('<mark style="background:#E2F5EA">x</mark>'), '<mark style="background:#E2F5EA">x</mark>', "the toolbar's own HTML is left alone");
eq(escapePlaceholderTags("<strong>a</strong> <br> <u>b</u> <SPAN>c</SPAN>"), "<strong>a</strong> <br> <u>b</u> <SPAN>c</SPAN>", "known tags survive, whatever their case");
eq(escapePlaceholderTags("`<AppFeature>`"), "`<AppFeature>`", "inline code is left alone");
eq(escapePlaceholderTags("```\n<AppFeature>\n```"), "```\n<AppFeature>\n```", "fenced code is left alone");
eq(escapePlaceholderTags("<https://example.com>"), "<https://example.com>", "an autolink is not a tag");
eq(escapePlaceholderTags("<!-- note -->"), "<!-- note -->", "comments are left alone");
eq(escapePlaceholderTags("a < b and c > d"), "a < b and c > d", "a bare comparison is not a tag");
eq(postCleanMarkdown("see <AppFeature> now"), "see \\<AppFeature> now", "the paste cleanup escapes placeholder tags");

// the sweep's preview and its rewrite must never disagree, so both read the
// same walk: whatever find reports is exactly what escape goes on to change
eq(findPlaceholderTags("a <AppFeature> b").length, 1, "a placeholder is found");
eq(findPlaceholderTags("a <AppFeature> b")[0].tag, "<AppFeature>", "the tag text comes back for the preview");
eq(findPlaceholderTags("x\ny\n<Foo> z")[0].line, 2, "the line number is zero-based and correct");
eq(findPlaceholderTags("<Foo> and <Bar>").length, 2, "two on one line are both found");
eq(findPlaceholderTags('<mark style="background:#fff">x</mark> <strong>y</strong>').length, 0, "real HTML is not reported");
eq(findPlaceholderTags("`<Foo>`\n```\n<Bar>\n```").length, 0, "code is not reported");
eq(findPlaceholderTags("\\<Foo>").length, 0, "an escaped tag is not reported again");
eq(findPlaceholderTags(escapePlaceholderTags("<Foo> <Bar>")).length, 0, "escaping clears everything the scan found");

// a link destination is not inline-parsed, so a placeholder there is already
// harmless — and escaping it would push backslashes into the URL
eq(findPlaceholderTags("[text](http://<WLED-IP>/json)").length, 0, "a placeholder in a link destination is not reported");
eq(escapePlaceholderTags("[text](http://<WLED-IP>/json)"), "[text](http://<WLED-IP>/json)", "a link destination is never rewritten");
eq(escapePlaceholderTags("[a <Foo> b](http://x/<Bar>)"), "[a \\<Foo> b](http://x/<Bar>)", "link text is still escaped while its destination is left alone");
eq(escapePlaceholderTags("<Foo> [t](u) <Bar>"), "\\<Foo> [t](u) \\<Bar>", "text on both sides of a link is still escaped");

// --- to-dos: parsing, completing, recurrence ---
const T1 = parseTodo("- [ ] Rotate tires 🔁 every 6 months 📅 2026-08-01");
eq(T1?.body, "Rotate tires", "todo body drops the metadata tokens");
eq(T1?.due, "2026-08-01", "due date parses");
eq(T1?.recurrence, "every 6 months", "recurrence rule parses");
eq(T1?.checked, false, "unchecked state parses");
eq(parseTodo("plain prose line"), null, "prose is not a todo");
eq(parseTodo("- regular bullet"), null, "a bullet without a checkbox is not a todo");
eq(parseTodo("  - [x] done thing ✅ 2026-07-01")?.doneDate, "2026-07-01", "done date parses");
eq(parseTodo("- [ ] urgent ⏫")?.priority, 1, "priority emoji parses");
eq(
	parseTodo("- [ ] Oil the workbench 🔁 every 2 weeks #shop"),
	{ indent: "", marker: "-", checked: false, body: "Oil the workbench #shop", priority: 3, recurrence: "every 2 weeks" },
	"a tag after the recurrence belongs to the body, not the rule"
);
eq(
	formatTodo(parseTodo("- [ ] t ✅ 2026-01-01 📅 2026-01-02 🔁 every day")!),
	"- [ ] t 🔁 every day 📅 2026-01-02 ✅ 2026-01-01",
	"reserializing puts tokens in canonical order"
);

eq(
	toggleTodo("- [ ] Call Bob 📅 2026-07-11", "2026-07-11", true),
	{ line: "- [x] Call Bob 📅 2026-07-11 ✅ 2026-07-11", spawned: null },
	"completing stamps the done date"
);
eq(
	toggleTodo("- [x] Call Bob 📅 2026-07-11 ✅ 2026-07-11", "2026-07-12", true),
	{ line: "- [ ] Call Bob 📅 2026-07-11", spawned: null },
	"unchecking removes the stamp"
);
eq(
	toggleTodo("- [ ] Call Bob", "2026-07-11", false),
	{ line: "- [x] Call Bob", spawned: null },
	"stamping can be turned off"
);
eq(
	toggleTodo("- [ ] Rotate tires 🔁 every 6 months 📅 2026-01-31", "2026-07-11", true),
	{
		line: "- [x] Rotate tires 🔁 every 6 months 📅 2026-01-31 ✅ 2026-07-11",
		spawned: "- [ ] Rotate tires 🔁 every 6 months 📅 2026-07-31",
	},
	"completing a recurring todo spawns the next occurrence"
);
eq(
	toggleTodo("- [ ] Backup 🔁 every month 📅 2026-08-31", "2026-08-31", true)?.spawned,
	"- [ ] Backup 🔁 every month 📅 2026-09-30",
	"month arithmetic clamps to the shorter month"
);
eq(
	toggleTodo("- [ ] Water plants 🔁 every week when done 📅 2026-07-01", "2026-07-11", true)?.spawned,
	"- [ ] Water plants 🔁 every week when done 📅 2026-07-18",
	"'when done' recurs from the completion day"
);
eq(
	toggleTodo("- [ ] Standup notes 🔁 every monday 📅 2026-07-09", "2026-07-09", true)?.spawned,
	"- [ ] Standup notes 🔁 every monday 📅 2026-07-13",
	"weekday rules land on the next such weekday"
);
eq(
	toggleTodo("- [ ] Oil the bench 🔁 every 2 weeks", "2026-07-11", true)?.spawned,
	"- [ ] Oil the bench 🔁 every 2 weeks 📅 2026-07-25",
	"a dateless recurring todo recurs from today and gains a due date"
);

// --- to-dos: the query language ---
const todoAt = (line: string, path: string) => ({ ...parseTodo(line)!, path, line: 0 });
const ITEMS = [
	todoAt("- [ ] Pay dues 📅 2026-07-10", "Acme/Admin.md"),
	todoAt("- [ ] Rotate tires 🔁 every 6 months 📅 2026-07-20", "Personal/Cars/X3.md"),
	todoAt("- [x] Old thing 📅 2026-06-01 ✅ 2026-06-01", "Personal/Cars/X3.md"),
	todoAt("- [ ] Sand doors", "Personal/Woodworking.md"),
];
const bodies = (groups: { items: { body: string }[] }[]) => groups.flatMap((g) => g.items).map((t) => t.body);

const q1 = parseQuery("not done\ndue before 2026-07-15");
eq(q1.errors, [], "a clean query parses without errors");
eq(bodies(runQuery(q1.query, ITEMS, "2026-07-11")), ["Pay dues"], "date filters narrow the list");
eq(bodies(runQuery(parseQuery("overdue").query, ITEMS, "2026-07-11")), ["Pay dues"], "overdue means unfinished and past due");
eq(bodies(runQuery(parseQuery("is recurring").query, ITEMS, "2026-07-11")), ["Rotate tires"], "recurrence filters work");
eq(
	bodies(runQuery(parseQuery("not done\nsort by due").query, ITEMS, "2026-07-11")),
	["Pay dues", "Rotate tires", "Sand doors"],
	"due sort puts dateless items last"
);
eq(bodies(runQuery(parseQuery("not done\nlimit 1").query, ITEMS, "2026-07-11")), ["Pay dues"], "limit caps the total");
const g1 = runQuery(parseQuery("not done\npath includes Personal\ngroup by file").query, ITEMS, "2026-07-11");
eq(
	g1.map((g) => g.heading),
	["Personal/Cars/X3", "Personal/Woodworking"],
	"file grouping headings are the path without extension"
);
eq(parseQuery("frobnicate the list").errors.length, 1, "unknown filter lines are reported, not ignored");
eq(bodies(runQuery(parseQuery("done").query, ITEMS, "2026-07-11")), ["Old thing"], "done filter finds completed items");

// --- to-dos: extended recurrence grammar ---
eq(
	toggleTodo("- [ ] Timesheet 🔁 every weekday 📅 2026-07-10", "2026-07-10", false)?.spawned,
	"- [ ] Timesheet 🔁 every weekday 📅 2026-07-13",
	"every weekday skips the weekend"
);
eq(
	toggleTodo("- [ ] Gym 🔁 every mon, wed, fri 📅 2026-07-08", "2026-07-08", false)?.spawned,
	"- [ ] Gym 🔁 every mon, wed, fri 📅 2026-07-10",
	"weekday lists pick the next listed day"
);
eq(
	toggleTodo("- [ ] Rent 🔁 every month on the 15th 📅 2026-07-15", "2026-07-15", false)?.spawned,
	"- [ ] Rent 🔁 every month on the 15th 📅 2026-08-15",
	"day-of-month rules stay on their day"
);
eq(
	toggleTodo("- [ ] Invoices 🔁 every month on the 31st 📅 2026-01-31", "2026-01-31", false)?.spawned,
	"- [ ] Invoices 🔁 every month on the 31st 📅 2026-02-28",
	"day-of-month rules clamp short months"
);
eq(
	toggleTodo("- [ ] Retro 🔁 every last friday 📅 2026-07-31", "2026-07-31", false)?.spawned,
	"- [ ] Retro 🔁 every last friday 📅 2026-08-28",
	"'every last friday' finds next month's last friday"
);

// --- to-dos: query additions ---
const ITEMS2 = [
	todoAt("- [ ] Fix brakes #car 📅 2026-07-12", "Personal/Cars/X3.md"),
	todoAt("- [ ] Wash car mats", "Personal/Cars/X3.md"),
	todoAt("- [ ] Order carbide blades ⏫", "Personal/Woodworking.md"),
	todoAt("- [x] Old carwash ✅ 2026-06-01", "Personal/Cars/X3.md"),
];
eq(bodies(runQuery(parseQuery("tag includes #car").query, ITEMS2, "2026-07-11")), ["Fix brakes #car"], "tag filter respects word boundaries");
eq(bodies(runQuery(parseQuery("hide done").query, ITEMS2, "2026-07-11")).length, 3, "hide done is a not-done alias");
eq(
	runQuery(parseQuery("not done\ngroup by priority").query, ITEMS2, "2026-07-11").map((g) => g.heading),
	["High", "Normal"],
	"priority groups are named and ordered by urgency"
);
eq(
	bodies(runQuery(parseQuery("not done\nsort by due desc").query, ITEMS, "2026-07-11")),
	["Sand doors", "Rotate tires", "Pay dues"],
	"desc reverses the primary sort"
);
eq(parseQuery("view week").query.view, "week", "the week view directive parses");
eq(parseQuery("done").query.view, "list", "list view is the default");

eq(setDueDate("- [ ] x 📅 2026-07-10", "2026-07-15"), "- [ ] x 📅 2026-07-15", "snooze replaces the due date");
eq(setDueDate("- [ ] x", "2026-07-15"), "- [ ] x 📅 2026-07-15", "snooze adds a due date when missing");
eq(setDueDate("- [ ] x 📅 2026-07-10 ✅ 2026-01-01", null), "- [ ] x ✅ 2026-01-01", "a null due date removes the token");
eq(setDueDate("plain prose", "2026-07-15"), null, "snooze refuses non-todo lines");

// --- to-dos: natural-language quick capture ---
// 2026-07-11 is a Saturday.
eq(parseDatePhrase("tomorrow", "2026-07-11"), "2026-07-12", "tomorrow resolves");
eq(parseDatePhrase("friday", "2026-07-11"), "2026-07-17", "bare weekdays find the next occurrence");
eq(parseDatePhrase("next friday", "2026-07-11"), "2026-07-24", "'next' pushes a week past the coming one");
eq(parseDatePhrase("in 3 days", "2026-07-11"), "2026-07-14", "relative day offsets resolve");
eq(parseDatePhrase("aug 1", "2026-07-11"), "2026-08-01", "month-name dates resolve");
eq(parseDatePhrase("aug 1", "2026-09-01"), "2027-08-01", "past month-name dates roll to next year");
eq(parseDatePhrase("august 1st", "2026-07-11"), "2026-08-01", "full month names and ordinals parse");
eq(parseDatePhrase("2026-09-03", "2026-07-11"), "2026-09-03", "ISO dates pass through");
eq(parseDatePhrase("garbage", "2026-07-11"), null, "nonsense is rejected, not guessed");

eq(
	parseQuickTodo("rotate tires every 6 months starting aug 1", "2026-07-11"),
	{ body: "rotate tires", due: "2026-08-01", recurrence: "every 6 months" },
	"capture splits body, recurrence, and start date"
);
eq(parseQuickTodo("call bob tomorrow", "2026-07-11"), { body: "call bob", due: "2026-07-12" }, "trailing bare dates parse");
eq(parseQuickTodo("pay dues by friday", "2026-07-11"), { body: "pay dues", due: "2026-07-17" }, "'by' introduces the due date");
eq(parseQuickTodo("water plants every week", "2026-07-11"), { body: "water plants", recurrence: "every week" }, "recurrence without a date stays dateless");
eq(parseQuickTodo("sharpen chisels", "2026-07-11"), { body: "sharpen chisels" }, "plain text is just a body");
eq(
	parseQuickTodo("timesheet every weekday", "2026-07-11"),
	{ body: "timesheet", recurrence: "every weekday" },
	"extended recurrence forms survive capture"
);

// --- headings: empty-line placeholder label ---
eq(emptyHeadingLabel("# "), "Heading 1", "an empty H1 gets a label");
eq(emptyHeadingLabel("#"), "Heading 1", "a bare hash with no space still labels");
eq(emptyHeadingLabel("###   "), "Heading 3", "trailing spaces don't hide an empty heading");
eq(emptyHeadingLabel("> ## "), "Heading 2", "a heading inside a quote still labels");
eq(emptyHeadingLabel("## Steve"), null, "a heading with text has no placeholder");
eq(emptyHeadingLabel("plain"), null, "a non-heading line has no placeholder");
eq(emptyHeadingLabel(""), null, "a blank line is not an empty heading");

// --- editable tabs: serialize round-trips with parse ---
eq(
	serializeTabs([{ title: "Tab 1", body: "hello" }, { title: "Tab 2", body: "" }]),
	"--- Tab 1\nhello\n--- Tab 2",
	"panes serialize with their markers; empty bodies collapse"
);
eq(
	serializeTabs([{ title: "A", body: "line1\nline2" }, { title: "B", body: "x" }]),
	"--- A\nline1\nline2\n--- B\nx",
	"multi-line bodies survive"
);
{
	const panes = [{ title: "First", body: "**bold** text" }, { title: "Second", body: "- a\n- b" }, { title: "Third", body: "" }];
	eq(parseTabs(serializeTabs(panes)), panes, "parse(serialize(panes)) is identity");
}

// --- selection expansion over hidden style markers ---
// "==Use the==" : selecting the visible "Use the" (2..9) must swallow the == pairs
eq(expandStyleRange("==Use the==", 2, 9), { from: 0, to: 11 }, "a selection inside ==…== expands to the whole span");
eq(expandStyleRange("plain text", 2, 7), { from: 2, to: 7 }, "plain text is left alone");
eq(expandStyleRange("==a== mid ==b==", 2, 13), { from: 0, to: 15 }, "endpoints in different spans expand both ways");
eq(expandStyleRange("==ab==", 0, 6), { from: 0, to: 6 }, "a selection already covering the span stays put");
{
	const line = '<mark style="background:#FDF3D7">warm</mark> rest';
	eq(expandStyleRange(line, 33, 37), { from: 0, to: 44 }, "a selection inside a mark wrapper expands to the tags");
}
{
	const line = 'x <span style="color:#B42318">red</span> y';
	eq(expandStyleRange(line, 30, 33), { from: 2, to: 40 }, "color spans expand too");
}
eq(expandStyleRange("==Use the== **bold** ==skill on==", 5, 26), { from: 0, to: 33 }, "a selection bridging two highlights swallows both");
// highlighting a bold word must swallow the ** so the mark wraps around it
eq(expandStyleRange("Use the **demo** skill", 10, 14), { from: 8, to: 16 }, "selecting inside **bold** expands over the ** markers");
eq(expandStyleRange("a *it* b", 3, 5), { from: 2, to: 6 }, "*italic* expands too");
eq(expandStyleRange("a ~~st~~ b", 4, 6), { from: 2, to: 8 }, "~~strike~~ expands too");
eq(expandStyleRange("code x ** y ** z", 0, 4), { from: 0, to: 4 }, "spaced ** that is not a bold pair leaves a plain selection alone");

// --- vault-wide highlight sweep ---
eq(sweepHighlights("a ==b== c", null), { text: "a b c", count: 1 }, "removing strips rendered pairs");
eq(sweepHighlights("state →== useEditableRecord", null), { text: "state → useEditableRecord", count: 1 }, "symbol-adjacent litter is removed");
eq(
	sweepHighlights("A ==(cheapest, highest behavior-change).== B", null),
	{ text: "A (cheapest, highest behavior-change). B", count: 1 },
	"pairs wrapping parentheticals render yellow, so they go"
);
eq(
	sweepHighlights("==x== and ==y==", "#E2F5EA"),
	{ text: '<mark style="background:#E2F5EA">x</mark> and <mark style="background:#E2F5EA">y</mark>', count: 2 },
	"converting wraps each span in a colored mark"
);
eq(
	sweepHighlights("keep\n```\n==code== stays\n```\n==prose== goes", null),
	{ text: "keep\n```\n==code== stays\n```\nprose goes", count: 1 },
	"fenced code blocks are left alone"
);
eq(sweepHighlights("`==inline== code` and ==real==", null), { text: "`==inline== code` and real", count: 1 }, "inline code is left alone");
eq(sweepHighlights("nothing here", null), { text: "nothing here", count: 0 }, "clean text reports zero");
eq(sweepHighlights("====\nsetext\n====", null).count, 0, "bare = runs are not highlights");
eq(sweepHighlights("stray== in the middle", null), { text: "stray in the middle", count: 1 }, "unbalanced == tokens are removed too");
eq(sweepHighlights("the== UX reference.==", null).text, "the UX reference.", "import litter pairs and strays all come out");
eq(sweepHighlights("a== b\nc ==d", null), { text: "a b\nc d", count: 2 }, "one stray per line, both removed");
eq(sweepHighlights("===keep===", null), { text: "===keep===", count: 0 }, "longer = runs are never touched, even partially");
eq(sweepHighlights("x === y", null).count, 0, "triple equals in prose survives");
// technical prose must survive: only FLUSH pairs are highlights (Obsidian's
// own rule), and spaced/bracketed/negated tokens are operators, not junk
eq(sweepHighlights("If (x == y) && (a == b)", null).count, 0, "spaced equality operators survive");
eq(sweepHighlights("x == y or a == b", null).count, 0, "spaced tokens never pair into a bogus highlight");
eq(sweepHighlights("Equality: == (loose-equals), as in a == b", null).count, 0, "operator lists survive");
eq(sweepHighlights("uses 2 equal (==) signs, and !== stays", null).count, 0, "parenthesized and negated forms survive");
eq(sweepHighlights("|==|Means equal|", null).count, 0, "operator table cells survive");
eq(sweepHighlights("message = (x == 2) ? \"Car\" : \"Boat\";", null).count, 0, "inline code-ish prose survives");
eq(sweepHighlights("like Assignment =, Equality ==, and others", null).count, 0, "an operator followed by a comma survives");
eq(
	sweepHighlights("rebuild it on ActionBar====. The prototype", null),
	{ text: "rebuild it on ActionBar. The prototype", count: 1 },
	"adjacent-boundary ==== runs embedded in text are junk"
);
eq(sweepHighlights("(====screen-editability.md spells it out)", null).text, "(screen-editability.md spells it out)", "==== hugging a bracket goes too");
eq(sweepHighlights("~~~\n==x==\n~~~\ndone ==y==", null), { text: "~~~\n==x==\n~~~\ndone y", count: 1 }, "tilde fences count too");

// --- list continuation in the tab edit box ---
eq(continueList("1. hi"), { insert: "\n2. " }, "Enter after a numbered item continues it");
eq(continueList("  3) x"), { insert: "\n  4) " }, "delimiter and indent carry, number increments");
eq(continueList("1. "), { clear: "" }, "Enter on an empty numbered item ends the list");
eq(continueList("\t- a"), { insert: "\n\t- " }, "bullets continue with their indent");
eq(continueList("- "), { clear: "" }, "an empty bullet ends the list");
eq(continueList("plain text"), null, "non-list lines do nothing");

// --- ordered-list outline numbering (Word-style) ---
eq(formatCounter(1, "decimal"), "1", "decimal is just the number");
eq(formatCounter(1, "lower-alpha"), "a", "1 -> a");
eq(formatCounter(26, "lower-alpha"), "z", "26 -> z");
eq(formatCounter(27, "lower-alpha"), "aa", "27 -> aa (bijective base-26)");
eq(formatCounter(2, "upper-alpha"), "B", "upper-alpha capitalizes");
eq(formatCounter(1, "lower-roman"), "i", "1 -> i");
eq(formatCounter(4, "lower-roman"), "iv", "4 -> iv");
eq(formatCounter(9, "lower-roman"), "ix", "9 -> ix");
eq(formatCounter(14, "lower-roman"), "xiv", "14 -> xiv");
eq(formatCounter(3, "upper-roman"), "III", "upper-roman capitalizes");
eq(formatCounter(0, "lower-alpha"), "0", "non-positive falls back to the number");

eq(orderedListInfo("1. wef"), { indent: "", depth: 0, ordinal: 1, numStart: 0, numEnd: 1, delim: "." }, "top-level ordered item parses");
eq(orderedListInfo("\t\t2) sdg"), { indent: "\t\t", depth: 2, ordinal: 2, numStart: 2, numEnd: 3, delim: ")" }, "tab-indented item reports depth and marker range");
eq(orderedListInfo("    3. x")?.depth, 1, "four spaces is one level deep");
eq(orderedListInfo("- bullet"), null, "bullets are not ordered items");
eq(orderedListInfo("plain text"), null, "prose is not an ordered item");
eq(orderedListInfo("12. many")?.numEnd, 2, "multi-digit numbers report the right marker end");

// --- headings: cursor can't land before the hidden marker ---
eq(headingCursorSnap("# ", 0), 2, "an empty heading snaps the caret past its hidden marker");
eq(headingCursorSnap("# ", 1), 2, "mid-marker also snaps out");
eq(headingCursorSnap("# ", 2), null, "a caret already past the marker stays put");
eq(headingCursorSnap("# Header", 0), 2, "clicking before a heading's text snaps past the hashes");
eq(headingCursorSnap("# Header", 5), null, "a caret inside the text is left alone");
eq(headingCursorSnap("### x", 1), 4, "deeper headings snap past all their hashes");
eq(headingCursorSnap("#Header", 0), null, "no space after # is not a heading, no snap");
eq(headingCursorSnap("plain", 0), null, "plain lines never snap");

// --- blocks: whole-block color (Notion-style) ---
eq(colorBlockLine("# Heading 1", "text", "#0B6BCB"), '# <span style="color:#0B6BCB">Heading 1</span>', "coloring a heading wraps its text, keeps the hashes");
eq(
	colorBlockLine('# <span style="color:#000000">Heading 1</span>', "text", "#B42318"),
	'# <span style="color:#B42318">Heading 1</span>',
	"recoloring replaces the old color rather than nesting"
);
eq(colorBlockLine("# Heading 1", "text", null), "# Heading 1", "clearing a heading's color strips the span");
eq(colorBlockLine("## ", "text", "#0B6BCB"), "## ", "an empty heading has nothing to color");
eq(colorBlockLine("- item", "hl", "#FDF3D7"), '- <mark style="background:#FDF3D7">item</mark>', "background color wraps a list item's text in a mark");
eq(colorBlockLine("1. step", "text", "#1E8553"), '1. <span style="color:#1E8553">step</span>', "numbered items keep their marker");
eq(colorBlockLine("- [ ] task", "text", "#1E8553"), '- [ ] <span style="color:#1E8553">task</span>', "checklist items keep their box");
eq(colorBlockLine("plain para", "text", "#6D28D9"), '<span style="color:#6D28D9">plain para</span>', "a bare paragraph colors whole");
eq(colorBlockLine("> quote", "text", "#C2410C"), '> <span style="color:#C2410C">quote</span>', "quotes keep their marker");

// --- page features: covers ---
eq(parseCover({ cover: "gradient:2" }), { kind: "gradient", value: "gradient:2", y: 50, height: "standard" }, "gradient covers parse");
eq(parseCover({ cover: "https://x/y.jpg", "cover-y": 30 }), { kind: "url", value: "https://x/y.jpg", y: 30, height: "standard" }, "url covers keep their position");
eq(parseCover({ cover: "[[Pics/banner.png]]" }), { kind: "path", value: "Pics/banner.png", y: 50, height: "standard" }, "wikilink covers resolve to their target");
eq(parseCover({ cover: "Pics/banner.png", "cover-y": 200 })?.y, 100, "cover position clamps to 0-100");
eq(parseCover({ cover: "solid:#E8F5E9" }), { kind: "solid", value: "#E8F5E9", y: 50, height: "standard" }, "solid: tokens parse to a solid color");
eq(parseCover({ cover: "#abc" })?.kind, "solid", "a bare hex is a solid color cover");
eq(parseCover({ cover: "gradient:1", "cover-h": "tall" })?.height, "tall", "cover-h sets the banner height");
eq(parseCover({ cover: "gradient:1", "cover-h": "nonsense" })?.height, "standard", "an unknown cover-h falls back to standard");
eq(parseCover({}), null, "no cover property, no cover");
eq(parseCover(undefined), null, "missing frontmatter, no cover");

eq(parsePageLayout({ "full-width": true }).fullWidth, true, "full-width flag reads");
eq(parsePageLayout({ font: "serif" }).font, "serif", "serif font reads");
eq(parsePageLayout({ font: "monospace" }).font, "mono", "monospace normalizes to mono");
eq(parsePageLayout({ "cover-overlay": true }).overlayTitle, true, "cover-overlay floats the title");
eq(parsePageLayout({}), { fullWidth: false, font: null, overlayTitle: false }, "page layout defaults are plain");
ok(GRADIENTS.length >= 6, "a real gradient gallery ships");
ok(gradientCss("gradient:1") != null, "gradient tokens map to css");
eq(gradientCss("gradient:" + (GRADIENTS.length + 1)), gradientCss("gradient:1"), "gradient indexes wrap around");
eq(gradientCss("nope"), null, "non-gradient values yield no css");

// --- page features: comments ---
eq(makeComment("check this", "2026-07-12"), "%%💬 check this · 2026-07-12%%", "comments serialize with a date stamp");
const CL = [
	"intro",
	"some text %%💬 needs source · 2026-07-11%% more",
	"plain",
	"two %%💬 a · 2026-07-10%% and %%💬 b%%",
];
const CS = parseComments(CL);
eq(CS.length, 3, "every comment marker is found");
eq(CS[0], { line: 1, ch: 10, text: "needs source", stamp: "2026-07-11" }, "comment position, text, and stamp parse");
eq(CS[2].stamp, null, "an unstamped comment still parses");
eq(
	replaceCommentText("%%💬 old words · 2026-07-10%%", "new words", "2026-07-12"),
	"%%💬 new words · 2026-07-12%%",
	"editing a comment rewrites text and restamps"
);

// --- page features: verification ---
eq(verificationState({ verified: "2026-07-01" }, "2026-07-12"), { state: "verified", since: "2026-07-01", until: null }, "a verified page with no expiry stays verified");
eq(
	verificationState({ verified: "2026-07-01", "verified-until": "2027-01-01" }, "2026-07-12"),
	{ state: "verified", since: "2026-07-01", until: "2027-01-01" },
	"future expiry keeps the badge"
);
eq(
	verificationState({ verified: "2026-07-01", "verified-until": "2026-07-10" }, "2026-07-12"),
	{ state: "expired", since: "2026-07-01", until: "2026-07-10" },
	"past expiry flips to expired"
);
eq(verificationState({}, "2026-07-12"), { state: "none" }, "unverified pages report none");
eq(verificationState(undefined, "2026-07-12"), { state: "none" }, "missing frontmatter reports none");

// --- page features: icons ---
eq(parseIcon({ icon: "🚗" }), "🚗", "page icons parse");
eq(parseIcon({ icon: "  🛠️  " }), "🛠️", "icons trim whitespace");
eq(parseIcon({}), null, "no icon property, no icon");
eq(parseIcon({ icon: 42 }), null, "non-string icons are rejected");

// --- to-dos: time of day, priority edits, archiving ---
eq(parseTodo("- [ ] Call at two ⏰ 14:00 📅 2026-07-14")?.time, "14:00", "time-of-day parses");
eq(formatTodo(parseTodo("- [ ] x 📅 2026-07-14 ⏰ 09:30")!), "- [ ] x ⏰ 09:30 📅 2026-07-14", "time rides in canonical order");
eq(setPriority("- [ ] x 📅 2026-07-14", 1), "- [ ] x ⏫ 📅 2026-07-14", "setting a priority inserts its arrow");
eq(setPriority("- [ ] x ⏫", 3), "- [ ] x", "priority none removes the arrow");
eq(setPriority("plain prose", 1), null, "non-todos refuse a priority");
eq(parseQuery("view board").query.view, "board", "the board view directive parses");

const ARCH = L(
	"# Note\n\n- [x] old chore ✅ 2026-07-01\n- [ ] live one\n- [x] parent done ✅ 2026-07-02\n    - note under it\n- [x] keeps open child ✅ 2026-07-03\n    - [ ] still open\n\ntail"
);
const arch = archiveCompleted(ARCH);
eq(arch.moved, 2, "completed items archive; ones sheltering open children stay");
eq(
	doc(arch.lines),
	"# Note\n\n- [ ] live one\n- [x] keeps open child ✅ 2026-07-03\n    - [ ] still open\n\ntail\n\n## Done\n\n- [x] old chore ✅ 2026-07-01\n- [x] parent done ✅ 2026-07-02\n    - note under it",
	"archived items land under a Done heading, children in tow"
);
eq(archiveCompleted(arch.lines).moved, 0, "items already under Done stay put");
const withNew = [...arch.lines];
withNew.splice(withNew.indexOf("## Done"), 0, "- [x] another ✅ 2026-07-05", "");
const arch2 = archiveCompleted(withNew);
eq(arch2.moved, 1, "a later completion archives into the existing section");
eq(doc(arch2.lines).endsWith("- [x] parent done ✅ 2026-07-02\n    - note under it\n- [x] another ✅ 2026-07-05"), true, "existing Done sections append rather than duplicate");

// --- mergeForSave: data.json is synced, so a save must not clobber a device ---
{
	// A device holding an old snapshot changes one thing. Its save must not carry
	// the rest of that snapshot over what another device set since. A setting
	// nothing rewrites afterwards never comes back from that.
	const idleBaseline = { anthropicKey: "", lastTab: "old" };
	const idleMemory = { anthropicKey: "", lastTab: "new" };
	const disk = { anthropicKey: "sk-ant-real", lastTab: "old" };
	eq(
		mergeForSave(idleMemory, idleBaseline, disk),
		{ anthropicKey: "sk-ant-real", lastTab: "new" },
		"an idle device keeps another device's key and carries only its own change"
	);
}
eq(mergeForSave({ k: "new" }, { k: "old" }, { k: "other" }), { k: "new" }, "our own change still wins over disk");
eq(mergeForSave({ k: "" }, { k: "had" }, { k: "had" }), { k: "" }, "clearing on purpose is a change and sticks");
eq(mergeForSave({ k: "ours", n: 1 } as { k?: string; n: number }, { k: "ours", n: 1 } as { k?: string; n: number }, { n: 2 }), { k: "ours", n: 2 }, "a key absent from disk keeps ours");
eq(mergeForSave({ k: 1 }, { k: 1 }, null), { k: 1 }, "no disk state yet = write ours");

{
	// A key holding one value per item is a whole vault's worth of settings behind
	// a single name. Changing ONE of them used to publish ALL of them, erasing
	// every item another device had configured since this one last read.
	type M = { map: Record<string, number[]> };
	const baseline: M = { map: { A: [1] } };
	const ours: M = { map: { A: [2] } };
	const disk: M = { map: { A: [1], B: [9] } };
	eq(mergeForSave(ours, baseline, disk), { map: { A: [2], B: [9] } }, "one entry's change publishes that entry, not the whole map");
	eq(mergeForSave({ map: { A: [1] } } as M, { map: { A: [1], B: [9] } } as M, { map: { A: [1], B: [9] } } as M), { map: { A: [1] } }, "an entry we removed stays removed");
	eq(mergeForSave({ map: { A: [1] } } as M, { map: { A: [1] } } as M, { map: { A: [7] } } as M), { map: { A: [7] } }, "an entry we did not touch takes the disk's");
	eq(mergeForSave({ list: ["a"] }, { list: ["a", "b"] }, { list: ["a", "b"] }), { list: ["a"] }, "an array is a value, still merged whole");
}

// --- last-edited stamp ---
const NOW = Date.UTC(2026, 6, 26, 12, 0, 0);
const ago = (ms: number) => relativeEdited(NOW - ms, NOW);
eq(ago(5_000), "just now", "seconds old reads as just now");
eq(ago(60_000), "a minute ago", "a minute is spelled out");
eq(ago(20 * 60_000), "20 minutes ago", "minutes round");
eq(ago(90 * 60_000), "an hour ago", "an hour is spelled out");
eq(ago(5 * 3_600_000), "5 hours ago", "hours round");
eq(ago(30 * 3_600_000), "yesterday", "just over a day reads as yesterday");
eq(ago(5 * 86_400_000), "5 days ago", "days round");
eq(relativeEdited(NOW + 60_000, NOW), "just now", "a future stamp from clock skew never goes negative");
eq(relativeEdited(0, NOW), "", "no timestamp, no text");
ok(/\d{4}/.test(ago(90 * 86_400_000)), "anything older than a month reads as a date");

eq(editedAt(undefined, 1234), 1234, "with no frontmatter the file's mtime is used");
eq(editedAt({ updated: "2026-07-20" }, 1234), new Date("2026-07-20").getTime(), "an `updated` property wins over mtime");
eq(editedAt({ modified: "2026-07-21" }, 1234), new Date("2026-07-21").getTime(), "`modified` is accepted too");
eq(editedAt({ updated: "not a date" }, 1234), 1234, "an unparseable property falls back to mtime");
eq(editedAt(undefined, 0), 0, "nothing to show reports zero");

// --- code block language detection ---
eq(guessLanguage(["#!/bin/bash", "echo hi"]), "bash", "a bash shebang is detected");
eq(guessLanguage(["defaults write -g NSQuitAlwaysKeepsWindows -bool true"]), "bash", "a defaults write line reads as shell");
eq(guessLanguage(["#!/usr/bin/env python3", "import os"]), "python", "a python shebang wins over the import heuristic");
eq(guessLanguage(["SELECT * FROM users"]), "sql", "SQL is detected case-insensitively");
eq(guessLanguage(["Get-ChildItem -Path C:\\"]), "powershell", "a PowerShell verb-noun is detected");
eq(guessLanguage(["const x = 1;"]), "javascript", "a const declaration reads as JavaScript");
eq(guessLanguage(["just some prose"]), null, "plain prose is not guessed at");
eq(guessLanguage([]), null, "an empty block is not guessed at");

// --- narrowed edits (so folds outside the change survive) ---
const ne = (a: string, b: string) => {
	const r = narrowEdit(a.split("\n"), b.split("\n"));
	return `${r.from}-${r.to}:${JSON.stringify(r.text)}`;
};
// "No edit" is `from > to` with no text. The numbers are wherever the two scans
// stopped, not a fixed sentinel: identical documents run the forward scan to the
// end and give 3-2, and only a document with NO lines gives 0--1, which is what
// this case used to expect. applyDoc tests `from > to` alone, so every one of
// them is handled; the contract is asserted below so these incidental numbers
// are not the only thing under test.
eq(ne("a\nb\nc", "a\nb\nc"), '3-2:[]', "identical documents produce no edit");
eq(ne("", ""), '1-0:[]', "one empty line is one identical line, not an empty document");
{
	// The only way to reach 0--1 is a document with no lines at all, which
	// splitting a string can never produce ("".split("\n") is [""]).
	const empty = narrowEdit([], []);
	eq(`${empty.from}-${empty.to}`, "0--1", "an empty document is where 0--1 comes from");
	const same = narrowEdit(["a", "b", "c"], ["a", "b", "c"]);
	ok(same.from > same.to && same.text.length === 0, "no edit reads as an empty range wherever the scan stopped");
	ok(empty.from > empty.to && empty.text.length === 0, "and so does the empty document");
}
eq(ne("a\nb\nc", "a\nX\nc"), '1-1:["X"]', "one changed line touches only that line");
eq(ne("a\nb\nc\nd", "a\nd"), '1-2:[]', "deleting a middle run reports just that run");
eq(ne("a\nd", "a\nb\nc\nd"), '1-0:["b","c"]', "an insertion reports an empty prev range");
eq(ne("a\nb", "a\nb\nc"), '2-1:["c"]', "appending touches only the new tail");
eq(ne("a\nb", "b"), '0-0:[]', "removing the first line does not rewrite the rest");
eq(ne("x", ""), '0-0:[""]', "clearing a single line still edits it");

// --- fence info: language plus an optional filename ---
const fi = (s: string) => { const r = parseFenceInfo(s); return `${r.lang}|${r.file}`; };
eq(fi("bash"), "bash|", "a bare language has no filename");
eq(fi(""), "|", "an empty info string is plain text");
eq(fi("bash mac-bootstrap.sh"), "bash|mac-bootstrap.sh", "space-separated filename");
eq(fi("bash:mac-bootstrap.sh"), "bash|mac-bootstrap.sh", "colon-separated filename");
eq(fi('bash title="mac bootstrap.sh"'), "bash|mac bootstrap.sh", "title= form allows spaces in the name");
eq(fi(":notes.txt"), "|notes.txt", "a filename with no language still parses");
eq(formatFenceInfo("bash", "run.sh"), "bash run.sh", "writing back uses the space form");
eq(formatFenceInfo("bash", ""), "bash", "no filename writes the language alone");
eq(formatFenceInfo("", "run.sh"), "run.sh", "filename alone is written alone");
eq(fi(formatFenceInfo("bash", "a b.sh")), "bash|a b.sh", "a name with spaces round-trips");

// --- inserting a list item above (Enter at the visual start of an item) ---
const above = (src: string, line: number) => {
	const r = insertItemAbove(src.split("\n"), line);
	return r ? r.lines.join("\n") : "null";
};
eq(above("1. one\n2. two\n3. three", 0), "1. \n2. one\n3. two\n4. three", "inserting above the first item renumbers the run");
eq(above("1. one\n2. two\n3. three", 1), "1. one\n2. \n3. two\n4. three", "inserting in the middle renumbers the tail");
eq(above("- a\n- b", 0), "- \n- a\n- b", "a bulleted item keeps its bullet and is not numbered");
eq(above("5. five\n6. six", 0), "5. \n6. five\n7. six", "a run that starts at 5 keeps starting at 5");
eq(above("1) one\n2) two", 0), "1) \n2) one\n3) two", "the ) delimiter is preserved");
eq(above("intro\n1. one", 1), "intro\n1. \n2. one", "prose above the list is left alone");
eq(above("1. one\n\n1. other list", 0), "1. \n2. one\n\n1. other list", "a separate list after a blank line is not renumbered");
eq(above("plain text", 0), "null", "a non-list line reports null");
eq(
	above('1. <mark style="background:#E2F5EA">Package this up</mark>\n2. Read this', 0),
	'1. \n2. <mark style="background:#E2F5EA">Package this up</mark>\n3. Read this',
	"the item carrying hidden HTML is moved down whole, never split"
);

// --- stripTags: is an item really empty once hidden markup is discounted ---
eq(stripTags("<mark></mark>"), "", "a bare tag pair is empty");
eq(stripTags("<mark>text</mark>"), "text", "tags come off, text stays");
eq(stripTags("  "), "", "whitespace is empty");
eq(stripTags("plain"), "plain", "untagged text is unchanged");

// --- rich-text copy: what a mail client needs that Markdown does not carry ---
eq(olTypeForDepth(0), "1", "the top level stays numeric");
eq(olTypeForDepth(1), "a", "the second level letters, the way Obsidian shows it");
eq(olTypeForDepth(2), "i", "the third goes roman");
eq(olTypeForDepth(3), "1", "and the cycle repeats rather than running out");
eq(olStyleForDepth(0), "decimal", "the CSS spelling matches the attribute at the top level");
eq(olStyleForDepth(1), "lower-alpha", "a, b, c in the spelling a web mail client keeps");
eq(olStyleForDepth(2), "lower-roman", "and roman below that");
ok(isBlankBlock(" \u00a0 "), "a line holding only a non-breaking space is a blank block");
ok(isBlankBlock(""), "so is an empty one");
ok(!isBlankBlock("\u00a0text"), "text beside one is not blank");
ok(isBlankBlock("\u200b\ufeff"), "and invisibles a paste left behind are blank too");
eq(stripFrontmatter("---\ntitle: x\n---\nBody"), "Body", "frontmatter comes off");
eq(stripFrontmatter("Body only"), "Body only", "a note without it is untouched");
eq(stripFrontmatter("Body --- with dashes"), "Body --- with dashes", "dashes mid-note are not frontmatter");

// the marker that makes a rich copy survive being pasted back into Obsidian
{
	const md = "- [[A note]] — with an em dash, an emoji 🎉, and \"quotes\"";
	const wrapped = wrapWithMarkdown("<ul><li>A note</li></ul>", md);
	eq(markdownFromMarker(wrapped), md, "the Markdown survives the round trip, non-Latin-1 and all");
	ok(wrapped.includes("<ul><li>A note</li></ul>"), "and the readable HTML is still what a mail client sees");
	eq(markdownFromMarker("<p>from somewhere else</p>"), null, "foreign HTML has no marker");
	eq(markdownFromMarker(""), null, "neither does an empty clipboard");
	eq(markdownFromMarker('<div data-ped-md="!!!not base64!!!">x</div>'), null, "a mangled marker falls through instead of pasting garbage");
	eq(markdownFromMarker(wrapWithMarkdown("<p>x</p>", "")), null, "an empty selection is not a marker");
}

// The summary runs last on purpose: any test added below it would print FAIL
// without failing the build.
if (fails) {
	console.log(fails + " failure(s)");
	process.exit(1);
} else {
	console.log("All tests passed.");
}

// --- drag-and-drop reordering ---
const dnd = (from: number, before: number) => moveItem(["a", "b", "c", "d"], from, before).join("");
eq(dnd(0, 0), "abcd", "dropping an item on itself changes nothing");
eq(dnd(0, 1), "abcd", "dropping just after itself changes nothing");
eq(dnd(0, 2), "bacd", "moving down one lands after the item it passed");
eq(dnd(0, 4), "bcda", "moving to the very end");
eq(dnd(3, 0), "dabc", "moving to the very start");
eq(dnd(3, 1), "adbc", "moving up lands before the target");
eq(dnd(1, 3), "acbd", "a middle move down");
eq(dnd(2, 1), "acbd", "a middle move up");
eq(moveItem(["a"], 0, 0).join(""), "a", "a one-item list survives");
eq(moveItem(["a", "b"], 5, 0).join(""), "ab", "an out-of-range source is ignored");
