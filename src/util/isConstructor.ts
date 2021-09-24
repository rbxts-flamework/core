import { Constructor } from "../types";

export function isConstructor(obj: unknown): obj is Constructor<unknown> {
	if (!typeIs(obj, "table")) return false;

	return "new" in obj && "constructor" in obj && getmetatable(obj) === obj;
}
