import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		projects: [
			{ test: { name: "library", environment: "node", include: ["test/**/*.test.ts"], testTimeout: 120_000 } },
			{ test: { name: "site", environment: "happy-dom", include: ["site/client/src/**/*.test.ts"], setupFiles: ["./site/client/src/vitest-setup.ts"], server: { deps: { inline: ["foldkit"] } } } },
		],
	},
});
