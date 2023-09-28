import { Players, RunService } from "@rbxts/services";
import { t } from "@rbxts/t";
import { Metadata } from "./metadata";
import { Modding } from "./modding";
import { Reflect } from "./reflect";
import { AbstractConstructor, Constructor, isConstructor } from "./utility";

export namespace Flamework {
	export interface ServiceConfig {
		loadOrder?: number;
	}
	export interface ControllerConfig {
		loadOrder?: number;
	}
	export interface Decorator {
		arguments: unknown[];
	}

	const isProfiling = Metadata.isProfiling();

	let hasFlameworkIgnited = false;
	let isPreloading = false;
	let inactiveThread: thread | undefined;

	/** @hidden */
	export function resolveDependency(id: string) {
		if (isPreloading) {
			const [source, line] = debug.info(2, "sl");
			warn(`[Flamework] Attempting to load dependency '${id}' during preloading.`);
			warn("This is prone to race conditions and is not guaranteed to succeed.");
			warn(`Script '${source}', Line ${line}`);
		} else if (!hasFlameworkIgnited && Metadata.gameConfig.disableDependencyWarnings !== true) {
			const [source, line] = debug.info(2, "sl");
			warn(`[Flamework] Dependency '${id}' was loaded before ignition.`);
			warn("This is considered bad practice and should be avoided.");
			warn("You can disable this warning in flamework.json");
			warn(`Script '${source}', Line ${line}`);
		}
		return Modding.resolveDependency(ArtificialDependency, id, 0, {});
	}

	/** @hidden */
	export function _addPaths(...args: [...string[]][]) {
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

		const global = _G as Map<unknown, unknown>;
		const preload = (moduleScript: ModuleScript) => {
			isPreloading = true;
			global.set(moduleScript, global.get(script));
			const start = os.clock();
			const [success, value] = pcall(require, moduleScript);
			const endTime = math.floor((os.clock() - start) * 1000);
			isPreloading = false;
			if (!success) {
				throw `${moduleScript.GetFullName()} failed to preload (${endTime}ms): ${value}`;
			}
		};

		for (const path of preloadPaths) {
			logIfVerbose(`Preloading directory ${path.GetFullName()}`);
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

	/** @hidden */
	export function _implements<T>(object: unknown, id: string): object is T {
		return Reflect.getMetadatas<string[]>(object as object, "flamework:implements").some((impl) =>
			impl.includes(id),
		);
	}

	function logIfVerbose(...args: unknown[]) {
		if (Metadata.getLogLevel() === "verbose") {
			print("[Flamework (verbose)]", ...args);
		}
	}

	function getIdentifier(obj: object, suffix = ""): string {
		return Reflect.getMetadata<string>(obj, "identifier") ?? `UnidentifiedFlameworkListener${suffix}`;
	}

	// This returns a Map rather than an Array because table.sort is unstable and will not preserve element order.
	function topologicalSort(objects: string[]) {
		// This implementation ignores circular dependency trees.
		let currentSize = 0;
		const sorted = new Map<string, number>();
		const visited = new Set<string>();
		const visitor = (node: string) => {
			if (visited.has(node)) return;
			visited.add(node);

			const object = Reflect.idToObj.get(node);
			if (!object) return;

			const dependencies = Reflect.getMetadata<string[]>(object, "flamework:parameters");
			for (const dependency of dependencies ?? []) {
				visitor(dependency);
			}

			sorted.set(node, currentSize++);
		};

		for (const node of objects) {
			visitor(node);
		}

		return sorted;
	}

	function reusableThread(func: () => void) {
		const thread = coroutine.running();

		while (true) {
			if (inactiveThread === thread) {
				inactiveThread = undefined;
			}

			func();

			// If there's a different idle thread, we should end the current thread.
			if (inactiveThread !== undefined) {
				break;
			}

			inactiveThread = thread;
			[func] = coroutine.yield() as LuaTuple<[never]>;
		}
	}

	function profileYielding(func: () => void, identifier: string) {
		if (isProfiling) {
			return () => {
				// `profilebegin` will end when this thread dies or yields.
				debug.profilebegin(identifier);
				debug.setmemorycategory(identifier);
				func();
				debug.resetmemorycategory();
			};
		} else {
			return func;
		}
	}

	function reuseThread(func: () => void) {
		if (inactiveThread) {
			task.spawn(inactiveThread, func);
		} else {
			task.spawn(reusableThread, func);
		}
	}

	/**
	 * Explicitly include an optional class in the startup cycle.
	 */
	export function registerOptionalClass(ctor: Constructor) {
		Reflect.defineMetadata(ctor, "flamework:optional", false);
	}

	/**
	 * Initialize Flamework.
	 *
	 * This will start up the lifecycle events on all currently registered
	 * classes.
	 *
	 * You should preload all necessary directories before calling this
	 * as newly registered classes will not run their lifecycle events.
	 *
	 * @returns All the dependencies that have been loaded.
	 */
	export function ignite() {
		if (hasFlameworkIgnited) throw "Flamework.ignite() should only be called once";
		hasFlameworkIgnited = true;

		for (const [, ctor] of Reflect.idToObj) {
			if (!isConstructor(ctor)) continue;
			if (!Reflect.getMetadata<boolean>(ctor, "flamework:singleton")) continue;
			if (Reflect.getMetadata<boolean>(ctor, "flamework:optional")) continue;

			Modding.resolveSingleton(ctor);
			logIfVerbose(`Resolving singleton ${ctor}`);
		}

		const dependencies = new Array<[instance: object, loadOrder: number]>();
		for (const [ctor, dependency] of Modding.getSingletons()) {
			const loadOrder = Reflect.getMetadata<number>(ctor, "flamework:loadOrder") ?? 1;
			dependencies.push([dependency, loadOrder]);
		}

		const sortedDependencies = topologicalSort(dependencies.map(([obj]) => getIdentifier(obj)));
		const start = new Array<[OnStart, string]>();
		const init = new Array<[OnInit, string]>();

		const tick = new Map<OnTick, string>();
		const render = new Map<OnRender, string>();
		const physics = new Map<OnPhysics, string>();

		dependencies.sort(([depA, aOrder], [depB, bOrder]) => {
			if (aOrder !== bOrder) {
				return aOrder < bOrder;
			}

			const aIndex = sortedDependencies.get(getIdentifier(depA))!;
			const bIndex = sortedDependencies.get(getIdentifier(depB))!;
			return aIndex < bIndex;
		});

		Modding.onListenerAdded<OnTick>((object) => tick.set(object, getIdentifier(object, "/OnTick")));
		Modding.onListenerAdded<OnPhysics>((object) => physics.set(object, getIdentifier(object, "/OnPhysics")));
		Modding.onListenerAdded<OnRender>((object) => render.set(object, getIdentifier(object, "/OnRender")));

		Modding.onListenerRemoved<OnTick>((object) => tick.delete(object));
		Modding.onListenerRemoved<OnPhysics>((object) => physics.delete(object));
		Modding.onListenerRemoved<OnRender>((object) => render.delete(object));

		for (const [dependency] of dependencies) {
			if (Flamework.implements<OnInit>(dependency)) init.push([dependency, getIdentifier(dependency)]);
			if (Flamework.implements<OnStart>(dependency)) start.push([dependency, getIdentifier(dependency)]);
		}

		for (const [dependency, identifier] of init) {
			if (isProfiling) debug.setmemorycategory(identifier);

			logIfVerbose(`OnInit ${identifier}`);
			const initResult = dependency.onInit();
			if (Promise.is(initResult)) {
				const [status, value] = initResult.awaitStatus();
				if (status === Promise.Status.Rejected) {
					throw `OnInit failed for dependency '${identifier}'. ${tostring(value)}`;
				}
			}
		}

		debug.resetmemorycategory();

		RunService.Heartbeat.Connect((dt) => {
			for (const [dependency, identifier] of tick) {
				reuseThread(profileYielding(() => dependency.onTick(dt), identifier));
			}
		});

		RunService.Stepped.Connect((time, dt) => {
			for (const [dependency, identifier] of physics) {
				reuseThread(profileYielding(() => dependency.onPhysics(dt, time), identifier));
			}
		});

		if (RunService.IsClient()) {
			RunService.RenderStepped.Connect((dt) => {
				for (const [dependency, identifier] of render) {
					reuseThread(profileYielding(() => dependency.onRender(dt), identifier));
				}
			});
		}

		for (const [dependency, identifier] of start) {
			logIfVerbose(`OnStart ${identifier}`);
			reuseThread(profileYielding(() => dependency.onStart(), identifier));
		}
	}

	/**
	 * Preload the specified paths by requiring all ModuleScript descendants.
	 */
	export declare function addPaths(...args: string[]): void;

	/**
	 * Preload the specified paths by requiring all ModuleScript descendants.
	 */
	export declare function addPaths(config: { glob: "file" | "directory" }, ...args: string[]): void;

	/**
	 * Retrieve the identifier for the specified type.
	 */
	export declare function id<T>(): string;

	/**
	 * Check if the constructor implements the specified interface.
	 */
	export declare function implements<T>(object: AbstractConstructor): boolean;

	/**
	 * Check if object implements the specified interface.
	 */
	export declare function implements<T>(object: unknown): object is T;

	/**
	 * Creates a type guard from any arbitrary type.
	 */
	export declare function createGuard<T>(): t.check<T>;

	/**
	 * Hash a function using the method used internally by Flamework.
	 * If a context is provided, then Flamework will create a new hash
	 * if the specified string does not have one in that context.
	 * @param str The string to hash
	 * @param context A scope for the hash
	 */
	export declare function hash(str: string, context?: string): string;
}

/**
 * An internal class used for resolving the Dependency<T> macro.
 */
class ArtificialDependency {}
Reflect.defineMetadata(ArtificialDependency, "identifier", Flamework.id<ArtificialDependency>());
Reflect.defineMetadata(ArtificialDependency, "flamework:isArtificial", true);

/**
 * This function resolves a dependency and can be called outside of the usual dependency injection lifecycle.
 *
 * This function can make it harder to stub, test or modify your code so it is recommended to use this macro minimally.
 * It is recommended that you pass dependencies to code that needs it from a singleton, component, etc.
 */
export declare function Dependency<T>(ctor?: Constructor<T>): T;

/**
 * Register a class as a Service.
 *
 * @server
 * @metadata flamework:implements flamework:parameters injectable
 */
export const Service = Modding.createDecorator<[opts?: Flamework.ServiceConfig]>("Class", (descriptor, [cfg]) => {
	if (RunService.IsServer()) {
		Reflect.defineMetadata(descriptor.object, "flamework:singleton", true);
		Reflect.defineMetadata(descriptor.object, "flamework:loadOrder", cfg?.loadOrder);
	}
});

/**
 * Register a class as a Controller.
 *
 * @client
 * @metadata flamework:implements flamework:parameters injectable
 */
export const Controller = Modding.createDecorator<[opts?: Flamework.ControllerConfig]>("Class", (descriptor, [cfg]) => {
	if (RunService.IsClient()) {
		Reflect.defineMetadata(descriptor.object, "flamework:singleton", true);
		Reflect.defineMetadata(descriptor.object, "flamework:loadOrder", cfg?.loadOrder);
	}
});

/**
 * Marks a singleton as optional.
 *
 * This singleton will only be included if it is depended on or is explicitly included with `Flamework.registerOptionalClass`.
 */
export const Optional = Modding.createDecorator("Class", (descriptor) => {
	Reflect.defineMetadata(descriptor.object, `flamework:optional`, true);
});

/**
 * Hook into the OnInit lifecycle event.
 */
export interface OnInit {
	/**
	 * This function will be called whenever the game is starting up.
	 * This should only be used to setup your object prior to other objects using it.
	 *
	 * It's safe to load dependencies here, but it is not safe to use them.
	 * Yielding or returning a promise will delay initialization of other dependencies.
	 *
	 * @hideinherited
	 */
	onInit(): void | Promise<void>;
}

/**
 * Hook into the OnStart lifecycle event.
 */
export interface OnStart {
	/**
	 * This function will be called after the game has been initialized.
	 * This function will be called asynchronously.
	 *
	 * @hideinherited
	 */
	onStart(): void;
}

/**
 * Hook into the OnTick lifecycle event.
 * Equivalent to: RunService.Heartbeat
 */
export interface OnTick {
	/**
	 * Called every frame, after physics.
	 *
	 * @hideinherited
	 */
	onTick(dt: number): void;
}

/**
 * Hook into the OnPhysics lifecycle event.
 * Equivalent to: RunService.Stepped
 */
export interface OnPhysics {
	/**
	 * Called every frame, before physics.
	 *
	 * @hideinherited
	 */
	onPhysics(dt: number, time: number): void;
}

/**
 * Hook into the OnRender lifecycle event.
 * Equivalent to: RunService.RenderStepped
 *
 * @client
 */
export interface OnRender {
	/**
	 * Called every frame, before rendering.
	 * Only available for controllers.
	 *
	 * @hideinherited
	 */
	onRender(dt: number): void;
}
