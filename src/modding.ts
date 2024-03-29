import Signal from "@rbxts/signal";
import { Reflect } from "./reflect";
import { AbstractConstructor, Constructor, IntrinsicSymbolId, isConstructor } from "./utility";
import type { Flamework } from "./flamework";
import { t } from "@rbxts/t";

interface BaseDescriptor {
	/**
	 * The ID of this decorator.
	 */
	id: string;

	/**
	 * The object this decorator is attached to.
	 */
	object: AbstractConstructor;

	/**
	 * The constructor this decorator is attached to, unless abstract.
	 */
	constructor?: Constructor;
}

export interface ClassDescriptor extends BaseDescriptor {}
export interface MethodDescriptor extends PropertyDescriptor {}
export interface PropertyDescriptor extends BaseDescriptor {
	property: string;
	isStatic: boolean;
}

interface AttachedDecorator<T extends readonly unknown[]> {
	object: AbstractConstructor;
	constructor?: Constructor;
	arguments: T;
}

type TSDecorator<T> = T & { /** @hidden */ _flamework_Decorator: never };
type ClassDecorator = TSDecorator<(ctor: defined) => never>;
type MethodDecorator = TSDecorator<(target: defined, propertyKey: string, descriptor: defined) => never>;
type PropertyDecorator = TSDecorator<(target: defined, propertyKey: string) => never>;
type DecoratorWithMetadata<T, P> = T & { _flamework_Parameters: P };
type DecoratorParameters<T> = T extends { _flamework_Parameters: infer P } ? P : [];
type AnyDecorator = DecoratorWithMetadata<(...args: never[]) => unknown, unknown[]>;
type Decorator<P extends readonly unknown[], D> = DecoratorWithMetadata<
	P extends { length: 0 } ? ((...args: P) => D) & D : (...args: P) => D,
	P
>;

type ListenerAddedEvent = (object: object) => void;
type ListenerRemovedEvent = (object: object) => void;
type DependencyRegistration = object | ((ctor: Constructor) => object);

interface Listener {
	eventIds: Set<string>;
	involvement: Set<object>[];
}

export namespace Modding {
	const listeners = new Map<object, Listener>();
	const lifecycleListeners = new Map<string, Set<object>>();
	const decoratorListeners = new Map<string, Set<object>>();

	const listenerAdded = new Signal<ListenerAddedEvent>();
	const listenerRemoved = new Signal<ListenerRemovedEvent>();
	const listenerAddedEvents = new Map<string, Signal<ListenerAddedEvent>>();
	const listenerRemovedEvents = new Map<string, Signal<ListenerRemovedEvent>>();

	const dependencyResolution = new Map<string, (ctor: Constructor) => object>();
	const resolvedSingletons = new Map<Constructor, object>();
	const loadingList = new Array<Constructor>();

	/**
	 * Retrieves an object from its identifier.
	 *
	 * The reverse (getting an identifier from an object) can be achieved using the Reflect API directly.
	 */
	export function getObjectFromId(id: string) {
		return Reflect.idToObj.get(id);
	}

	/**
	 * Registers a listener for lifecycle events.
	 */
	export function addListener(object: object) {
		const listener: Listener = {
			eventIds: new Set(),
			involvement: [],
		};

		for (const lifecycleEvents of Reflect.getMetadatas<string[]>(object, `flamework:implements`)) {
			for (const lifecycleEvent of lifecycleEvents) {
				if (listener.eventIds.has(lifecycleEvent)) continue;

				let lifecycleListener = lifecycleListeners.get(lifecycleEvent);
				if (!lifecycleListener) lifecycleListeners.set(lifecycleEvent, (lifecycleListener = new Set()));

				lifecycleListener.add(object);
				listener.eventIds.add(lifecycleEvent);
				listener.involvement.push(lifecycleListener);
				listenerAddedEvents.get(lifecycleEvent)?.Fire(object);
			}
		}

		const decorators = Reflect.getMetadata<string[]>(object, `flamework:decorators`);
		if (decorators) {
			for (const decorator of decorators) {
				if (listener.eventIds.has(decorator)) continue;

				let decoratorListener = decoratorListeners.get(decorator);
				if (!decoratorListener) decoratorListeners.set(decorator, (decoratorListener = new Set()));

				decoratorListener.add(object);
				listener.eventIds.add(decorator);
				listener.involvement.push(decoratorListener);
				listenerAddedEvents.get(decorator)?.Fire(object);
			}
		}

		listeners.set(object, listener);
		listenerAdded.Fire(object);
	}

	/**
	 * Removes a listener for lifecycle events and decorators.
	 */
	export function removeListener(object: object) {
		const listener = listeners.get(object);
		if (!listener) return;

		for (const set of listener.involvement) {
			set.delete(object);
		}

		for (const id of listener.eventIds) {
			listenerRemovedEvents.get(id)?.Fire(object);
		}

		listeners.delete(object);
		listenerRemoved.Fire(object);
	}

	/**
	 * Registers a listener added event.
	 * Fires whenever any listener is added.
	 *
	 * Fires for all existing listeners.
	 */
	export function onListenerAdded(func: ListenerAddedEvent): RBXScriptConnection;

	/**
	 * Registers a listener added event.
	 * Fires whenever a listener has a decorator with the specified ID.
	 *
	 * Fires for all existing listeners.
	 *
	 * @metadata macro
	 */
	export function onListenerAdded<T extends AnyDecorator>(
		func: ListenerAddedEvent,
		id?: IdRef<T>,
	): RBXScriptConnection;

	/**
	 * Registers a listener added event.
	 * Fires whenever a listener has a lifecycle event with the specified ID.
	 *
	 * Fires for all existing listeners.
	 *
	 * @metadata macro
	 */
	export function onListenerAdded<T>(func: (value: T) => void, id?: IdRef<T>): RBXScriptConnection;

	/**
	 * Registers a listener added event.
	 */
	export function onListenerAdded(func: ListenerAddedEvent, id?: string) {
		if (id !== undefined) {
			let listenerAddedEvent = listenerAddedEvents.get(id);
			if (!listenerAddedEvent) listenerAddedEvents.set(id, (listenerAddedEvent = new Signal()));

			const existingListeners = lifecycleListeners.get(id) || decoratorListeners.get(id);
			if (existingListeners) {
				for (const listener of existingListeners) {
					task.spawn(func, listener);
				}
			}

			return listenerAddedEvent.Connect(func);
		} else {
			for (const [listener] of listeners) {
				task.spawn(func, listener);
			}
			return listenerAdded.Connect(func);
		}
	}

	/**
	 * Registers a listener removed event.
	 *
	 * Fires whenever any listener is removed.
	 */
	export function onListenerRemoved(func: ListenerRemovedEvent): RBXScriptConnection;

	/**
	 * Registers a listener removed event.
	 *
	 * Fires whenever a listener has a decorator with the specified ID.
	 *
	 * @metadata macro
	 */
	export function onListenerRemoved<T extends AnyDecorator>(
		func: ListenerRemovedEvent,
		id?: IdRef<T>,
	): RBXScriptConnection;

	/**
	 * Registers a listener removed event.
	 *
	 * Fires whenever a listener has a lifecycle event with the specified ID.
	 *
	 * @metadata macro
	 */
	export function onListenerRemoved<T>(func: (object: T) => void, id?: IdRef<T>): RBXScriptConnection;

	/**
	 * Registers a listener removed event.
	 */
	export function onListenerRemoved(func: ListenerRemovedEvent, id?: string) {
		if (id !== undefined) {
			let listenerRemovedEvent = listenerRemovedEvents.get(id);
			if (!listenerRemovedEvent) listenerRemovedEvents.set(id, (listenerRemovedEvent = new Signal()));

			return listenerRemovedEvent.Connect(func);
		} else {
			return listenerRemoved.Connect(func);
		}
	}

	/**
	 * Registers a class decorator.
	 */
	export function createDecorator<T extends readonly unknown[] = void[]>(
		kind: "Class",
		func: (descriptor: ClassDescriptor, config: T) => void,
	): Decorator<T, ClassDecorator>;

	/**
	 * Registers a method decorator.
	 */
	export function createDecorator<T extends readonly unknown[] = void[]>(
		kind: "Method",
		func: (descriptor: MethodDescriptor, config: T) => void,
	): Decorator<T, MethodDecorator>;

	/**
	 * Registers a property decorator.
	 */
	export function createDecorator<T extends readonly unknown[] = void[]>(
		kind: "Property",
		func: (descriptor: PropertyDescriptor, config: T) => void,
	): Decorator<T, PropertyDecorator>;

	/**
	 * Registers a decorator.
	 */
	export function createDecorator(
		_kind: "Method" | "Property" | "Class",
		func: (...args: never[]) => void,
	): Decorator<void[], ClassDecorator | MethodDecorator | PropertyDecorator> {
		return {
			func: (descriptor: PropertyDescriptor, config: unknown[]) => {
				defineDecoratorMetadata(descriptor, config);
				func(descriptor as never, config as never);
			},
		} as never;
	}

	/**
	 * Registers a metadata class decorator.
	 */
	export function createMetaDecorator<T extends readonly unknown[] = void[]>(
		kind: "Class",
	): Decorator<T, ClassDecorator>;

	/**
	 * Registers a metadata method decorator.
	 */
	export function createMetaDecorator<T extends readonly unknown[] = void[]>(
		kind: "Method",
	): Decorator<T, MethodDecorator>;

	/**
	 * Registers a metadata property decorator.
	 */
	export function createMetaDecorator<T extends readonly unknown[] = void[]>(
		kind: "Property",
	): Decorator<T, PropertyDecorator>;

	/**
	 * Registers a metadata decorator.
	 */
	export function createMetaDecorator(
		_kind: "Method" | "Property" | "Class",
	): Decorator<void[], ClassDecorator | MethodDecorator | PropertyDecorator> {
		return {
			func: (descriptor: PropertyDescriptor, config: unknown[]) => {
				defineDecoratorMetadata(descriptor, config);
			},
		} as never;
	}

	/**
	 * Retrieves registered decorators.
	 *
	 * @metadata macro
	 */
	export function getDecorators<T extends AnyDecorator>(id?: IdRef<T>): AttachedDecorator<DecoratorParameters<T>>[] {
		assert(id !== undefined);

		const decorators = Reflect.decorators.get(id);
		if (!decorators) return [];

		return decorators.map((object) => {
			const decoratorConfig = Reflect.getOwnMetadata<Flamework.Decorator>(object, `flamework:decorators.${id}`);
			assert(decoratorConfig);

			return {
				object,
				constructor: isConstructor(object) ? object : undefined,
				arguments: decoratorConfig.arguments as DecoratorParameters<T>,
			};
		});
	}

	/**
	 * Creates a map of every property using the specified decorator.
	 *
	 * @metadata macro
	 */
	export function getPropertyDecorators<T extends AnyDecorator>(
		obj: object,
		id?: IdRef<T>,
	): Map<string, { arguments: DecoratorParameters<T> }> {
		const decorators = new Map<string, { arguments: DecoratorParameters<T> }>();
		assert(id !== undefined);

		for (const prop of Reflect.getProperties(obj)) {
			const decorator = getDecorator<T>(obj, prop, id);
			if (decorator) {
				decorators.set(prop, decorator);
			}
		}

		return decorators;
	}

	/**
	 * Retrieves a decorator from an object or its properties.
	 *
	 * @metadata macro
	 */
	export function getDecorator<T extends AnyDecorator>(
		object: object,
		property?: string,
		id?: IdRef<T>,
	): { arguments: DecoratorParameters<T> } | undefined {
		const decorator = Reflect.getMetadata<Flamework.Decorator>(object, `flamework:decorators.${id}`, property);
		if (!decorator) return;

		return decorator as never;
	}

	/**
	 * Retrieves a singleton or instantiates one if it does not exist.
	 */
	export function resolveSingleton<T extends object>(ctor: Constructor<T>): T {
		const resolvedDependency = resolvedSingletons.get(ctor);
		if (resolvedDependency !== undefined) return resolvedDependency as T;
		if (loadingList.includes(ctor)) throw `Circular dependency detected ${loadingList.join(" <=> ")} <=> ${ctor}`;

		loadingList.push(ctor);
		// Flamework can resolve singletons at any arbitrary point,
		// so we should fetch custom dependency resolution (added via decorator) through the Reflect api.
		const opts = Reflect.getOwnMetadata<DependencyResolutionOptions>(ctor, "flamework:dependency_resolution");
		const dependency = createDependency(ctor, opts);
		resolvedSingletons.set(ctor, dependency);
		loadingList.pop();

		addListener(dependency);
		return dependency;
	}

	/** @internal Used for bootstrapping */
	export function getSingletons() {
		return resolvedSingletons;
	}

	/**
	 * Modifies dependency resolution for a specific ID.
	 *
	 * If a function is passed, it will be called, passing the target constructor, every time that ID needs to be resolved.
	 * Otherwise, the passed object is returned directly.
	 *
	 * @metadata macro
	 */
	export function registerDependency<T>(dependency: DependencyRegistration, id?: IdRef<T>) {
		assert(id !== undefined);

		if (typeIs(dependency, "function")) {
			dependencyResolution.set(id, dependency);
		} else {
			dependencyResolution.set(id, () => dependency);
		}
	}

	/**
	 * Instantiates this class using dependency injection.
	 */
	export function createDependency<T extends object>(
		ctor: Constructor<T>,
		options: DependencyResolutionOptions = {},
	) {
		const [obj, construct] = createDeferredDependency(ctor, options);
		construct();
		return obj;
	}

	/**
	 * Creates an object for this class and returns a deferred constructor.
	 */
	export function createDeferredDependency<T extends object>(
		ctor: Constructor<T>,
		options: DependencyResolutionOptions = {},
	) {
		const [obj, construct] = getDeferredConstructor(ctor);

		return [
			obj as T,
			() => {
				const dependencies = Reflect.getMetadata<string[]>(ctor, "flamework:parameters");
				const constructorDependencies: never[] = [];
				if (dependencies) {
					for (const [index, dependencyId] of pairs(dependencies)) {
						constructorDependencies[index - 1] = resolveDependency(
							ctor,
							dependencyId,
							index - 1,
							options,
						) as never;
					}
				}
				construct(...constructorDependencies);
			},
		] as const;
	}

	/**
	 * Dependency resolution logic.
	 * @internal
	 */
	export function resolveDependency(
		ctor: Constructor,
		dependencyId: string,
		index: number,
		options: DependencyResolutionOptions,
	) {
		if (options.handle !== undefined) {
			const dependency = options.handle(dependencyId, index);
			if (dependency !== undefined) {
				return dependency;
			}
		}

		const resolution = dependencyResolution.get(dependencyId);
		if (resolution !== undefined) {
			return resolution(ctor);
		}

		const dependencyCtor = Reflect.idToObj.get(dependencyId);
		if (dependencyCtor && isConstructor(dependencyCtor)) {
			return resolveSingleton(dependencyCtor);
		}

		if (dependencyId.sub(1, 2) === "$p") {
			if (dependencyId.sub(1, 3) === "$ps") {
				return dependencyId.sub(5);
			}

			if (dependencyId.sub(1, 3) === "$pn") {
				return tonumber(dependencyId.sub(5)) ?? 0;
			}

			if (options.handlePrimitive !== undefined) {
				return options.handlePrimitive(dependencyId, index);
			}

			throw `Unexpected primitive dependency '${dependencyId}' while constructing ${ctor}`;
		}

		throw `Could not find constructor for ${dependencyId} while constructing ${ctor}`;
	}

	/**
	 * This function is able to utilize Flamework's user macros to generate and inspect types.
	 * This function supports all values natively supported by Flamework's user macros.
	 *
	 * For example, if you want to retrieve the properties of an instance, you could write code like this:
	 * ```ts
	 * // Returns an array of all keys part of the union.
	 * const basePartKeys = Modding.inspect<InstancePropertyNames<BasePart>[]>();
	 * ```
	 *
	 * @metadata macro
	 */
	export function inspect<T>(value?: Modding.Many<T>): T {
		assert(value);
		return value;
	}

	/**
	 * This API allows you to use more complex queries, inspect types, generate arbitrary objects based on types, etc.
	 *
	 * @experimental This API is considered experimental and may change.
	 */
	export type Many<T> = T & {
		/** @hidden */ _flamework_macro_many: T;
	};

	/**
	 * Hashes a string literal type (such as an event name) under Flamework's {@link Many `Many`} API.
	 *
	 * The second type argument, `C`, is for providing a context to the hashing which will generate new hashes
	 * for strings which already have a hash under another context.
	 *
	 * @experimental This API is considered experimental and may change.
	 */
	export type Hash<T extends string, C extends string = never> = string & {
		/** @hidden */ _flamework_macro_hash: [T, C];
	};

	/**
	 * This is equivalent to {@link Hash `Hash`} except it will only hash strings when `obfuscation` is turned on.
	 *
	 * @experimental This API is considered experimental and may change.
	 */
	export type Obfuscate<T extends string, C extends string = never> = string & {
		/** @hidden */ _flamework_macro_hash: [T, C, true];
	};

	/**
	 * Retrieves the labels from this tuple under Flamework's {@link Many `Many`} API.
	 *
	 * This can also be used to extract parameter names via `Parameters<T>`
	 *
	 * @experimental This API is considered experimental and may change.
	 */
	export type TupleLabels<T extends readonly unknown[]> =
		| (string[] & { /** @hidden */ _flamework_macro_tuple_labels: T })
		| undefined;

	/**
	 * Retrieves metadata about the specified type using Flamework's user macros.
	 */
	export type Generic<T, M extends keyof GenericMetadata<T>> = GenericMetadata<T>[M] & {
		/** @hidden */ _flamework_macro_generic: [T, M];
	};

	/**
	 * Retrieves multiple types of metadata from Flamework's user macros.
	 */
	export type GenericMany<T, M extends keyof GenericMetadata<T>> = Modding.Many<{ [k in M]: Generic<T, k> }>;

	/**
	 * Retrieves metadata about the callsite using Flamework's user macros.
	 */
	export type Caller<M extends keyof CallerMetadata> = CallerMetadata[M] & {
		/** @hidden */ _flamework_macro_caller: M;
	};

	/**
	 * Retrieves multiple types of metadata about the callsite using Flamework's user macros.
	 */
	export type CallerMany<M extends keyof CallerMetadata> = Modding.Many<{ [k in M]: Caller<k> }>;

	/**
	 * An internal type for intrinsic user macro metadata.
	 *
	 * @hidden
	 */
	export type Intrinsic<N extends string, M extends unknown[], T = symbol> = T & { _flamework_intrinsic: [N, ...M] };

	function defineDecoratorMetadata(descriptor: PropertyDescriptor, config: unknown[]) {
		const propertyKey = descriptor.isStatic ? `static:${descriptor.property}` : descriptor.property;
		Reflect.defineMetadata(
			descriptor.object,
			`flamework:decorators.${descriptor.id}`,
			{
				arguments: config,
			},
			propertyKey,
		);

		let decoratorList = Reflect.getMetadata<string[]>(descriptor.object, `flamework:decorators`, propertyKey);
		if (!decoratorList) {
			Reflect.defineMetadata(descriptor.object, "flamework:decorators", (decoratorList = []), propertyKey);
		}

		decoratorList.push(descriptor.id);
	}

	interface CallerMetadata {
		/**
		 * The starting line of the expression.
		 */
		line: number;

		/**
		 * The char at the start of the expression relative to the starting line.
		 */
		character: number;

		/**
		 * The width of the expression.
		 * This includes the width of multiline statements.
		 */
		width: number;

		/**
		 * A unique identifier that can be used to identify exact callsites.
		 * This can be used for hooks.
		 */
		uuid: string;

		/**
		 * The source text for the expression.
		 */
		text: string;
	}

	interface GenericMetadata<T> {
		/**
		 * The ID of the type.
		 */
		id: string;

		/**
		 * A string equivalent of the type.
		 */
		text: string;

		/**
		 * A generated guard for the type.
		 */
		guard: t.check<T>;
	}

	type IdRef<T> = string | IntrinsicSymbolId<T>;
}

interface DependencyResolutionOptions {
	/**
	 * Fires whenever a dependency is attempting to be resolved.
	 *
	 * Return undefined to let Flamework resolve it.
	 */
	handle?: (id: string, index: number) => unknown;

	/**
	 * Fires whenever Flamework tries to resolve a primitive (e.g string)
	 */
	handlePrimitive?: (id: string, index: number) => defined;
}

function getDeferredConstructor<T extends Constructor<unknown>>(ctor: T) {
	const obj = setmetatable({}, ctor as never) as InstanceType<T>;

	return [
		obj,
		(...args: ConstructorParameters<T>) => {
			const result = (obj as { "constructor"(...args: unknown[]): unknown }).constructor(...args);
			assert(result === undefined || result === obj, `Deferred constructors are not allowed to return values.`);
		},
	] as const;
}
