import { Runtime } from "foldkit";
import { BenchMessage, BenchModel, benchUpdate, initialBenchModel, LoadBoard, LoadCodemode } from "./bench/app";
import { benchView } from "./bench/view";
import { Flags, flags, init } from "./main";
import { Message } from "./message";
import { Model } from "./model";
import { ProgramClientLive } from "./rpc";
import type { ProgramClient } from "./rpc";
import type { Flags as StartupFlags } from "./main";
import { subscriptions } from "./subscriptions";
import { update } from "./update";
import { view } from "./view";

const container = document.getElementById("root");

const runPlayground = (): void => {
	const application = Runtime.makeApplication<Model, Message, StartupFlags, ProgramClient>({
		Model,
		Flags,
		init,
		update,
		view,
		subscriptions,
		resources: ProgramClientLive,
		container,
		devTools: { Message },
	});

	Runtime.run(application, { flags });
};

const runBenchmarks = (): void => {
	const application = Runtime.makeApplication<BenchModel, BenchMessage>({
		Model: BenchModel,
		init: () => ({ model: initialBenchModel, commands: [LoadBoard(), LoadCodemode()] }),
		update: benchUpdate,
		view: benchView,
		container,
		devTools: { Message: BenchMessage },
	});

	Runtime.run(application);
};

if (/^\/benchmarks\/?$/.test(globalThis.location.pathname)) runBenchmarks();
else runPlayground();
