import { Players, RunService } from "@rbxts/services";
import { t } from "@rbxts/t";
import { Modding } from "./modding";
import { Reflect } from "./reflect";
import { Constructor } from "./types";

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
	export interface FlameworkConfig {
		isDefault: boolean;
		loadOverride?: Constructor<unknown>[];
	}

	export const flameworkConfig: FlameworkConfig = {
		isDefault: true,
	};
	export let isInitialized = false;
	let isPreloading = false;

	/** @hidden */
	export function resolveDependency(id: string) {
		if (isPreloading) {
			const [source, line] = debug.info(2, "sl");
			warn(`[Flamework] Attempting to load dependency '${id}' during preloading.`);
			warn("This is prone to race conditions and is not guaranteed to succeed.");
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

		const preload = (moduleScript: ModuleScript) => {
			isPreloading = true;
			const start = os.clock();
			const [success, value] = pcall(require, moduleScript);
			const endTime = math.floor((os.clock() - start) * 1000);
			isPreloading = false;
			if (!success) {
				throw `${moduleScript.GetFullName()} failed to preload (${endTime}ms): ${value}`;
			}
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

	/** @hidden */
	export function _implements<T>(object: unknown, id: string): object is T {
		return Reflect.getMetadatas<string[]>(object as object, "flamework:implements").some((impl) =>
			impl.includes(id),
		);
	}

	function isService(ctor: object) {
		return Modding.getDecorator<typeof Service>(ctor) !== undefined;
	}

	function isController(ctor: object) {
		return Modding.getDecorator<typeof Controller>(ctor) !== undefined;
	}

	function isConstructor(obj: object): obj is Constructor {
		return "new" in obj && "constructor" in obj;
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

	const externalClasses = new Set<Constructor>();

	/**
	 * Allow an external module to be bootstrapped by Flamework.ignite()
	 */
	export function registerExternalClass(ctor: Constructor) {
		externalClasses.add(ctor);
	}

	type LoadableConfigs = ServiceConfig | ControllerConfig;
	let hasFlameworkIgnited = false;

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
	export function ignite(patchedConfig?: Partial<FlameworkConfig>) {
		if (hasFlameworkIgnited) throw "Flamework.ignite() should only be called once";
		hasFlameworkIgnited = true;

		if (patchedConfig) {
			for (const [key, value] of pairs(patchedConfig)) {
				flameworkConfig[key as never] = value as never;
			}
		}

		for (const [ctor] of Reflect.objToId) {
			if (RunService.IsServer() && !isService(ctor)) continue;
			if (RunService.IsClient() && !isController(ctor)) continue;
			if (!isConstructor(ctor)) continue;

			const isPatched = Reflect.getOwnMetadata<boolean>(ctor, "flamework:isPatched");
			if (flameworkConfig.loadOverride && !flameworkConfig.loadOverride.includes(ctor) && !isPatched) continue;

			const isExternal = Reflect.getOwnMetadata<boolean>(ctor, "flamework:isExternal");
			if (isExternal && !externalClasses.has(ctor as Constructor)) continue;

			Modding.resolveSingleton(ctor);
		}

		const dependencies = new Array<[object, LoadableConfigs]>();
		const decoratorType = RunService.IsServer()
			? Flamework.id<typeof Service>()
			: Flamework.id<typeof Controller>();

		for (const [ctor] of Modding.getSingletons()) {
			const decorator = Modding.getDecorator<typeof Service | typeof Controller>(ctor, undefined, decoratorType);
			if (!decorator) continue;

			const isExternal = Reflect.getOwnMetadata<boolean>(ctor, "flamework:isExternal");
			if (isExternal && !externalClasses.has(ctor as Constructor)) continue;

			const dependency = Modding.resolveSingleton(ctor);
			dependencies.push([dependency, decorator.arguments[0] || {}]);
		}

		const sortedDependencies = topologicalSort(dependencies.map(([obj]) => getIdentifier(obj)));
		const start = new Array<[OnStart, string]>();
		const init = new Array<[OnInit, string]>();

		const tick = new Map<OnTick, string>();
		const render = new Map<OnRender, string>();
		const physics = new Map<OnPhysics, string>();

		dependencies.sort(([depA, configA], [depB, configB]) => {
			const aOrder = configA.loadOrder ?? 1;
			const bOrder = configB.loadOrder ?? 1;
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
			debug.setmemorycategory(identifier);
			const initResult = dependency.onInit();
			if (Promise.is(initResult)) {
				const [status, value] = initResult.awaitStatus();
				if (status === Promise.Status.Rejected) {
					throw `OnInit failed for dependency '${identifier}'. ${tostring(value)}`;
				}
			}
			debug.resetmemorycategory();
		}

		isInitialized = true;

		RunService.Heartbeat.Connect((dt) => {
			for (const [dependency, identifier] of tick) {
				task.spawn(() => {
					debug.setmemorycategory(identifier);
					dependency.onTick(dt);
				});
			}
		});

		RunService.Stepped.Connect((time, dt) => {
			for (const [dependency, identifier] of physics) {
				task.spawn(() => {
					debug.setmemorycategory(identifier);
					dependency.onPhysics(dt, time);
				});
			}
		});

		if (RunService.IsClient()) {
			RunService.RenderStepped.Connect((dt) => {
				for (const [dependency, identifier] of render) {
					task.spawn(() => {
						debug.setmemorycategory(identifier);
						dependency.onRender(dt);
					});
				}
			});
		}

		for (const [dependency, indentifier] of start) {
			task.spawn(() => {
				debug.setmemorycategory(indentifier);
				dependency.onStart();
			});
		}

		return dependencies;
	}

	/**
	 * Preload the specified paths by requiring all ModuleScript descendants.
	 */
	export declare function addPaths(...args: string[]): void;

	/**
	 * Retrieve the identifier for the specified type.
	 */
	export declare function id<T>(): string;

	/**
	 * Check if the constructor implements the specified interface.
	 */
	export declare function implements<T>(object: Constructor): boolean;

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

	/**
	 * Utility for use in test suites, not recommended for anything else.
	 */
	export namespace Testing {
		export function patchDependency<T>(patchedClass: Constructor<unknown>, id?: string) {
			if (id === undefined) throw `Patching failed, no ID`;

			const idCtor = Reflect.idToObj.get(id) as Constructor;
			if (idCtor === undefined) throw `Dependency ${id} was not found and cannot be patched.`;
			if (Modding.getSingletons().has(idCtor)) throw `${id} has already been resolved, continuing is unsafe`;

			const objMetadata = Reflect.metadata.get(idCtor);
			if (!objMetadata) throw `Dependency ${id} has no existing metadata.`;

			Reflect.defineMetadata(idCtor, "flamework:isPatched", true);
			Reflect.metadata.delete(idCtor);
			Reflect.metadata.set(patchedClass, objMetadata);

			Reflect.objToId.set(patchedClass, id);
			Reflect.idToObj.set(id, patchedClass);
		}
	}
}

/**
 * An internal class used for resolving the Dependency<T> macro.
 */
class ArtificialDependency {}
Reflect.defineMetadata(ArtificialDependency, "identifier", Flamework.id<ArtificialDependency>());
Reflect.defineMetadata(ArtificialDependency, "flamework:isArtificial", true);

export declare function Dependency<T>(): T;
export declare function Dependency<T>(ctor: Constructor<T>): T;
export declare function Dependency<T>(ctor?: Constructor<T>): T;

/**
 * Register a class as a Service.
 *
 * @server
 * @metadata flamework:implements flamework:parameters
 */
export const Service = Modding.createMetaDecorator<[opts?: Flamework.ServiceConfig]>("Class");

/**
 * Register a class as a Controller.
 *
 * @client
 * @metadata flamework:implements flamework:parameters
 */
export const Controller = Modding.createMetaDecorator<[opts?: Flamework.ControllerConfig]>("Class");

/**
 * Marks this class as an external class.
 *
 * External classes are designed for packages and won't be
 * bootstrapped unless explicitly specified. Excluding this
 * inside of a package will make the class load as long as
 * it has been loaded.
 */
export const External = Modding.createDecorator("Class", (descriptor) => {
	Reflect.defineMetadata(descriptor.object, `flamework:isExternal`, true);
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
