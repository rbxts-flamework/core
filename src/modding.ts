import Signal from "@rbxts/signal";
import { Reflect } from "./reflect";
import { Constructor } from "./types";
import type { Flamework } from "./flamework";

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

type Decorator<T> = T & { /** @hidden */ _flamework_Decorator: never };
type ClassDecorator = (ctor: defined) => never;
type MethodDecorator = (target: defined, propertyKey: string, descriptor: defined) => never;
type PropertyDecorator = (target: defined, propertyKey: string) => never;

interface AttachedDecorator<T extends readonly unknown[]> {
	object: Constructor;
	arguments: T;
}

type DecoratorCall<T extends readonly unknown[], D> = T extends { length: 0 }
	? ((...args: T) => D) & D
	: (...args: T) => D;

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
	 * Fires for all existing listeners.
	 */
	export function onListenerAdded(func: ListenerAddedEvent): RBXScriptConnection;

	/**
	 * Registers a listener added event.
	 * Fires whenever a listener has a decorator or lifecycle event with the specified ID.
	 * Fires for all existing listeners.
	 *
	 * @param id The ID of a lifecycle event or decorator.
	 */
	export function onListenerAdded(id: string, func: ListenerAddedEvent): RBXScriptConnection;

	/**
	 * Registers a listener added event.
	 */
	export function onListenerAdded(_id: string | ListenerAddedEvent, _func?: ListenerAddedEvent) {
		const id = typeIs(_id, "string") ? _id : undefined;
		const func = typeIs(_id, "string") ? _func! : _id;

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
	 * Fires whenever any listener is removed.
	 */
	export function onListenerRemoved(func: ListenerRemovedEvent): RBXScriptConnection;

	/**
	 * Registers a listener removed event.
	 * Fires whenever a listener has a decorator or lifecycle event with the specified ID.
	 *
	 * @param id The ID of a lifecycle event or decorator.
	 */
	export function onListenerRemoved(id: string, func: ListenerRemovedEvent): RBXScriptConnection;

	/**
	 * Registers a listener removed event.
	 */
	export function onListenerRemoved(_id: string | ListenerRemovedEvent, _func?: ListenerRemovedEvent) {
		const id = typeIs(_id, "string") ? _id : undefined;
		const func = typeIs(_id, "string") ? _func! : _id;

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
	): DecoratorCall<T, Decorator<ClassDecorator>>;

	/**
	 * Registers a method decorator.
	 */
	export function createDecorator<T extends readonly unknown[] = void[]>(
		kind: "Method",
		func: (descriptor: MethodDescriptor, config: T) => void,
	): DecoratorCall<T, Decorator<MethodDecorator>>;

	/**
	 * Registers a property decorator.
	 */
	export function createDecorator<T extends readonly unknown[] = void[]>(
		kind: "Property",
		func: (descriptor: PropertyDescriptor, config: T) => void,
	): DecoratorCall<T, Decorator<PropertyDecorator>>;

	/**
	 * Registers a decorator.
	 */
	export function createDecorator(
		_kind: "Method" | "Property" | "Class",
		func: (...args: never[]) => void,
	): ClassDecorator | MethodDecorator | PropertyDecorator {
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
	): DecoratorCall<T, Decorator<ClassDecorator>>;

	/**
	 * Registers a metadata method decorator.
	 */
	export function createMetaDecorator<T extends readonly unknown[] = void[]>(
		kind: "Method",
	): DecoratorCall<T, Decorator<MethodDecorator>>;

	/**
	 * Registers a metadata property decorator.
	 */
	export function createMetaDecorator<T extends readonly unknown[] = void[]>(
		kind: "Property",
	): DecoratorCall<T, Decorator<PropertyDecorator>>;

	/**
	 * Registers a metadata decorator.
	 */
	export function createMetaDecorator(
		_kind: "Method" | "Property" | "Class",
	): ClassDecorator | MethodDecorator | PropertyDecorator {
		return {
			func: (descriptor: PropertyDescriptor, config: unknown[]) => {
				defineDecoratorMetadata(descriptor, config);
			},
		} as never;
	}

	/**
	 * Retrieves registered decorators.
	 */
	export function getDecorators<T extends readonly unknown[]>(id: string): AttachedDecorator<T>[] {
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

	export function getPropertyDecorators<T extends readonly unknown[]>(
		obj: object,
		id: string,
	): Map<string, { arguments: T }> {
		const decorators = new Map<string, { arguments: T }>();

		for (const prop of Reflect.getProperties(obj)) {
			const decorator = getDecorator(id, obj, prop);
			if (decorator) {
				decorators.set(prop, decorator as never);
			}
		}

		return decorators;
	}

	/**
	 * Retrieves a decorator from an object or its properties.
	 */
	export function getDecorator<T extends readonly unknown[]>(
		id: string,
		object: object,
		property?: string,
	): { arguments: T } | undefined {
		const decorator = Reflect.getOwnMetadata<Flamework.Decorator>(object, `flamework:decorators.${id}`, property);
		if (!decorator) return;

		return decorator as never;
	}

	/**
	 * Retrieves a singleton or instantiates one if it does not exist.
	 */
	export function resolveSingleton<T extends object>(ctor: Constructor<T>, opts?: DependencyResolutionOptions) {
		const resolvedDependency = resolvedSingletons.get(ctor);
		if (resolvedDependency !== undefined) return resolvedDependency;

		// Flamework can resolve singletons at any arbitrary point,
		// so we should fetch custom dependency resolution (added via decorator) through the Reflect api.
		if (opts === undefined) {
			opts = Reflect.getOwnMetadata<DependencyResolutionOptions>(ctor, "flamework:dependency_resolution");
		}

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
	export function registerDependency(id: string, dependency: DependencyRegistration) {
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

	function defineDecoratorMetadata(descriptor: PropertyDescriptor, config: unknown[]) {
		Reflect.defineMetadata(
			descriptor.object,
			`flamework:decorators.${descriptor.id}`,
			{
				arguments: config,
			},
			descriptor.isStatic ? `static:${descriptor.property}` : descriptor.property,
		);
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
