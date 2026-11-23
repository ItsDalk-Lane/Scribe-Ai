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

export function extractMcpArgumentSecrets(args?: string[]): { args?: string[]; secrets?: Record<string, string> } {
	if (!args) return {};
	const publicArgs = [...args];
	const secrets: Record<string, string> = {};
	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (arg === '--') break;
		if (!arg) continue;
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

export function restoreMcpArgumentSecrets(args?: string[], secrets?: Record<string, string>): string[] | undefined {
	const entries = Object.entries(secrets ?? {});
	if (!entries.length) return args;
	if (!args) throw new Error('请检查 MCP 参数里的钥匙串引用。');
	const separator = args.indexOf('--');
	const restored = [...args];
	for (const [key, value] of entries) {
		const index = Number(key);
		const placeholder = args[index];
		const option = placeholder === '' ? args[index - 1] : placeholder?.endsWith('=') ? placeholder.slice(0, -1) : undefined;
		// 仅在原有的密钥选项位置还原，避免配置变动后把密钥传给别的参数。
		if (!Number.isSafeInteger(index) || index < 0 || String(index) !== key || (separator >= 0 && index >= separator)
			|| !(isSecretOption(option) || isHeaderOption(option)) || typeof value !== 'string' || value.includes('\0')) {
			throw new Error('请检查 MCP 参数里的钥匙串引用。');
		}
		restored[index] = (placeholder ?? '') + value;
	}
	return restored;
}

export function mcpArgumentSecretValues(secrets?: Record<string, string>): string[] {
	return Object.values(secrets ?? {}).flatMap((value) => {
		if (!credentialHeader.test(value)) return [value];
		const headerValue = value.slice(value.indexOf(':') + 1).trim();
		return [value, headerValue, headerValue.replace(/^\w+\s+/, '')];
	});
}
