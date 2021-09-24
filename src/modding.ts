import { Reflect } from "./reflect";
import { Config, Constructor } from "./types";
import { isConstructor } from "./util/isConstructor";
import { isImplemented } from "./util/isImplemented";

/**
 *
 * - listener (an object that is listening for events, e.g an instance of a class)
 *
 * addListenerObject
 * removeListenerObject
 * getListenerAdded
 * getListenerRemoved
 *
 * - decorators
 *
 * addDecorator
 * getDecorator
 * getDecoratorConstructors
 * getDecoratorListenerAdded
 * getDecoratorListenerRemoved
 *
 * hasDecorator
 *
 * - lifecycle events
 *
 * addLifecycleEvent
 * getLifecycleListenerAdded
 * getLifecycleListenerRemoved
 */
export namespace Modding {
	const listenerObjects = new Set<object>();
	const listenerAddedEvent: BindableEvent<(obj: object) => void> = new Instance("BindableEvent");
	const listenerRemovedEvent: BindableEvent<(obj: object) => void> = new Instance("BindableEvent");

	const lifecycleListeners = new Map<string, Set<object>>();
	const lifecycleListenerAddedEvent: Map<string, BindableEvent> = new Map();
	const lifecycleListenerRemovedEvent: Map<string, BindableEvent> = new Map();

	const decoratorListeners = new Map<string, Set<object>>();
	const decoratorListenerAddedEvent: Map<string, BindableEvent> = new Map();
	const decoratorListenerRemovedEvent: Map<string, BindableEvent> = new Map();

	export function addListenerObject(obj: object) {
		if (!listenerObjects.has(obj)) {
			listenerObjects.add(obj);
			listenerAddedEvent.Fire(obj);
		}
	}

	export function removeListenerObject(obj: object) {
		if (listenerObjects.has(obj)) {
			listenerObjects.delete(obj);
			listenerRemovedEvent.Fire(obj);
		}
	}

	export function getListenerObjects(): ReadonlySet<object> {
		return listenerObjects;
	}

	export function getListenerAdded(callback: (obj: object) => void) {
		return listenerAddedEvent.Event.Connect(callback);
	}

	export function getListenerRemoved(callback: (obj: object) => void) {
		return listenerRemovedEvent.Event.Connect(callback);
	}

	export function addLifecycleEvent(id: string) {
		const set = new Set<object>();
		lifecycleListeners.set(id, set);

		for (const listener of listenerObjects) {
			if (isImplemented(listener, id)) {
				set.add(listener);
			}
		}

		let addedEvent = lifecycleListenerAddedEvent.get(id)!;
		if (!addedEvent) lifecycleListenerAddedEvent.set(id, (addedEvent = new Instance("BindableEvent")));

		let removedEvent = lifecycleListenerAddedEvent.get(id)!;
		if (!removedEvent) lifecycleListenerAddedEvent.set(id, (removedEvent = new Instance("BindableEvent")));

		getListenerAdded((obj) => {
			if (isImplemented(obj, id)) {
				set.add(obj);
				addedEvent.Fire(obj);
			}
		});

		getListenerRemoved((obj) => {
			if (isImplemented(obj, id)) {
				set.delete(obj);
				removedEvent.Fire(obj);
			}
		});
	}

	export function getLifecycleListeners(id: string): ReadonlySet<object> {
		return lifecycleListeners.get(id) || new Set();
	}

	export function getLifecycleListenerAdded(id: string, callback: (obj: object) => void) {
		let event = lifecycleListenerAddedEvent.get(id);
		if (!event) lifecycleListenerAddedEvent.set(id, (event = new Instance("BindableEvent")));

		return event.Event.Connect(callback);
	}

	export function getLifecycleListenerRemoved(id: string, callback: (obj: object) => void) {
		let event = lifecycleListenerRemovedEvent.get(id);
		if (!event) lifecycleListenerRemovedEvent.set(id, (event = new Instance("BindableEvent")));

		return event.Event.Connect(callback);
	}

	export function addDecorator(id: string) {
		const set = new Set<object>();
		decoratorListeners.set(id, set);

		for (const listener of listenerObjects) {
			if (Reflect.hasMetadata(listener, `flamework:decorators.${id}`)) {
				set.add(listener);
			}
		}

		let addedEvent = decoratorListenerAddedEvent.get(id)!;
		if (!addedEvent) decoratorListenerAddedEvent.set(id, (addedEvent = new Instance("BindableEvent")));

		let removedEvent = decoratorListenerRemovedEvent.get(id)!;
		if (!removedEvent) decoratorListenerRemovedEvent.set(id, (removedEvent = new Instance("BindableEvent")));

		getListenerAdded((obj) => {
			if (hasDecorator(obj, id)) {
				set.add(obj);
				addedEvent.Fire(obj);
			}
		});

		getListenerRemoved((obj) => {
			if (hasDecorator(obj, id)) {
				set.delete(obj);
				removedEvent.Fire(obj);
			}
		});
	}

	export function getDecorator<T extends unknown[] = unknown[]>(obj: object, id: string, property?: string) {
		const config = Reflect.getMetadata<Config>(obj, `flamework:decorators.${id}`, property);

		if (config?.type === "Arbitrary") {
			return config as typeof config & { arguments: T };
		}
	}

	export function hasDecorator(obj: object, id: string, property?: string) {
		return Reflect.hasMetadata(obj, `flamework:decorators.${id}`, property);
	}

	export function getDecoratorListeners(id: string): ReadonlySet<object> {
		return decoratorListeners.get(id) || new Set();
	}

	export function getDecoratorListenerAdded(id: string, callback: (obj: object) => void) {
		let event = decoratorListenerAddedEvent.get(id);
		if (!event) decoratorListenerAddedEvent.set(id, (event = new Instance("BindableEvent")));

		return event.Event.Connect(callback);
	}

	export function getDecoratorListenerRemoved(id: string, callback: (obj: object) => void) {
		let event = decoratorListenerRemovedEvent.get(id);
		if (!event) decoratorListenerRemovedEvent.set(id, (event = new Instance("BindableEvent")));

		return event.Event.Connect(callback);
	}

	export function getDecoratorConstructors(id: string) {
		const constructors = new Array<[string, Constructor<unknown>]>();
		for (const [id, obj] of Reflect.idToObj) {
			if (isConstructor(obj) && hasDecorator(obj, id)) {
				constructors.push([id, obj]);
			}
		}
		return constructors;
	}

	export type ClassDecorator = (ctor: unknown) => never;
	export type MethodDecorator = (value: unknown, property: unknown) => never;
}
