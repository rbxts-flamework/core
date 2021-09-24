export function safeCall(func: () => void, message: string) {
	xpcall(func, (err) => {
		if (typeIs(err, "string")) {
			const stack = debug.traceback(err, 2);
			warn(message);
			warn(stack);
		} else {
			warn(message);
			warn(err);
			warn(debug.traceback(undefined, 2));
		}
	});
}
