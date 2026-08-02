// Refuse to deploy a build older than the one already installed.
//
// This exists because it happened twice: another machine had published a newer
// Power Editor, Power Connect synced it into the vault, and a deploy from here
// overwrote it with an older build — then propagated that downgrade back out to
// every other device. A check that only PRINTS a warning is not a check; this
// one exits non-zero so `npm run deploy` stops before copying anything.
//
// Run by the deploy script; also fine to run on its own.
import { existsSync, readFileSync, readdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import process from "process";

const cmp = (a, b) => {
	const pa = a.split(".").map(Number);
	const pb = b.split(".").map(Number);
	for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
		const d = (pa[i] ?? 0) - (pb[i] ?? 0);
		if (d) return d;
	}
	return 0;
};

const mine = JSON.parse(readFileSync("manifest.json", "utf8"));

const registry = [
	process.env.APPDATA ? join(process.env.APPDATA, "obsidian", "obsidian.json") : null,
	join(homedir(), "Library", "Application Support", "obsidian", "obsidian.json"),
	join(homedir(), ".config", "obsidian", "obsidian.json"),
].filter(Boolean).find((p) => existsSync(p));

if (!registry) process.exit(0); // nothing installed anywhere; let the deploy run

const vaults = Object.values(JSON.parse(readFileSync(registry, "utf8")).vaults ?? {}).map((v) => v.path);
let blocked = false;

for (const vault of vaults) {
	const dir = join(vault, ".obsidian", "plugins", mine.id);
	const mf = join(dir, "manifest.json");
	if (!existsSync(mf)) continue;
	let installed;
	try {
		installed = JSON.parse(readFileSync(mf, "utf8")).version;
	} catch {
		console.log(`  ${vault}: manifest unreadable (corrupt?) — deploy will replace it`);
		continue;
	}
	const rel = cmp(mine.version, installed);
	const verdict = rel < 0 ? "DOWNGRADE" : rel === 0 ? "same" : "newer";
	console.log(`  ${installed} -> ${mine.version}  ${verdict}  (${vault})`);
	if (rel < 0) blocked = true;
}

if (blocked) {
	console.error(
		`\nRefusing to deploy: ${mine.version} is older than what is installed.\n` +
			`Another machine has published a newer build. Pull it first:\n` +
			`  git fetch origin && git merge --ff-only origin/main\n` +
			`then rebuild on top of it. Override with FORCE_DEPLOY=1 only if you mean it.\n`
	);
	if (process.env.FORCE_DEPLOY !== "1") process.exit(1);
	console.error("FORCE_DEPLOY=1 set — deploying anyway.\n");
}
