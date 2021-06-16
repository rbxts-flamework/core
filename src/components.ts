import Maid from "@rbxts/maid";
import { CollectionService } from "@rbxts/services";
import { t } from "@rbxts/t";
import { Service, Controller, OnInit, Flamework, OnStart, OnTick, OnPhysics, OnRender } from "./flamework";
import { Constructor } from "./types";

interface ComponentInfo {
	ctor: Constructor<BaseComponent>;
	config: Flamework.ConfigType<"Component">;
	metadata: Flamework.Metadata;
}

export class BaseComponent<A = {}> {
	/**
	 * A maid that will be destroyed when the component is.
	 */
	public maid = new Maid();

	/**
	 * Attributes attached to this instance.
	 */
	public attributes!: A;

	/**
	 * The instance this component is attached to.
	 * This should only be called in a component lifecycle event.
	 */
	public instance!: Instance;

	setInstance(instance: Instance) {
		this.instance = instance;
		this.attributes = instance.GetAttributes() as never;
	}

	/**
	 * Destroys this component instance.
	 */
	destroy() {
		this.maid.Destroy();
	}
}

/**
 * This class is responsible for loading and managing
 * all components in the game.
 */
@Service({
	loadOrder: 0,
})
@Controller({
	loadOrder: 0,
})
export class Components implements OnInit, OnStart, OnTick, OnPhysics, OnRender {
	private components = new Map<Constructor, ComponentInfo>();
	private activeComponents = new Map<Instance, Map<unknown, BaseComponent>>();

	private tick = new Set<BaseComponent & OnTick>();
	private physics = new Set<BaseComponent & OnPhysics>();
	private render = new Set<BaseComponent & OnRender>();

	onInit() {
		const components = new Map<Constructor, ComponentInfo>();
		for (const [ctor, metadata] of Flamework.metadata) {
			const component = metadata.decorators
				.map((x) => x.config)
				.find((x): x is Flamework.ConfigType<"Component"> => x.type === "Component");

			if (component) {
				components.set(ctor, {
					metadata,
					ctor: ctor as Constructor<BaseComponent>,
					config: component,
				});
			}
		}
		this.components = components;
	}

	onStart() {
		for (const [, { config, ctor, metadata }] of this.components) {
			if (config.tag !== undefined) {
				CollectionService.GetInstanceAddedSignal(config.tag).Connect((instance) => {
					this.addComponent(instance, ctor);
				});
				CollectionService.GetInstanceRemovedSignal(config.tag).Connect((instance) => {
					this.removeComponent(instance, ctor);
				});
				for (const instance of CollectionService.GetTagged(config.tag)) {
					this.safeCall(`Failed to instantiate ${instance}`, () => this.addComponent(instance, ctor));
				}
			}
		}
	}

	onTick(dt: number) {
		for (const component of this.tick) {
			const name = component.instance.GetFullName();
			this.safeCall(`Component failed to tick ${name}`, () => component.onTick(dt));
		}
	}

	onRender(dt: number) {
		for (const component of this.render) {
			const name = component.instance.GetFullName();
			this.safeCall(`Component failed to tick ${name}`, () => component.onRender(dt));
		}
	}

	onPhysics(dt: number, time: number) {
		for (const component of this.physics) {
			const name = component.instance.GetFullName();
			this.safeCall(`Component failed to tick ${name}`, () => component.onPhysics(dt, time));
		}
	}

	private getAttributes(ctor: Constructor) {
		const attributes = new Map<string, t.check<unknown>>();
		const metadata = this.components.get(ctor);
		if (metadata) {
			if (metadata.config.attributes !== undefined) {
				for (const [attribute, guard] of pairs(metadata.config.attributes)) {
					attributes.set(attribute as string, guard);
				}
			}
			const parentCtor = getmetatable(ctor) as { __index?: Constructor };
			if (parentCtor.__index !== undefined) {
				for (const [attribute, guard] of this.getAttributes(parentCtor.__index as Constructor)) {
					if (!attributes.has(attribute)) {
						attributes.set(attribute, guard);
					}
				}
			}
		}
		return attributes;
	}

	private validateAttributes(instance: Instance, guards: Map<string, t.check<unknown>>) {
		const attributes = instance.GetAttributes() as { [key: string]: unknown };

		for (const [key, guard] of pairs(guards)) {
			const attribute = attributes[key];
			if (!guard(attribute)) {
				return false;
			}
		}

		return true;
	}

	private safeCall(message: string, func: () => void) {
		coroutine.wrap(() => {
			const result = opcall(func);

			if (!result.success) {
				warn(message);
			}
		})();
	}

	private setupComponent(instance: Instance, component: BaseComponent, { config, ctor }: ComponentInfo) {
		component.setInstance(instance);

		if (Flamework.implements<OnStart>(component)) {
			const name = instance.GetFullName();
			this.safeCall(`Component failed to start ${name}`, () => component.onStart());
		}

		if (Flamework.implements<OnRender>(component)) {
			this.render.add(component);
			component.maid.GiveTask(() => this.render.delete(component));
		}

		if (Flamework.implements<OnPhysics>(component)) {
			this.physics.add(component);
			component.maid.GiveTask(() => this.physics.delete(component));
		}

		if (Flamework.implements<OnTick>(component)) {
			this.tick.add(component);
			component.maid.GiveTask(() => this.tick.delete(component));
		}

		if (config.refreshAttributes === undefined || config.refreshAttributes) {
			const attributes = this.getAttributes(ctor);
			for (const [attribute, guard] of pairs(attributes)) {
				if (typeIs(attribute, "string")) {
					component.maid.GiveTask(
						instance.GetAttributeChangedSignal(attribute).Connect(() => {
							const value = instance.GetAttribute(attribute);
							if (guard(value)) {
								(component.attributes as Map<string, unknown>).set(attribute, value);
							}
						}),
					);
				}
			}
		}
	}

	private getComponentFromSpecifier<T extends Constructor>(componentSpecifier?: T | string) {
		return typeIs(componentSpecifier, "string")
			? (Flamework.idToTarget.get(componentSpecifier) as T)
			: componentSpecifier;
	}

	getComponent<T>(instance: Instance): T;
	getComponent<T>(instance: Instance, componentSpecifier: Constructor<T>): T;
	getComponent<T>(instance: Instance, componentSpecifier?: Constructor<T> | string) {
		const component = this.getComponentFromSpecifier(componentSpecifier);
		assert(component, "Could not find component from specifier");

		const activeComponents = this.activeComponents.get(instance);
		if (!activeComponents) return;

		return activeComponents.get(component);
	}

	addComponent<T>(instance: Instance): T;
	addComponent<T>(instance: Instance, componentSpecifier: Constructor<T>): T;
	addComponent<T extends BaseComponent>(instance: Instance, componentSpecifier?: Constructor<T> | string) {
		const component = this.getComponentFromSpecifier(componentSpecifier);
		assert(component, "Could not find component from specifier");

		const componentInfo = this.components.get(component);
		assert(componentInfo, "Provided componentSpecifier does not exist");

		const attributeGuards = this.getAttributes(component);
		if (attributeGuards !== undefined)
			assert(
				this.validateAttributes(instance, attributeGuards),
				`${instance.GetFullName()} has invalid attributes for ${componentInfo.metadata.identifier}`,
			);

		let activeComponents = this.activeComponents.get(instance);
		if (!activeComponents) this.activeComponents.set(instance, (activeComponents = new Map()));

		const existingComponent = activeComponents.get(component);
		if (existingComponent !== undefined) return existingComponent;

		const componentInstance = Flamework.createDependency(component) as T;
		activeComponents.set(component, componentInstance);

		this.setupComponent(instance, componentInstance, componentInfo);
		return componentInstance;
	}

	removeComponent<T>(instance: Instance): void;
	removeComponent(instance: Instance, componentSpecifier: Constructor<BaseComponent>): void;
	removeComponent(instance: Instance, componentSpecifier?: Constructor<BaseComponent> | string) {
		const component = this.getComponentFromSpecifier(componentSpecifier);
		assert(component, "Could not find component from specifier");

		const activeComponents = this.activeComponents.get(instance);
		if (!activeComponents) return;

		const existingComponent = activeComponents.get(component);
		if (!existingComponent) return;

		existingComponent.destroy();
		activeComponents.delete(component);

		if (activeComponents.size() === 0) {
			this.activeComponents.delete(instance);
		}
	}
}
