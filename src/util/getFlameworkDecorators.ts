import { Reflect } from "../reflect";
import { Config, ConfigTypes } from "../types";

export function getFlameworkDecorator<T extends Exclude<keyof ConfigTypes, "Arbitrary">>(ctor: object, configType: T) {
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
