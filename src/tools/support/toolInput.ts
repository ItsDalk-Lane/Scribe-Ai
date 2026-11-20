export function toolExecutionInput(input: unknown): unknown {
	if (!input || typeof input !== 'object' || Array.isArray(input) || !Object.prototype.hasOwnProperty.call(input, 'i')) return input;
	const args = { ...input } as Record<string, unknown>;
	delete args.i;
	return args;
}
