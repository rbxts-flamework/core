import { CollectionService } from "@rbxts/services";
import { Service, Controller, OnInit, Flamework, OnStart, OnTick, OnPhysics, OnRender } from "./flamework";
import { Constructor } from "./types";

interface ComponentInfo {
	ctor: Constructor<BaseComponent>;
	config: Flamework.ConfigType<"Component">;
	metadata: Flamework.Metadata;
}

export class BaseComponent {
	/**
	 * The instance this component is attached to.
	 * This should only be called in a component lifecycle event.
	 */
	public instance!: Instance;

	/**
	 * Destroys this component instance.
	 */
	destroy() {}
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
	private components = new Array<ComponentInfo>();
	private activeComponents = new Map<Instance, Map<unknown, BaseComponent>>();

	private tick = new Array<BaseComponent & OnTick>();
	private physics = new Array<BaseComponent & OnPhysics>();
	private render = new Array<BaseComponent & OnRender>();

	onInit() {
		const components = new Array<ComponentInfo>();
		for (const [ctor, metadata] of Flamework.metadata) {
			const component = metadata.decorators
				.map((x) => x.config)
				.find((x): x is Flamework.ConfigType<"Component"> => x.type === "Component");

			if (component) {
				components.push({
					metadata,
					ctor: ctor as Constructor<BaseComponent>,
					config: component,
				});
			}
		}
		this.components = components;

		print("onInit", this.components.size());
	}

	onStart() {
		for (const { config, ctor, metadata } of this.components) {
			if (config.tag !== undefined) {
				CollectionService.GetInstanceAddedSignal(config.tag).Connect((instance) => {
					this.addComponent(instance, ctor);
				});
				CollectionService.GetInstanceRemovedSignal(config.tag).Connect((instance) => {
					this.removeComponent(instance, ctor);
				});
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

	private safeCall(message: string, func: () => void) {
		coroutine.wrap(() => {
			const result = opcall(func);

			if (!result.success) {
				warn(message);
			}
		})();
	}

	private setupComponent(instance: Instance, component: BaseComponent) {
		component.instance = instance;

		if (Flamework.implements<OnStart>(component)) {
			const name = instance.GetFullName();
			this.safeCall(`Component failed to start ${name}`, () => component.onStart());
		}

		if (Flamework.implements<OnRender>(component)) {
			this.render.push(component);
		}

		if (Flamework.implements<OnPhysics>(component)) {
			this.physics.push(component);
		}

		if (Flamework.implements<OnTick>(component)) {
			this.tick.push(component);
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

		let activeComponents = this.activeComponents.get(instance);
		if (!activeComponents) this.activeComponents.set(instance, (activeComponents = new Map()));

		const existingComponent = activeComponents.get(component);
		if (existingComponent !== undefined) return existingComponent;

		const componentInstance = Flamework.createDependency(component) as T;
		activeComponents.set(component, componentInstance);

		this.setupComponent(instance, componentInstance);
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
