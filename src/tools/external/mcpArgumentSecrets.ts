const secretOptions = new Set([
	'--access-key', '--access-token', '--api-key', '--api-token', '--apikey', '--auth-token', '--authorization',
	'--bearer-token', '--client-secret', '--cookie', '--key', '--passphrase', '--password', '--private-key',
	'--refresh-token', '--secret', '--session-token', '--token',
]);
const credentialHeader = /^(?:authorization|proxy-authorization|(?:x-)?api[-_]?key|(?:x-)?(?:auth|access)[-_]?token|cookie)\s*:\s*\S/i;

function isSecretOption(option?: string): boolean {
	return option !== undefined && secretOptions.has(option.toLowerCase().replaceAll('_', '-'));
}

function isHeaderOption(option?: string): boolean {
	return option === '--header' || option === '-H';
}

function hasSecretValue(option: string, value: string): boolean {
	return isSecretOption(option) || (isHeaderOption(option) && credentialHeader.test(value));
}

function urlArgument(arg: string) {
	const match = /^(?<prefix>--[\w-]+=)?(?<address>https?:\/\/.*)$/iu.exec(arg);
	const address = match?.groups?.address;
	if (!address) return;
	const url = URL.parse(address);
	if (!url) return;
	const privateUrl = Boolean(url.search || url.hash || url.username || url.password);
	const prefix = match?.groups?.prefix ?? '';
	return { placeholder: prefix + url.origin + url.pathname, privateUrl, address, prefix };
}

export function extractMcpArgumentSecrets(args?: string[]): { args?: string[]; secrets?: Record<string, string> } {
	if (!args) return {};
	const publicArgs = [...args];
	const secrets: Record<string, string> = {};
	let options = true;
	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (arg === '--') { options = false; continue; }
		if (!arg) continue;
		const url = urlArgument(arg);
		if (url?.privateUrl && (!options || !isSecretOption(url.prefix.slice(0, -1)))) {
			publicArgs[index] = url.placeholder;
			secrets[index] = arg;
			continue;
		}
		if (!options) continue;
		const equals = arg.indexOf('=');
		if (equals !== -1) {
			const flag = arg.slice(0, equals);
			const value = arg.slice(equals + 1);
			if (value && hasSecretValue(flag, value)) {
				publicArgs[index] = flag + '=';
				secrets[index] = value;
			}
		} else if (isSecretOption(arg) || isHeaderOption(arg)) {
			const value = args[index + 1];
			if (value && !value.startsWith('--') && hasSecretValue(arg, value)) {
				index++;
				publicArgs[index] = '';
				secrets[index] = value;
			}
		}
	}
	return Object.keys(secrets).length ? { args: publicArgs, secrets } : { args };
}

export function validateMcpArgumentRefs(args: string[] | undefined, refs: Record<string, string> | undefined): void {
	const entries = Object.keys(refs ?? {});
	if (!entries.length) return;
	if (!args) throw new Error('请检查 MCP 参数里的钥匙串引用。');
	const separator = args.indexOf('--');
	for (const key of entries) {
		const index = Number(key);
		const placeholder = args[index];
		const option = placeholder === '' ? args[index - 1] : placeholder?.endsWith('=') ? placeholder.slice(0, -1) : undefined;
		const url = placeholder && urlArgument(placeholder);
		const validOption = (separator < 0 || index < separator) && (isSecretOption(option) || isHeaderOption(option));
		if (!Number.isSafeInteger(index) || index < 0 || String(index) !== key || !(validOption || (url && !url.privateUrl))) {
			throw new Error('请检查 MCP 参数里的钥匙串引用。');
		}
	}
}

export function restoreMcpArgumentSecrets(args?: string[], secrets?: Record<string, string>): string[] | undefined {
	validateMcpArgumentRefs(args, secrets);
	if (!args || !secrets) return args;
	const restored = [...args];
	for (const [key, value] of Object.entries(secrets)) {
		const index = Number(key);
		const placeholder = args[index]!;
		if (typeof value !== 'string' || value.includes('\0')) throw new Error('请检查 MCP 参数里的钥匙串引用。');
		if (urlArgument(placeholder)) {
			if (urlArgument(value)?.placeholder !== placeholder) throw new Error('已保存的私密地址与命令参数不一致。');
			restored[index] = value;
		} else restored[index] = placeholder + value;
	}
	return restored;
}

export function mcpArgumentSecretValues(secrets?: Record<string, string>): string[] {
	return Object.values(secrets ?? {}).flatMap((value) => {
		const address = urlArgument(value)?.address;
		if (address) {
			const url = new URL(address);
			return [value, address, url.password, url.username, url.hash.slice(1), ...url.searchParams.values()].filter(Boolean);
		}
		if (!credentialHeader.test(value)) return [value];
		const headerValue = value.slice(value.indexOf(':') + 1).trim();
		return [value, headerValue, headerValue.replace(/^\w+\s+/, '')];
	});
}
