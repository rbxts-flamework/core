import Object from "@rbxts/object-utils";
import { Players, ReplicatedStorage, RunService, ServerScriptService } from "@rbxts/services";
import Signal from "@rbxts/signal";
import { t } from "@rbxts/t";

export namespace Networking {
	interface Sink {
		/** @hidden */
		readonly _nominal_Networking_Sink: unique symbol;
	}
	export const Sink = {} as Sink;

	export interface EventInfo {
		name: string;
	}

	export type Middleware<I extends ReadonlyArray<unknown> = unknown[], O = unknown> = (
		player?: Player,
		...args: I
	) => O;
	export type MiddlewareFactory<I extends ReadonlyArray<unknown> = unknown[], O = unknown> = (
		next: (player?: Player, ...args: I) => O,
		event: EventInfo,
	) => Middleware<I, O>;

	export type EventMiddleware<E> = {
		readonly [k in keyof E]?: E[k] extends (...args: infer I) => void ? [...MiddlewareFactory<I, void>[]] : never;
	};
	export type FunctionMiddleware<E> = {
		readonly [k in keyof E]?: E[k] extends (...args: infer I) => infer O
			? [...MiddlewareFactory<I, O | Sink>[]]
			: never;
	};

	export type ServerHandler<M, R> = {
		/**
		 * haha yo
		 */
		connect<T extends keyof R, K extends R[T] extends (...args: infer P) => void ? P : never>(
			event: T,
			cb: (player: Player, ...args: K) => void,
			additionalGuards?: { [k in keyof K]?: t.check<K[k]> },
		): RBXScriptConnection;
	} & M;

	export interface ServerMethod<T extends Array<unknown>> {
		(player: Player, ...args: T): void;
		fire(player: Player, ...args: T): void;
		/**
		 * Sends this request to all connected clients.
		 */
		broadcast(...args: T): void;
		/**
		 * Sends this request to all connected clients, excluding specified players.
		 * @param players The players to exclude
		 */
		except(players: Player | Player[], ...args: T): void;
	}

	export type ClientHandler<M, R> = {
		connect<T extends keyof R, K extends R[T] extends (...args: infer P) => void ? P : never>(
			event: T,
			cb: (...args: K) => void,
			additionalGuards?: { [k in keyof K]?: t.check<K[k]> },
		): RBXScriptConnection;
		predict<T extends keyof R>(
			event: T,
			...args: R[T] extends (...args: infer P) => void ? P : never
		): RBXScriptConnection;
	} & M;
	export type ClientMethod<T extends Array<unknown>> = (...args: T) => void;

	export type ServerEventType<S, C> = ServerHandler<
		{
			[k in keyof S]: S[k] extends (...params: infer P) => void ? ServerMethod<P> : never;
		},
		C
	>;
	export type ClientEventType<C, S> = ClientHandler<
		{
			[k in keyof C]: C[k] extends (...params: infer P) => void ? (...params: P) => void : never;
		},
		S
	>;

	export type EventType<S, C> = {
		client: ClientEventType<S, C>;
		server: ServerEventType<C, S>;
	};

	type EventList = { [key: string]: (...args: never[]) => unknown };
	type StaticGuards<T> = { [key in keyof T]: t.check<unknown>[] };

	declare const xx: StaticGuards<{ ay: (arg: string) => void }>;

	function populateEvents(names: string[], map: Map<string, RemoteEvent>) {
		for (const name of names) {
			if (RunService.IsClient()) {
				const instance = ReplicatedStorage.WaitForChild(name);
				if (instance.IsA("RemoteEvent")) {
					map.set(name, instance);
				}
			} else {
				const instance = ReplicatedStorage.FindFirstChild(name);

				if (instance) {
					if (!instance.IsA("RemoteEvent")) throw `Found ${name} but it is not a remote.`;
					map.set(name, instance);
				} else {
					const remote = new Instance("RemoteEvent");
					remote.Name = name;
					remote.Parent = ReplicatedStorage;
					map.set(name, remote);
				}
			}
		}
	}

	export function createEvent<S, C>(
		_serverGuards: StaticGuards<S>,
		_clientGuards: StaticGuards<C>,
		serverMiddleware?: EventMiddleware<S>,
		clientMiddleware?: EventMiddleware<C>,
	): EventType<S, C> {
		const serverGuards = _serverGuards as StaticGuards<EventList>;
		const clientGuards = _clientGuards as StaticGuards<EventList>;

		const globalEvents = {} as EventType<S, C>;
		const remotes = new Map<string, RemoteEvent>();

		populateEvents(Object.keys(serverGuards) as string[], remotes);
		populateEvents(Object.keys(clientGuards) as string[], remotes);

		const middleware = RunService.IsServer() ? serverMiddleware : clientMiddleware;
		const connections = new Map<string, BindableEvent>();
		const eventExecutors = new Map<string, (player?: Player, ...args: unknown[]) => unknown>();

		for (const [name] of remotes) {
			const executor = (player?: Player, ...args: unknown[]) => {
				const bindable = connections.get(name);
				if (!bindable) return warn("no bindable for", name);

				return bindable.Fire(player, ...args);
			};

			let startingExecutor = executor;
			const eventMiddleware = (middleware as { [key: string]: MiddlewareFactory<unknown[], unknown>[] })?.[name];
			if (eventMiddleware !== undefined) {
				for (let i = eventMiddleware.size() - 1; i >= 0; i--) {
					const middleware = eventMiddleware[i](startingExecutor, {
						name,
					});

					startingExecutor = middleware;
				}
			}

			eventExecutors.set(name, startingExecutor);
		}

		function fireConnections(event: string, player?: Player, ...args: unknown[]) {
			const executor = eventExecutors.get(event);
			if (executor !== undefined) {
				return executor(player, ...args);
			}
		}

		if (RunService.IsServer()) {
			globalEvents.server = {} as ServerEventType<C, S>;
			globalEvents.server.connect = function (this: unknown, event, cb, additionalGuards) {
				const remote = remotes.get(event as string);
				const guards = serverGuards[event as string];
				if (!remote) throw `Could not find remote ${event}`;
				if (!guards) throw `Could not find guards for ${event}`;

				let bindable = connections.get(event as string);
				if (!bindable) connections.set(event as string, (bindable = new Instance("BindableEvent")));

				return bindable.Event.Connect((player: Player, ...args: unknown[]) => {
					if (additionalGuards) {
						for (let i = 0; i < guards.size(); i++) {
							const guard = (additionalGuards as Array<t.check<unknown>>)[i];
							if (guard !== undefined && !guard(args[i])) {
								return;
							}
						}
					}
					return cb(player, ...(args as never));
				});
			};

			for (const [name] of pairs(clientGuards)) {
				const remote = remotes.get(name as string)!;
				const method = {
					fire(player: Player, ...args: unknown[]) {
						remote.FireClient(player, ...args);
					},
					broadcast(...args: unknown[]) {
						remote.FireAllClients(...args);
					},
					except(players: Player | Player[], ...args: unknown[]) {
						if (typeIs(players, "Instance")) players = [players];

						for (const player of Players.GetPlayers()) {
							if (!players.includes(player)) {
								this.fire(player, ...args);
							}
						}
					},
				};

				setmetatable(method, {
					__call: (method, player, ...args) => {
						if (typeIs(player, "Instance") && player.IsA("Player")) {
							method.fire(player, ...args);
						}
					},
				});

				globalEvents.server[name as keyof ServerEventType<C, S>] = method as never;
			}

			for (const [name, remote] of remotes) {
				remote.OnServerEvent.Connect((player, ...args) => {
					const guards = serverGuards[name];
					if (!guards) throw `Could not find guards for ${name}`;

					for (let i = 0; i < guards.size(); i++) {
						const guard = guards[i];
						if (!guard(args[i])) {
							return;
						}
					}

					fireConnections(name, player, ...args);
				});
			}
		} else {
			globalEvents.client = {} as ClientEventType<S, C>;
			globalEvents.client.connect = function (this: unknown, event, cb, additionalGuards) {
				const remote = remotes.get(event as string);
				const guards = clientGuards[event as string];
				if (!remote) throw `Could not find remote ${event}`;
				if (!guards) throw `Could not find guards for ${event}`;

				let bindable = connections.get(event as string);
				if (!bindable) connections.set(event as string, (bindable = new Instance("BindableEvent")));

				return bindable.Event.Connect((player: Player, ...args: unknown[]) => {
					if (additionalGuards) {
						for (let i = 0; i < guards.size(); i++) {
							const guard = (additionalGuards as Array<t.check<unknown>>)[i];
							if (guard !== undefined && !guard(args[i])) {
								return;
							}
						}
					}
					return cb(player, ...(args as never));
				});
			};

			for (const [name] of pairs(serverGuards)) {
				const remote = remotes.get(name as string)!;

				globalEvents.client[name as keyof ClientEventType<S, C>] = ((...args: unknown[]) => {
					remote.FireServer(...args);
				}) as never;
			}

			for (const [name, remote] of remotes) {
				remote.OnClientEvent.Connect((...args: unknown[]) => {
					const guards = clientGuards[name];
					if (!guards) throw `Could not find guards for ${name}`;

					for (let i = 0; i < guards.size(); i++) {
						const guard = guards[i];
						if (!guard(args[i])) {
							return;
						}
					}

					fireConnections(name, undefined, ...args);
				});
			}
		}

		return globalEvents;
	}
}
