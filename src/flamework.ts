import { Players, RunService } from "@rbxts/services";
import { t } from "@rbxts/t";
import { Networking } from "./networking";
import { Constructor } from "./types";

export namespace Flamework {
	export interface Decorator {
		identifier: string;
		config: Config;
	}

	export interface Metadata {
		identifier: string;
		isExternal: boolean;
		isPatched?: boolean;
		implements?: string[];
		dependencies?: string[];
		decorators: Decorator[];
	}

	export type Config =
		| (ComponentConfig & { type: "Component" })
		| (ServiceConfig & { type: "Service" })
		| (ControllerConfig & { type: "Controller" })
		| (ArbitraryConfig & { type: "Arbitrary" });

	export type ConfigType<T extends keyof ConfigTypes> = _<Extract<Config, { type: T }>>;

	export interface ConfigTypes {
		Component: ComponentConfig;
		Service: ServiceConfig;
		Controller: ControllerConfig;
		Arbitrary: ArbitraryConfig;
	}

	export interface ComponentConfig {
		tag?: string;
		attributes?: { [key: string]: t.check<unknown> };
		refreshAttributes?: boolean;
	}
	export interface ServiceConfig {
		loadOrder?: number;
	}
	export interface ControllerConfig {
		loadOrder?: number;
	}
	export interface ArbitraryConfig {
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

	export const metadata = new Map<Constructor, Metadata>();
	export const targetToId = new Map<Constructor, string>();
	export const idToTarget = new Map<string, Constructor>();

	/** @hidden */
	export function registerMetadata(target: defined, data: Metadata) {
		const ctor = target as Constructor;
		metadata.set(ctor, data);
		targetToId.set(ctor, data.identifier);
		idToTarget.set(data.identifier, ctor);
	}

	const resolvedDependencies = new Map<string, unknown>();
	const loadingList = new Array<Constructor>();

	/** @hidden */
	export function createDependency(ctor: Constructor) {
		if (loadingList.includes(ctor)) throw `Circular dependency detected ${loadingList.join(" <=> ")} <=> ${ctor}`;
		loadingList.push(ctor);

		const dependencyMetadata = metadata.get(ctor);
		if (!dependencyMetadata) throw `Dependency ${id} metadata is missing.`;

		const constructorDependencies: never[] = [];
		if (dependencyMetadata.dependencies) {
			for (const [index, dependencyId] of pairs(dependencyMetadata.dependencies)) {
				const dependency = resolveDependency(dependencyId);
				constructorDependencies[index - 1] = dependency as never;
			}
		}

		const dependency = new ctor(...constructorDependencies);
		loadingList.pop();

		return dependency;
	}

	/** @hidden */
	export function resolveDependency(id: string) {
		const resolvedDependency = resolvedDependencies.get(id);
		if (resolvedDependency !== undefined) return resolvedDependency;

		const ctor = idToTarget.get(id);
		if (ctor === undefined) throw `Dependency ${id} could not be found.`;

		const dependency = createDependency(ctor);
		resolvedDependencies.set(id, dependency);

		return dependency;
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

	/** @hidden */
	export function _implements<T>(object: unknown, id: string): object is T {
		let objectMetadata: Metadata | undefined;
		while (objectMetadata === undefined && object !== undefined) {
			objectMetadata = metadata.get(object as Constructor);
			if (objectMetadata) break;

			const mt = getmetatable(object as object) as { __index?: Constructor };
			if (mt) {
				object = mt.__index;
			} else {
				object = undefined;
			}
		}

		if (!objectMetadata) return false;
		if (!objectMetadata.implements) return false;

		return objectMetadata.implements.includes(id);
	}

	function getDecorator<T extends Exclude<keyof ConfigTypes, "Arbitrary">>(ctor: Constructor, configType: T) {
		const objectMetadata = metadata.get(ctor);
		if (!objectMetadata) return undefined;

		for (const decorator of objectMetadata.decorators) {
			if (decorator.config.type === configType) {
				return decorator as { identifier: string; config: ConfigTypes[T] & { type: T } };
			}
		}
	}

	function fastSpawn(func: () => unknown) {
		const bindable = new Instance("BindableEvent");
		bindable.Event.Connect(func);
		bindable.Fire();
		bindable.Destroy();
	}

	const externalClasses = new Set<Constructor>();

	/**
	 * Allow an external module to be bootstrapped by Flamework.ignite()
	 */
	export function registerExternalClass(ctor: Constructor) {
		externalClasses.add(ctor);
	}

	type LoadableConfigs = Extract<Config, { type: "Service" | "Controller" }>;
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

		for (const [ctor, objectMetadata] of metadata) {
			if (flameworkConfig.loadOverride && !flameworkConfig.loadOverride.includes(ctor)) {
				if (!objectMetadata.isPatched) continue;
			}
			resolveDependency(objectMetadata.identifier);
		}

		const dependencies = new Array<[unknown, Metadata, LoadableConfigs]>();
		const decoratorType = RunService.IsServer() ? "Service" : "Controller";

		for (const [id] of resolvedDependencies) {
			const ctor = idToTarget.get(id);
			if (ctor === undefined) throw `Could not find constructor for ${id}`;

			const objectMetadata = metadata.get(ctor);
			if (objectMetadata === undefined) throw `Could not find metadata for ${id}`;

			const decorator = getDecorator(ctor, decoratorType);
			if (!decorator) continue;

			if (objectMetadata.isExternal && !externalClasses.has(ctor)) continue;

			const dependency = resolveDependency(objectMetadata.identifier);
			dependencies.push([dependency, objectMetadata, decorator.config]);
		}

		const start = new Array<[OnStart, Metadata, LoadableConfigs]>();
		const init = new Array<[OnInit, Metadata, LoadableConfigs]>();

		const tick = new Array<OnTick>();
		const render = new Array<OnRender>();
		const physics = new Array<OnPhysics>();

		dependencies.sort(([, , a], [, , b]) => (a.loadOrder ?? 1) < (b.loadOrder ?? 1));

		for (const [dependency, objectMetadata, config] of dependencies) {
			if (Flamework.implements<OnInit>(dependency)) init.push([dependency, objectMetadata, config]);
			if (Flamework.implements<OnStart>(dependency)) start.push([dependency, objectMetadata, config]);

			if (Flamework.implements<OnTick>(dependency)) tick.push(dependency);
			if (Flamework.implements<OnPhysics>(dependency)) physics.push(dependency);
			if (Flamework.implements<OnRender>(dependency)) render.push(dependency);
		}

		for (const [dependency] of init) {
			const initResult = dependency.onInit();
			if (Promise.is(initResult)) {
				initResult.await();
			}
		}

		isInitialized = true;

		RunService.Heartbeat.Connect((dt) => {
			for (const dependency of tick) {
				coroutine.wrap(() => dependency.onTick(dt))();
			}
		});

		RunService.Stepped.Connect((time, dt) => {
			for (const dependency of physics) {
				coroutine.wrap(() => dependency.onPhysics(dt, time))();
			}
		});

		if (RunService.IsClient()) {
			RunService.RenderStepped.Connect((dt) => {
				for (const dependency of render) {
					coroutine.wrap(() => dependency.onRender(dt))();
				}
			});
		}

		for (const [dependency] of start) {
			fastSpawn(() => dependency.onStart());
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
	 * Check if object implements the specified interface.
	 */
	export declare function implements<T>(object: unknown): object is T;

	/**
	 * Creates a type guard from any arbitrary type.
	 */
	export declare function createGuard<T>(): t.check<T>;

	/**
	 * Creates a type guard from any arbitrary type.
	 */
	export declare function createEvent<S, C>(
		serverMiddleware?: Networking.EventMiddleware<S>,
		clientMiddleware?: Networking.EventMiddleware<C>,
	): Networking.EventType<S, C>;

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
			if (resolvedDependencies.has(id)) throw `${id} has already been resolved, continuing is unsafe`;

			const idCtor = idToTarget.get(id);
			if (idCtor === undefined) throw `Dependency ${id} was not found and cannot be patched.`;

			const classMetadata = metadata.get(idCtor);
			if (!classMetadata) throw `Dependency ${id} has no existing metadata.`;

			classMetadata.isPatched = true;
			metadata.delete(idCtor);
			metadata.set(patchedClass, classMetadata);
			targetToId.set(patchedClass, id);
			idToTarget.set(id, patchedClass);
		}
	}
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ClassDecorator = (ctor: any) => any;

export declare function Dependency<T>(): T;
export declare function Dependency<T>(ctor: Constructor<T>): T;
export declare function Dependency<T>(ctor?: Constructor<T>): T;

/**
 * Register a class as a Component.
 */
export declare function Component(opts?: Flamework.ComponentConfig): ClassDecorator;

/**
 * Register a class as a Service.
 *
 * @server
 */
export declare function Service(opts?: Flamework.ServiceConfig): ClassDecorator;

/**
 * Register a class as a Controller.
 *
 * @client
 */
export declare function Controller(opts?: Flamework.ControllerConfig): ClassDecorator;

/**
 * Marks this class as an external class.
 *
 * External classes are designed for packages and won't be
 * bootstrapped unless explicitly specified. Excluding this
 * inside of a package will make the class load as long as
 * it has been loaded.
 */
export declare function External(): ClassDecorator;

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
	 */
	onRender(dt: number): void;
}
