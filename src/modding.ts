import Signal from "@rbxts/signal";
import { Reflect } from "./reflect";
import { Constructor } from "./types";
import type { Flamework } from "./flamework";
import { t } from "@rbxts/t";

interface BaseDescriptor {
	/**
	 * The ID of this decorator.
	 */
	id: string;

	/**
	 * The constructor this decorator is attached to.
	 */
	object: Constructor;
}

export interface ClassDescriptor extends BaseDescriptor {}
export interface MethodDescriptor extends PropertyDescriptor {}
export interface PropertyDescriptor extends BaseDescriptor {
	property: string;
	isStatic: boolean;
}

interface AttachedDecorator<T extends readonly unknown[]> {
	object: Constructor;
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
	const resolvedSingletons = new Map<Constructor, unknown>();
	const loadingList = new Array<Constructor>();

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
	 */
	export function onListenerAdded<T extends AnyDecorator>(func: ListenerAddedEvent, id?: string): RBXScriptConnection;

	/**
	 * Registers a listener added event.
	 * Fires whenever a listener has a lifecycle event with the specified ID.
	 *
	 * Fires for all existing listeners.
	 */
	export function onListenerAdded<T>(func: (value: T) => void, id?: string): RBXScriptConnection;

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
	 */
	export function onListenerRemoved<T extends AnyDecorator>(func: ListenerRemovedEvent): RBXScriptConnection;

	/**
	 * Registers a listener removed event.
	 *
	 * Fires whenever a listener has a lifecycle event with the specified ID.
	 */
	export function onListenerRemoved<T>(func: (object: T) => void, id?: string): RBXScriptConnection;

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
	 */
	export function getDecorators<T extends AnyDecorator>(id?: string): AttachedDecorator<DecoratorParameters<T>>[] {
		assert(id !== undefined);

		const decorators = Reflect.decorators.get(id);
		if (!decorators) return [];

		return decorators.map((object) => {
			const decoratorConfig = Reflect.getOwnMetadata<Flamework.Decorator>(object, `flamework:decorators.${id}`);
			assert(decoratorConfig);

			return {
				object: object,
				arguments: decoratorConfig.arguments,
			} as never;
		});
	}

	/**
	 * Creates a map of every property using the specified decorator.
	 */
	export function getPropertyDecorators<T extends AnyDecorator>(
		obj: object,
		id?: string,
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
	 */
	export function getDecorator<T extends AnyDecorator>(
		object: object,
		property?: string,
		id?: string,
	): { arguments: DecoratorParameters<T> } | undefined {
		const decorator = Reflect.getMetadata<Flamework.Decorator>(object, `flamework:decorators.${id}`, property);
		if (!decorator) return;

		return decorator as never;
	}

	/**
	 * Retrieves a singleton or instantiates one if it does not exist.
	 */
	export function resolveSingleton<T extends object>(ctor: Constructor<T>) {
		const resolvedDependency = resolvedSingletons.get(ctor);
		if (resolvedDependency !== undefined) return resolvedDependency;

		// Flamework can resolve singletons at any arbitrary point,
		// so we should fetch custom dependency resolution (added via decorator) through the Reflect api.
		const opts = Reflect.getOwnMetadata<DependencyResolutionOptions>(ctor, "flamework:dependency_resolution");
		const dependency = createDependency(ctor, opts);
		resolvedSingletons.set(ctor, dependency);

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
	 */
	export function registerDependency<T>(dependency: DependencyRegistration, id?: string) {
		assert(id !== undefined);

		if (typeIs(dependency, "function")) {
			dependencyResolution.set(id, dependency);
		} else {
			dependencyResolution.set(id, () => dependency);
		}
	}

	/**
	 * Instantiates this class using dependency injection and registers it as a listener.
	 */
	export function createDependency<T extends object>(
		ctor: Constructor<T>,
		options: DependencyResolutionOptions = {},
	) {
		if (loadingList.includes(ctor)) throw `Circular dependency detected ${loadingList.join(" <=> ")} <=> ${ctor}`;
		loadingList.push(ctor);

		const dependencies = Reflect.getMetadata<string[]>(ctor, "flamework:parameters");
		const constructorDependencies: never[] = [];
		if (dependencies) {
			for (const [index, dependencyId] of pairs(dependencies)) {
				constructorDependencies[index - 1] = resolveDependency(ctor, dependencyId, index - 1, options) as never;
			}
		}

		const dependency = new ctor(...constructorDependencies);
		Modding.addListener(dependency);
		loadingList.pop();
		return dependency;
	}

	/**
	 * Dependency resolution logic.
	 */
	function resolveDependency(
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

		const dependencyCtor = Reflect.idToObj.get(dependencyId);
		if (!dependencyCtor || !isConstructor(dependencyCtor)) {
			throw `Could not find constructor for ${dependencyId} while constructing ${ctor}`;
		}

		return resolveSingleton(dependencyCtor);
	}

	/**
	 * @hidden
	 * @deprecated
	 */
	export function macro<T>(values: string | [string, unknown][], directValue?: unknown): T {
		if (typeIs(values, "string")) {
			return {
				[values]: directValue,
			} as never;
		}
		const result = {} as Record<string, unknown>;
		for (const [name, value] of values) {
			result[name] = value;
		}
		return result as T;
	}

	export type Generic<T, M extends keyof GenericMetadata<T>> = Pick<GenericMetadata<T>, M> & {
		/** @hidden */ _flamework_macro_generic: [T, { [k in M]: k }];
	};

	export type Caller<M extends keyof CallerMetadata> = Pick<CallerMetadata, M> & {
		/** @hidden */ _flamework_macro_caller: { [k in M]: k };
	};

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

function isConstructor(obj: object): obj is Constructor {
	return "new" in obj && "constructor" in obj;
}
