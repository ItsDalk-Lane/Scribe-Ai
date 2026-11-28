export function testSecretStorage() {
	const secrets = new Map<string, string>();
	return {
		getSecret: (key: string) => secrets.get(key) ?? null,
		setSecret: (key: string, value: string) => { secrets.set(key, value); },
	};
}
