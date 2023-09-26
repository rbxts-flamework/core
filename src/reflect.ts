import type { ClassDescriptor, MethodDescriptor, PropertyDescriptor } from "./modding";
import { AbstractConstructor, isConstructor } from "./utility";

/**
 * Reflection/metadata API
 */
export namespace Reflect {
	/** object -> property -> key -> value */
	const metadata = new WeakMap<object, Map<string | typeof NO_PROP_MARKER, Map<string, unknown>>>();
	const objToId = new Map<object, string>();

	/** @internal */
	export const decorators = new Map<string, Array<AbstractConstructor>>();
	export const idToObj = new Map<string, object>();

	const NO_PROP_MARKER = {} as { _nominal_Marker: never };

	function getObjMetadata(obj: object, prop: string | undefined, create: true): Map<string, unknown>;
	function getObjMetadata(obj: object, prop?: string): Map<string, unknown> | undefined;
	function getObjMetadata(obj: object, prop?: string, create?: boolean) {
		const realProp = prop ?? NO_PROP_MARKER;
		if (create) {
			let objMetadata = metadata.get(obj);
			if (!objMetadata) metadata.set(obj, (objMetadata = new Map()));

			let propMetadata = objMetadata.get(realProp);
			if (!propMetadata) objMetadata.set(realProp, (propMetadata = new Map()));

			return propMetadata;
		} else {
			return metadata.get(obj)?.get(realProp);
		}
	}

	function getParentConstructor(obj: object) {
		const metatable = getmetatable(obj) as { __index?: object };
		if (metatable && typeIs(metatable, "table")) {
			return rawget(metatable, "__index") as object;
		}
	}

	/**
	 * Apply metadata onto this object.
	 */
	export function defineMetadata(obj: object, key: string, value: unknown, property?: string) {
		// 'identifier' is a special, unique ID across all metadata classes.
		if (key === "identifier") {
			assert(typeIs(value, "string"), "identifier must be a string.");
			assert(!objToId.has(obj), "obj is already registered.");
			assert(!idToObj.has(value as never), "id is already registered.");

			objToId.set(obj, value);
			idToObj.set(value, obj);
		}

		const metadata = getObjMetadata(obj, property, true);
		metadata.set(key, value);
	}

	/**
	 * Apply metadata in batch onto this object.
	 */
	export function defineMetadataBatch(obj: object, list: { [key: string]: unknown }, property?: string) {
		const metadata = getObjMetadata(obj, property, true);

		for (const [key, value] of pairs(list)) {
			metadata.set(key as string, value);
		}
	}

	/**
	 * Delete metadata from this object.
	 */
	export function deleteMetadata(obj: object, key: string, property?: string) {
		const metadata = getObjMetadata(obj, property);
		metadata?.delete(key);
	}

	/**
	 * Get metadata from this object.
	 * Type parameter is an assertion.
	 */
	export function getOwnMetadata<T>(obj: object, key: string, property?: string): T | undefined {
		const metadata = getObjMetadata(obj, property);
		return metadata?.get(key) as T;
	}

	/**
	 * Check if this object has the specified metadata key.
	 */
	export function hasOwnMetadata(obj: object, key: string, property?: string) {
		const metadata = getObjMetadata(obj, property);
		return metadata?.has(key) ?? false;
	}

	/**
	 * Retrieve all metadata keys for this object.
	 */
	export function getOwnMetadataKeys(obj: object, property?: string) {
		const metadata = getObjMetadata(obj, property);
		const keys = new Array<string>();

		metadata?.forEach((_, key) => keys.push(key));
		return keys;
	}

	/**
	 * Retrieves all properties (that contain metadata) on this object.
	 */
	export function getOwnProperties(obj: object) {
		const properties = metadata.get(obj);
		if (!properties) return [];

		const keys = new Array<string>();
		for (const [key] of properties) {
			if (key !== NO_PROP_MARKER) {
				keys.push(key as string);
			}
		}
		return keys;
	}

	/**
	 * Retrieve all values for the specified key from the object and its parents.
	 * Type parameter is an assertion.
	 */
	export function getMetadatas<T extends defined>(obj: object, key: string, property?: string): T[] {
		const values = new Array<T>();

		const value = getOwnMetadata(obj, key, property);
		if (value !== undefined) {
			values.push(value as T);
		}

		const parent = getParentConstructor(obj);
		if (parent) {
			getMetadatas<T>(parent, key, property).forEach((value) => values.push(value));
		}

		return values;
	}

	/**
	 * Get metadata from this object or its parents.
	 * Type parameter is an assertion.
	 */
	export function getMetadata<T>(obj: object, key: string, property?: string): T | undefined {
		const value = getOwnMetadata(obj, key, property);
		if (value !== undefined) {
			return value as T;
		}

		const parent = getParentConstructor(obj);
		if (parent) {
			return getMetadata(parent, key, property);
		}
	}

	/**
	 * Check if this object or any of its parents has the specified metadata key.
	 */
	export function hasMetadata(obj: object, key: string, property?: string): boolean {
		const value = hasOwnMetadata(obj, key, property);
		if (value) {
			return value;
		}

		const parent = getParentConstructor(obj);
		if (parent) {
			return hasMetadata(parent, key, property);
		}

		return false;
	}

	/**
	 * Retrieve all metadata keys for this object and its parents.
	 */
	export function getMetadataKeys(obj: object, property?: string): string[] {
		const keys = new Set<string>(getOwnMetadataKeys(obj, property));

		const parent = getParentConstructor(obj);
		if (parent) {
			getMetadataKeys(parent, property).forEach((key) => keys.add(key));
		}

		return [...keys];
	}

	/**
	 * Retrieves all properties (that contain metadata) on this object and its parents.
	 */
	export function getProperties(obj: object) {
		const keys = new Set<string>(getOwnProperties(obj));

		const parent = getParentConstructor(obj);
		if (parent) {
			getProperties(parent).forEach((key) => keys.add(key));
		}

		return [...keys];
	}

	/** @hidden */
	export function decorate<A extends readonly unknown[]>(
		object: AbstractConstructor,
		id: string,
		rawDecoration: { _flamework_Parameters: [...A] },
		args: [...A],
		property?: string,
		isStatic = false,
	) {
		const decoration = rawDecoration as unknown as {
			func: (descriptor: ClassDescriptor | MethodDescriptor | PropertyDescriptor, config: [...A]) => void;
		};

		const descriptor = {
			id,
			isStatic,
			object,
			contructor: isConstructor(object) ? object : undefined,
			property,
		};

		if (property === undefined) {
			let decoratedObjects = decorators.get(id);
			if (!decoratedObjects) decorators.set(id, (decoratedObjects = []));

			decoratedObjects.push(object);
		}

		decoration.func(descriptor, args);
	}
}
