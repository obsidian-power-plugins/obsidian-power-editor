/* Spelling suggestions for the editor's right-click menu. No Obsidian imports,
 * so it runs under Node for tests; main.ts supplies the dictionary and the menu.
 *
 * Obsidian's spellcheck is Chromium's, which on macOS is the system checker.
 * That checker is what draws the squiggle and cannot be swapped out, and its
 * suggestions are thin: "On-Prem" gets "No suggestions…", a transposed "teh"
 * gets nothing useful, and a run-together "databasebackup" gets nothing at
 * all. What it CAN be given is a better menu. This module decides what a word
 * should have offered against it; the squiggle stays the system's call. */

/** The dictionary underneath: nspell in the plugin, a word set in tests. */
export interface Lexicon {
	correct(word: string): boolean;
	suggest(word: string): string[];
}

/**
 * Business and tech vocabulary a general dictionary either flags or spells
 * wrongly. Written in the casing it is properly written in, because the casing
 * is half the point: "Saas" is as wrong as "Sass". A term in all lowercase
 * accepts any capitalization a sentence can give it ("On-Prem" in a heading);
 * one with capitals of its own has to be written that way, or in all caps.
 */
export const TECH_TERMS: readonly string[] = [
	// deployment and service models
	"on-prem", "on-premises", "on-premise", "off-prem", "SaaS", "PaaS", "IaaS", "DaaS", "XaaS",
	"multi-tenant", "multitenant", "single-tenant", "multi-cloud", "hybrid-cloud", "serverless",
	"hyperscaler", "hyperscalers", "colo", "colocation", "failover", "failback", "geo-redundant",
	// platforms and products
	"Kubernetes", "k8s", "kubectl", "Docker", "Dockerfile", "Helm", "Istio", "Nginx", "Terraform",
	"Ansible", "Jenkins", "GitHub", "GitLab", "Bitbucket", "Jira", "Confluence", "Atlassian",
	"ServiceNow", "Salesforce", "HubSpot", "Zendesk", "SharePoint", "OneDrive", "OneNote",
	"PowerPoint", "PowerShell", "PowerBI", "Outlook", "Gmail", "iCloud", "macOS", "iOS", "iPadOS",
	"watchOS", "tvOS", "Ubuntu", "Linux", "Azure", "Entra", "Snowflake", "Databricks", "Tableau",
	"Looker", "dbt", "PostgreSQL", "Postgres", "MySQL", "MariaDB", "MongoDB", "NoSQL", "SQLite",
	"Redis", "Kafka", "RabbitMQ", "Elasticsearch", "OpenSearch", "Grafana", "Prometheus", "Datadog",
	"Splunk", "PagerDuty", "Okta", "OAuth", "OpenID", "JavaScript", "TypeScript", "Python", "Golang",
	"GraphQL", "gRPC", "WebSocket", "WebSockets", "YouTube", "LinkedIn", "WhatsApp", "ChatGPT",
	"OpenAI", "Anthropic", "Copilot", "Obsidian", "Wi-Fi", "Bluetooth", "Zoom", "Webex",
	// acronyms that keep their capitals (all-caps words pass anyway; these are
	// here for the lowercase or plural forms people type)
	"API", "APIs", "SDK", "SDKs", "CLI", "GUI", "UI", "UX", "QA", "UAT", "SLA", "SLAs", "SLO", "SLOs",
	"KPI", "KPIs", "OKR", "OKRs", "ROI", "EBITDA", "ARR", "MRR", "CapEx", "OpEx", "B2B", "B2C",
	"CRM", "ERP", "HRIS", "SOW", "SOWs", "RFP", "RFPs", "RFQ", "RFI", "NDA", "NDAs", "MSA", "PoC",
	"MVP", "SSO", "SAML", "LDAP", "VPN", "VPC", "VNet", "DNS", "CDN", "ETL", "ELT", "CI/CD", "DevOps",
	"DevSecOps", "SecOps", "MLOps", "FinOps", "GitOps", "AIOps", "eDiscovery", "eCommerce",
	// working vocabulary
	"roadmap", "roadmaps", "backlog", "backlogs", "onboarding", "offboarding", "onboard", "offboard",
	"upsell", "upsells", "cross-sell", "upskill", "upskilling", "reskilling", "stakeholder",
	"stakeholders", "workstream", "workstreams", "timebox", "timeboxed", "deliverable", "deliverables",
	"go-live", "go-lives", "cutover", "cutovers", "sign-off", "rollout", "rollouts", "rollback",
	"rollbacks", "runbook", "runbooks", "playbook", "playbooks", "hotfix", "hotfixes", "dev", "devs",
	"prod", "repo", "repos", "config", "configs", "async", "sync", "resync", "microservice",
	"microservices", "middleware", "frontend", "backend", "full-stack", "fullstack", "codebase",
	"codebases", "dataset", "datasets", "webhook", "webhooks", "dashboarding", "login", "logins",
	"signup", "signups", "walkthrough", "walkthroughs", "offsite", "onsite", "nearshore", "offshore",
	"headcount", "fitment", "learnings", "actionable", "ideation", "pre-sales", "presales",
];

const strictCase = (t: string) => /[A-Z]/.test(t.slice(1)) || /^[A-Z]/.test(t);
/** Matching ignores case, hyphens, and slashes, so "onprem" and "On Prem"
 *  both find "on-prem" (the second as a suggestion, being two words). */
const termKey = (w: string) => w.toLowerCase().replace(/[-/]/g, "");
const TERMS = new Map<string, string>();
for (const t of TECH_TERMS) if (!TERMS.has(termKey(t))) TERMS.set(termKey(t), t);

/**
 * The term a word is written as, or null. `exact` means the casing is
 * acceptable too; otherwise the term is the correction (saas → SaaS).
 */
export function termFor(word: string): { term: string; exact: boolean } | null {
	const term = TERMS.get(termKey(word));
	if (!term) return null;
	// a hyphen is part of the spelling: "onprem" is the term, misspelled
	const sameShape = word.replace(/[^-/]/g, "") === term.replace(/[^-/]/g, "");
	if (!sameShape) return { term, exact: false };
	if (word === term || word === word.toUpperCase()) return { term, exact: true };
	if (!strictCase(term)) return { term, exact: word.toLowerCase() === term && isSentenceCase(word) };
	return { term, exact: false };
}

/** Lowercase, Capitalized, or each hyphenated part Capitalized. */
function isSentenceCase(w: string): boolean {
	return w
		.split(/([-/])/)
		.every((p) => p === "-" || p === "/" || p === p.toLowerCase() || p === cap(p.toLowerCase()));
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export interface WordSpan {
	from: number;
	to: number;
	word: string;
}

const WORDCH = /[\p{L}\p{M}\p{N}]/u;
const JOINER = /['’\-/]/;

/**
 * The word a column sits in, hyphens and apostrophes included when they sit
 * between letters: "On-Prem", "don't", "CI/CD". A trailing hyphen or quote is
 * punctuation, not part of the word. Null between words.
 */
export function wordAt(line: string, ch: number): WordSpan | null {
	const isWord = (i: number) => i >= 0 && i < line.length && WORDCH.test(line[i]);
	const isPart = (i: number) => isWord(i) || (JOINER.test(line[i] ?? "") && isWord(i - 1) && isWord(i + 1));
	let at = ch;
	if (!isPart(at)) at = ch - 1; // the caret just past the last letter still means that word
	if (!isPart(at)) return null;
	let from = at;
	let to = at + 1;
	while (from > 0 && isPart(from - 1)) from--;
	while (to < line.length && isPart(to)) to++;
	return { from, to, word: line.slice(from, to) };
}

/**
 * Words a checker should leave alone, as Word does by default: anything with a
 * digit in it, anything in all capitals (an acronym or someone shouting), a
 * single letter, and URL-ish or code-ish runs.
 */
export function skipWord(word: string): boolean {
	if (word.length < 2) return true;
	if (/\p{N}/u.test(word)) return true;
	if (/[\p{L}]/u.test(word) && word === word.toUpperCase() && word !== word.toLowerCase()) return true;
	return false;
}

export interface SpellContext {
	lex: Lexicon;
	/** The user's own dictionary, lowercased. */
	user: Set<string>;
}

export interface Verdict {
	/** Spelled acceptably; nothing to offer. */
	ok: boolean;
	/** The word is a recognized term, which the system checker may still flag. */
	term?: string;
	/** Ranked replacements for the whole word, best first. */
	suggestions: string[];
}

/** Possessive endings are checked off the word, then put back on suggestions. */
function splitPossessive(word: string): [string, string] {
	const m = /^(.*?)(['’]s?)$/u.exec(word);
	return m && m[1].length > 1 ? [m[1], m[2]] : [word, ""];
}

/** Whether a single piece, with no hyphen in it, is spelled right. */
function pieceOk(p: string, ctx: SpellContext): boolean {
	if (skipWord(p)) return true;
	if (ctx.user.has(p.toLowerCase())) return true;
	// a term written in the wrong case is wrong unless it is also an ordinary
	// word: "python" the snake is fine, "saas" is not
	if (termFor(p)?.exact || ctx.lex.correct(p)) return true;
	// "PowerEditor", "OneLogin": a product name built of real words reads as a
	// name, not a misspelling
	const humps = /^[A-Z]?[a-z]+(?:[A-Z][a-z]+)+$/.test(p) ? p.split(/(?=[A-Z])/) : null;
	return !!humps && humps.every((h) => h.length > 1 && ctx.lex.correct(h));
}

/**
 * The verdict on one word, as right-clicked. Hyphenated words are judged a
 * part at a time, so "state-of-the-art" passes and "on-prem" passes on the
 * terms list, while "back-of-teh-house" is offered a fix to just the part that
 * is wrong. A run-together word that is two real words is offered both ways.
 */
export function checkWord(raw: string, ctx: SpellContext): Verdict {
	const [word, tail] = splitPossessive(raw.replace(/’/g, "'"));
	const withTail = (s: string[]) => s.map((x) => x + tail);
	if (ctx.user.has(word.toLowerCase()) || ctx.user.has(raw.toLowerCase())) return { ok: true, suggestions: [] };

	const t = termFor(word);
	if (t?.exact) return { ok: true, term: t.term, suggestions: [] };
	if (t && !ctx.lex.correct(word)) return { ok: false, suggestions: withTail([t.term]) };

	const parts = word.split(/[-/]/);
	const seps = word.match(/[-/]/g) ?? [];
	if (parts.every((p) => pieceOk(p, ctx))) return { ok: true, suggestions: [] };

	const cands: Candidate[] = [];
	const push = (text: string, bonus = 0) => cands.push({ text, bonus });

	if (parts.length > 1) {
		// fix the broken part(s) in place, one at a time; whichever needs fixing
		// least ranks first, because the ranking scores the whole word
		parts.forEach((p, i) => {
			if (pieceOk(p, ctx)) return;
			for (const s of suggestPiece(p, ctx).slice(0, 5)) {
				const next = parts.slice();
				next[i] = matchCase(p, s);
				push(join(next, seps));
			}
		});
		// "on-line" is "online"; "e-mail" is fine either way and never got here
		const glued = parts.join("");
		if (ctx.lex.correct(glued)) push(glued);
	} else {
		for (const s of suggestPiece(word, ctx)) push(matchCase(word, s));
		for (const [a, b] of splits(word, ctx)) {
			push(`${a} ${b}`, 0.3);
			if (termFor(`${a}-${b}`)) push(`${a}-${b}`, -0.2);
		}
	}
	return { ok: false, suggestions: withTail(rank(word, cands)) };
}

function join(parts: string[], seps: string[]): string {
	return parts.reduce((acc, p, i) => acc + (i ? seps[i - 1] : "") + p, "");
}

/** Candidate replacements for one piece: the dictionary's, plus every single
 *  edit of it the dictionary accepts (nspell misses some of these, "teh" →
 *  "the" among them), plus near-misses from the terms list. */
function suggestPiece(p: string, ctx: SpellContext): string[] {
	const out = new Set<string>();
	for (const s of ctx.lex.suggest(p)) out.add(s);
	if (p.length <= 20) for (const e of edits1(p.toLowerCase())) if (ctx.lex.correct(e)) out.add(e);
	const key = termKey(p);
	if (key.length >= 4) {
		for (const [k, term] of TERMS) if (Math.abs(k.length - key.length) <= 2 && distance(key, k) <= 2) out.add(term);
	}
	for (const u of ctx.user) if (u.length >= 4 && Math.abs(u.length - p.length) <= 2 && distance(p.toLowerCase(), u) <= 1.5) out.add(u);
	const ranked = rank(p, [...out].map((text) => ({ text, bonus: TERMS.has(termKey(text)) ? -0.2 : 0 })));
	return ranked;
}

/** One- and two-letter words worth splitting off ("alot"). Hunspell accepts "ed", "sh", and
 *  a hundred other scraps, which would turn "occured" into "occur ed". */
const SHORT = new Set("a an as at be by do go he if in is it me my no of on or so to up us we".split(" "));

/** "databasebackup" → database + backup. */
function splits(w: string, ctx: SpellContext): [string, string][] {
	if (w.length < 4) return [];
	const fits = (p: string) => (p.length > 2 || SHORT.has(p.toLowerCase())) && ctx.lex.correct(p);
	const out: [string, string][] = [];
	for (let i = 1; i <= w.length - 2; i++) {
		const a = w.slice(0, i);
		const b = w.slice(i);
		if (fits(a) && fits(b)) out.push([a, b]);
	}
	return out;
}

const ALPHA = "abcdefghijklmnopqrstuvwxyz";

/** Every string one deletion, transposition, substitution, or insertion away. */
export function edits1(w: string): Set<string> {
	const out = new Set<string>();
	for (let i = 0; i <= w.length; i++) {
		const L = w.slice(0, i);
		const R = w.slice(i);
		if (R) out.add(L + R.slice(1));
		if (R.length > 1) out.add(L + R[1] + R[0] + R.slice(2));
		for (const c of ALPHA) {
			if (R) out.add(L + c + R.slice(1));
			out.add(L + c + R);
		}
	}
	out.delete(w);
	return out;
}

const ROWS = ["qwertyuiop", "asdfghjkl", "zxcvbnm"];
const KEYPOS = new Map<string, [number, number]>();
ROWS.forEach((r, y) => [...r].forEach((c, x) => KEYPOS.set(c, [x + y * 0.5, y])));
const VOWELS = new Set("aeiouy");

/** What it costs to have typed `b` for `a`. A slip onto a neighboring key, or
 *  one vowel for another, is a likelier mistake than an arbitrary letter. */
function subCost(a: string, b: string): number {
	if (a === b) return 0;
	if (a.toLowerCase() === b.toLowerCase()) return 0.1;
	const pa = KEYPOS.get(a.toLowerCase());
	const pb = KEYPOS.get(b.toLowerCase());
	if (pa && pb && Math.abs(pa[0] - pb[0]) <= 1 && Math.abs(pa[1] - pb[1]) <= 1) return 0.6;
	if (VOWELS.has(a.toLowerCase()) && VOWELS.has(b.toLowerCase())) return 0.6;
	return 1;
}

/**
 * Weighted Damerau (optimal string alignment) distance. Swapped neighbors cost
 * half an edit, the commonest typo there is; so does a doubled or undoubled
 * letter ("acommodate"), the commonest misspelling.
 */
export function distance(a: string, b: string): number {
	const m = a.length;
	const n = b.length;
	const d: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
	const indel = (s: string, i: number) => (i > 0 && s[i - 1] === s[i]) || s[i + 1] === s[i] ? 0.5 : 1;
	for (let i = 1; i <= m; i++) d[i][0] = d[i - 1][0] + indel(a, i - 1);
	for (let j = 1; j <= n; j++) d[0][j] = d[0][j - 1] + indel(b, j - 1);
	for (let i = 1; i <= m; i++) {
		for (let j = 1; j <= n; j++) {
			d[i][j] = Math.min(
				d[i - 1][j] + indel(a, i - 1),
				d[i][j - 1] + indel(b, j - 1),
				d[i - 1][j - 1] + subCost(a[i - 1], b[j - 1])
			);
			if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 0.5);
		}
	}
	return d[m][n];
}

interface Candidate {
	text: string;
	/** Added to the score; negative favors it. */
	bonus: number;
}

/** Best first, at most `limit`, and none that is a stretch: a candidate that
 *  needs rewriting a third of the word is noise, not a suggestion. */
export function rank(word: string, cands: Candidate[], limit = 6): string[] {
	const seen = new Map<string, number>();
	const low = word.toLowerCase();
	cands.forEach((c, i) => {
		if (c.text === word) return;
		const t = c.text.toLowerCase().replace(/ /g, "");
		let score = distance(low, t) + c.bonus + i * 0.001; // earlier sources break ties
		if (t[0] !== low[0]) score += 0.4; // people rarely get the first letter wrong
		if (c.text.toLowerCase() !== c.text && c.text[0] === c.text[0].toUpperCase() && word[0] !== word[0].toUpperCase())
			score += 0.3; // a proper noun for a lowercase word is a long shot
		if (score > Math.max(2, word.length / 3) + 0.5) return;
		const prev = seen.get(c.text);
		if (prev === undefined || score < prev) seen.set(c.text, score);
	});
	return [...seen.entries()]
		.sort((a, b) => a[1] - b[1])
		.slice(0, limit)
		.map(([t]) => t);
}

/**
 * A suggestion in the shape the word was typed in: capitalized at the start of
 * a sentence, all caps in an all-caps word. A suggestion with capitals of its
 * own ("SaaS", "Kubernetes") keeps them, since those are the spelling.
 */
export function matchCase(typed: string, suggestion: string): string {
	if (/[A-Z]/.test(suggestion.slice(1)) || /^[A-Z]/.test(suggestion)) {
		return typed.length > 1 && typed === typed.toUpperCase() && suggestion.length > 1 ? suggestion.toUpperCase() : suggestion;
	}
	if (typed.length > 1 && typed === typed.toUpperCase() && typed !== typed.toLowerCase()) return suggestion.toUpperCase();
	if (typed[0] && typed[0] !== typed[0].toLowerCase()) return cap(suggestion);
	return suggestion;
}

/** The user's dictionary as stored in settings (a map, so two devices adding
 *  different words merge instead of one list overwriting the other). */
export function userWords(stored: Record<string, unknown> | undefined): Set<string> {
	return new Set(Object.keys(stored ?? {}).map((w) => w.toLowerCase()));
}

const TOKEN = /[\p{L}\p{M}\p{N}]+(?:['’\-/][\p{L}\p{M}\p{N}]+)*/gu;

/**
 * The words in a stretch of text that the system checker should be told to
 * leave alone: recognized terms in an accepted casing, and the user's own
 * words. Offsets are relative to `text`.
 *
 * Only these, not everything the engine passes. The rest the system already
 * accepts, or judges for itself, and a span per word would be a lot of DOM
 * for nothing.
 */
export function acceptedSpans(text: string, user: Set<string>): { from: number; to: number }[] {
	const out: { from: number; to: number }[] = [];
	for (const m of text.matchAll(TOKEN)) {
		const [word] = splitPossessive(m[0].replace(/’/g, "'"));
		if (skipWord(word)) continue;
		if (user.has(word.toLowerCase()) || termFor(word)?.exact) out.push({ from: m.index!, to: m.index! + m[0].length });
	}
	return out;
}
