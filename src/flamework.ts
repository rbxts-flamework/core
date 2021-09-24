import Object from "@rbxts/object-utils";
import { Players, RunService } from "@rbxts/services";
import { t } from "@rbxts/t";
import { Modding } from "./modding";
import { Reflect } from "./reflect";
import { Config, ConfigTypes, Constructor, ControllerConfig, FlameworkConfig, ServiceConfig } from "./types";
import { isConstructor } from "./util/isConstructor";

export namespace Flamework {
	export const flameworkConfig: FlameworkConfig = {
		isDefault: true,
	};
	export let isInitialized = false;

	const resolvedDependencies = new Map<string, unknown>();
	const loadingList = new Array<Constructor>();

	/** @hidden */
	export function createDependency(ctor: Constructor) {
		if (loadingList.includes(ctor)) throw `Circular dependency detected ${loadingList.join(" <=> ")} <=> ${ctor}`;
		loadingList.push(ctor);

		const dependencies = Reflect.getMetadata<string[]>(ctor, "flamework:dependencies");

		const constructorDependencies: never[] = [];
		if (dependencies) {
			for (const [index, dependencyId] of pairs(dependencies)) {
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

		const ctor = Reflect.idToObj.get(id);
		if (ctor === undefined) throw `Dependency ${id} could not be found.`;

		assert(isConstructor(ctor));

		const dependency = createDependency(ctor);
		resolvedDependencies.set(id, dependency);

		Modding.addListenerObject(dependency as object);
		return dependency;
	}

	function getDecorator<T extends Exclude<keyof ConfigTypes, "Arbitrary">>(ctor: object, configType: T) {
		const decorators = Reflect.getMetadatas<string[]>(ctor, "flamework:decorators");
		if (!decorators) return undefined;

		for (const decoratorIds of decorators) {
			for (const decoratorId of decoratorIds) {
				const config = Reflect.getMetadata<Config>(ctor, `flamework:decorators.${decoratorId}`);
				if (config?.type === configType) {
					return config as ConfigTypes[T] & { type: T };
				}
			}
		}
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

		for (const [ctor, identifier] of Reflect.objToId) {
			if (!isConstructor(ctor)) continue;

			const isPatched = Reflect.getOwnMetadata<boolean>(ctor, "flamework:isPatched");
			if (flameworkConfig.loadOverride && !flameworkConfig.loadOverride.includes(ctor)) {
				if (!isPatched) continue;
			}
			resolveDependency(identifier);
		}

		const dependencies = new Array<[unknown, LoadableConfigs]>();
		const decoratorType = RunService.IsServer() ? "Service" : "Controller";

		for (const [id] of resolvedDependencies) {
			const ctor = Reflect.idToObj.get(id);
			if (ctor === undefined) throw `Could not find constructor for ${id}`;

			const decorator = getDecorator(ctor, decoratorType);
			if (!decorator) continue;

			const isExternal = Reflect.getOwnMetadata<boolean>(ctor, "flamework:isExternal");
			if (isExternal && !externalClasses.has(ctor as Constructor)) continue;

			const dependency = resolveDependency(id);
			dependencies.push([dependency, decorator]);
		}

		const start = new Array<OnStart>();
		const init = new Array<OnInit>();

		const tick = new Array<OnTick>();
		const render = new Array<OnRender>();
		const physics = new Array<OnPhysics>();

		dependencies.sort(([, a], [, b]) => (a.loadOrder ?? 1) < (b.loadOrder ?? 1));

		for (const [dependency] of dependencies) {
			if (Flamework.implements<OnInit>(dependency)) init.push(dependency);
			if (Flamework.implements<OnStart>(dependency)) start.push(dependency);

			if (Flamework.implements<OnTick>(dependency)) tick.push(dependency);
			if (Flamework.implements<OnPhysics>(dependency)) physics.push(dependency);
			if (Flamework.implements<OnRender>(dependency)) render.push(dependency);
		}

		for (const dependency of init) {
			const initResult = dependency.onInit();
			if (Promise.is(initResult)) {
				initResult.await();
			}
		}

		isInitialized = true;

		RunService.Heartbeat.Connect((dt) => {
			for (const dependency of tick) {
				task.spawn(() => dependency.onTick(dt));
			}
		});

		RunService.Stepped.Connect((time, dt) => {
			for (const dependency of physics) {
				task.spawn(() => dependency.onPhysics(dt, time));
			}
		});

		if (RunService.IsClient()) {
			RunService.RenderStepped.Connect((dt) => {
				for (const dependency of render) {
					task.spawn(() => dependency.onRender(dt));
				}
			});
		}

		for (const dependency of start) {
			task.spawn(() => dependency.onStart());
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

			const idCtor = Reflect.idToObj.get(id) as Constructor;
			if (idCtor === undefined) throw `Dependency ${id} was not found and cannot be patched.`;

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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ClassDecorator = (ctor: any) => any;

export declare function Dependency<T>(): T;
export declare function Dependency<T>(ctor: Constructor<T>): T;
export declare function Dependency<T>(ctor?: Constructor<T>): T;

/**
 * Register a class as a Service.
 *
 * @server
 */
export declare function Service(opts?: ServiceConfig): ClassDecorator;

/**
 * Register a class as a Controller.
 *
 * @client
 */
export declare function Controller(opts?: ControllerConfig): ClassDecorator;

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
