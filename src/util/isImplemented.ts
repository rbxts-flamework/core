import { Reflect } from "../reflect";

export function isImplemented<T>(object: unknown, id: string): object is T {
	return Reflect.getMetadatas<string[]>(object as object, "flamework:implements").some((impl) => impl.includes(id));
}
