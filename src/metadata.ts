import { RunService } from "@rbxts/services";

/**
 * Metadata exposed by the Flamework transformer.
 */
export namespace Metadata {
	/**
	 * Runtime metadata generated by the transformer
	 */
	export interface Config {
		logLevel?: "none" | "verbose";
		profiling?: boolean;
		disableDependencyWarnings?: boolean;
	}

	/**
	 * Runtime metadata generated by the transformer
	 */
	interface ConfigContainer {
		game?: Config;
		packages: Map<string, Config>;
	}

	function getConfigContainer() {
		let current: Instance | undefined = script;
		while (current) {
			const flamework = current.FindFirstChild("flamework");
			if (flamework) {
				const metadata = flamework.FindFirstChild("config");
				if (metadata) {
					return require(metadata as ModuleScript) as ConfigContainer;
				}
			}

			current = current.Parent;
		}
	}

	function getConfig(packageId?: string) {
		return packageId === undefined ? configContainer?.game : configContainer?.packages.get(packageId);
	}

	export const configContainer = getConfigContainer();

	export const gameConfig = configContainer?.game ?? {};

	export function getLogLevel(packageId?: string) {
		const config = getConfig(packageId);
		if (!config || config.logLevel === undefined) return "none";

		return config.logLevel;
	}

	export function isProfiling(packageId?: string) {
		const config = getConfig(packageId);
		if (!config || config.profiling === undefined) return RunService.IsStudio();

		return config.profiling;
	}
}
