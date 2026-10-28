import agentSource from "../../../worker/bench/agent.ts?raw";
import programsSource from "../../../worker/bench/programs.ts?raw";
import stateMachineSource from "../../../worker/bench/state-machine.ts?raw";
import workflowSource from "../../../worker/bench/workflow.ts?raw";
import { DETERMINISTIC_SCRIPT, LLM_SCRIPT } from "../../../worker/bench/codemode-scripts";
import type { BenchSystem } from "../../../shared/bench";

export type Implementation = { readonly file: string; readonly source: string; readonly excerpt: string };

export const countLines = (source: string): number =>
	source.split("\n").filter((line) => line.trim() !== "" && !/^\s*import\b/.test(line) && !/^\s*}\s*from\s/.test(line)).length;

const afterImports = (source: string): string =>
	source
		.split("\n")
		.filter((line) => !/^\s*import\b/.test(line))
		.join("\n")
		.trim();

const APPROVALS_ONLY = programsSource.slice(0, programsSource.indexOf("export const LOOP_PROGRAM")).trim();

export const IMPLEMENTATIONS: Readonly<Record<BenchSystem, Implementation>> = {
	amber: { file: "site/worker/bench/programs.ts: the script only; amber's DurableScript runs it", source: programsSource, excerpt: APPROVALS_ONLY },
	workflows: { file: "worker/bench/workflow.ts", source: workflowSource, excerpt: afterImports(workflowSource) },
	agents: { file: "worker/bench/agent.ts", source: agentSource, excerpt: afterImports(agentSource) },
	"durable-object": { file: "worker/bench/state-machine.ts", source: stateMachineSource, excerpt: afterImports(stateMachineSource) },
};

export const CODEMODE_SCRIPTS = { deterministic: DETERMINISTIC_SCRIPT, llm: LLM_SCRIPT } as const;
