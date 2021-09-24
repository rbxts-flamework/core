import { Players, RunService } from "@rbxts/services";

export function addPaths(...args: [...string[]][]) {
	const preloadPaths = new Array<Instance>();
	for (const arg of args) {
		const service = arg.shift();
		let currentPath: Instance = game.GetService(service as keyof Services);
		if (service === "StarterPlayer") {
			if (arg[0] !== "StarterPlayerScripts") throw "StarterPlayer only supports StarterPlayerScripts";
			if (!RunService.IsClient()) throw "The server cannot load StarterPlayer content";
			currentPath = Players.LocalPlayer.WaitForChild("PlayerScripts");
			arg.shift();
		}
		for (let i = 0; i < arg.size(); i++) {
			currentPath = currentPath.WaitForChild(arg[i]);
		}
		preloadPaths.push(currentPath);
	}

	const preload = (moduleScript: ModuleScript) => {
		const start = os.clock();
		const result = opcall(require, moduleScript);
		const endTime = math.floor((os.clock() - start) * 1000);
		if (!result.success) {
			throw `${moduleScript.GetFullName()} failed to preload (${endTime}ms): ${result.error}`;
		}
		print(`Preloaded ${moduleScript.GetFullName()} (${endTime}ms)`);
	};

	for (const path of preloadPaths) {
		if (path.IsA("ModuleScript")) {
			preload(path);
		}
		for (const instance of path.GetDescendants()) {
			if (instance.IsA("ModuleScript")) {
				preload(instance);
			}
		}
	}
}
