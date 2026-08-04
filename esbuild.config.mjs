import esbuild from "esbuild";
import { readFileSync } from "fs";
import process from "process";

const prod = process.argv[2] === "production";

const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));

const ctx = await esbuild.context({
	entryPoints: ["src/main.ts"],
	bundle: true,
	external: ["obsidian", "electron", "@codemirror/*", "@lezer/*", "node:*"],
	format: "cjs",
	target: "es2020",
	// Stamp the manifest version into the bundle so PED_BUILD identifies the
	// code that is actually loaded. It used to be hand-typed in main.ts, which
	// drifted, because a release only bumps the three JSON files.
	define: { __PED_BUILD__: JSON.stringify(manifest.version) },
	// Lookbehind is a *parse*-time error on Safari below 16.4, so a single
	// literal anywhere in the bundle stops the whole plugin from loading on
	// older iOS. Our own source has none, but dependencies do. Declaring the
	// feature unavailable makes esbuild emit new RegExp("...") instead, which
	// parses on any engine and can only fail if that code path actually runs.
	supported: { "regexp-lookbehind-assertions": false },
	logLevel: "info",
	sourcemap: prod ? false : "inline",
	treeShaking: true,
	outfile: "main.js",
});

if (prod) {
	await ctx.rebuild();
	await ctx.dispose();
	await import("./check-bundle.mjs");
	process.exit(0);
} else {
	await ctx.watch();
}
