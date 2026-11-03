// Hunspell files are bundled as text by esbuild's text loader (see
// esbuild.config.mjs), so importing one yields its contents.
declare module "*.aff" {
	const text: string;
	export default text;
}
declare module "*.dic" {
	const text: string;
	export default text;
}

declare module "nspell" {
	interface NSpell {
		correct(word: string): boolean;
		suggest(word: string): string[];
		add(word: string): NSpell;
	}
	function nspell(aff: string, dic: string): NSpell;
	export default nspell;
}
