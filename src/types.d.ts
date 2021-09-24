import { t } from "@rbxts/t";

export type Constructor<T = unknown> = new (...args: never[]) => T;
export type Config =
	| (ComponentConfig & { type: "Component" })
	| (ServiceConfig & { type: "Service" })
	| (ControllerConfig & { type: "Controller" })
	| (ArbitraryConfig & { type: "Arbitrary" });

export type LoadableConfigs = Extract<Config, { type: "Service" | "Controller" }>;
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
	defaults?: { [key: string]: unknown };
	instanceGuard?: t.check<unknown>;
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

export interface FlameworkIgnitionHooks {
	/**
	 * A hook fired prior to Flamework's ignition.
	 */
	pre?: () => void;

	/**
	 * A hook fired after Flamework's ignition.
	 */
	post?: () => void;
}
