import { Players, RunService } from "@rbxts/services";
import { t } from "@rbxts/t";
import { Modding } from "./modding";
import { Reflect } from "./reflect";
import { Constructor } from "./types";

export namespace Flamework {
	export interface ComponentConfig {
		tag?: string;
		attributes?: { [key: string]: t.check<unknown> };
		defaults?: { [key: string]: unknown };
		instanceGuard?: t.check<unknown>;
		refreshAttributes?: boolean;
	}
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

	/** @hidden */
	export function resolveDependency(id: string) {
		const ctor = Reflect.idToObj.get(id);
		if (ctor === undefined) throw `Dependency ${id} could not be found.`;
		if (!isConstructor(ctor)) throw `Dependency ${id} did not resolve to a constructor.`;

		return Modding.resolveSingleton(ctor);
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
			const start = os.clock();
			const result = opcall(require, moduleScript);
			const endTime = math.floor((os.clock() - start) * 1000);
			if (!result.success) {
				throw `${moduleScript.GetFullName()} failed to preload (${endTime}ms): ${result.error}`;
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

		for (const [ctor, identifier] of Reflect.objToId) {
			if (RunService.IsServer() && !isService(ctor)) continue;
			if (RunService.IsClient() && !isController(ctor)) continue;
			if (!isConstructor(ctor)) continue;

			const isPatched = Reflect.getOwnMetadata<boolean>(ctor, "flamework:isPatched");
			if (flameworkConfig.loadOverride && !flameworkConfig.loadOverride.includes(ctor) && !isPatched) continue;

			const isExternal = Reflect.getOwnMetadata<boolean>(ctor, "flamework:isExternal");
			if (isExternal && !externalClasses.has(ctor as Constructor)) continue;

			Modding.resolveSingleton(ctor);
		}

		const dependencies = new Array<[unknown, LoadableConfigs]>();
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

		const start = new Array<OnStart>();
		const init = new Array<OnInit>();

		const tick = new Set<OnTick>();
		const render = new Set<OnRender>();
		const physics = new Set<OnPhysics>();

		dependencies.sort(([, a], [, b]) => (a.loadOrder ?? 1) < (b.loadOrder ?? 1));

		Modding.onListenerAdded<OnTick>((object) => tick.add(object));
		Modding.onListenerAdded<OnPhysics>((object) => physics.add(object));
		Modding.onListenerAdded<OnRender>((object) => render.add(object));

		Modding.onListenerRemoved<OnTick>((object) => tick.delete(object));
		Modding.onListenerRemoved<OnPhysics>((object) => physics.delete(object));
		Modding.onListenerRemoved<OnRender>((object) => render.delete(object));

		for (const [dependency] of dependencies) {
			if (Flamework.implements<OnInit>(dependency)) init.push(dependency);
			if (Flamework.implements<OnStart>(dependency)) start.push(dependency);
		}

		for (const dependency of init) {
			debug.setmemorycategory(Reflect.getMetadata<string>(dependency, "identifier")!);
			const initResult = dependency.onInit();
			if (Promise.is(initResult)) {
				initResult.await();
			}
			debug.resetmemorycategory();
		}

		isInitialized = true;

		RunService.Heartbeat.Connect((dt) => {
			for (const dependency of tick) {
				task.spawn(() => {
					debug.setmemorycategory(Reflect.getMetadata<string>(dependency, "identifier")!);
					dependency.onTick(dt);
				});
			}
		});

		RunService.Stepped.Connect((time, dt) => {
			for (const dependency of physics) {
				task.spawn(() => {
					debug.setmemorycategory(Reflect.getMetadata<string>(dependency, "identifier")!);
					dependency.onPhysics(dt, time);
				});
			}
		});

		if (RunService.IsClient()) {
			RunService.RenderStepped.Connect((dt) => {
				for (const dependency of render) {
					task.spawn(() => {
						debug.setmemorycategory(Reflect.getMetadata<string>(dependency, "identifier")!);
						dependency.onRender(dt);
					});
				}
			});
		}

		for (const dependency of start) {
			task.spawn(() => {
				debug.setmemorycategory(Reflect.getMetadata<string>(dependency, "identifier")!);
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
