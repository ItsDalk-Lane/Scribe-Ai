import { SecretComponent, setIcon, type App } from 'obsidian';
import { validateMcpDraft, type McpServerDraft, type McpTransport } from '../tools/external/mcpConfig';
import { mcpButton } from './mcpSettingsControls';
import { tr } from './skills/dialog';

function field(parent: HTMLElement, name: string, wide = false, hint?: string): HTMLLabelElement {
	const label = parent.createEl('label', { cls: `scribe-mcp-field${wide ? ' is-wide' : ''}` });
	label.createSpan({ text: name });
	if (hint) label.createEl('small', { text: hint });
	return label;
}

function input(parent: HTMLElement, name: string, value = '', options: { wide?: boolean; hint?: string; type?: string; placeholder?: string } = {}): HTMLInputElement {
	const control = field(parent, name, options.wide, options.hint).createEl('input', { attr: { type: options.type ?? 'text', autocomplete: 'off', spellcheck: 'false' } });
	control.value = value;
	if (options.placeholder) control.placeholder = options.placeholder;
	if (options.type === 'number') { control.min = '0'; control.step = 'any'; }
	return control;
}

function textarea(parent: HTMLElement, name: string, value: string, hint?: string): HTMLTextAreaElement {
	const control = field(parent, name, true, hint).createEl('textarea', { cls: 'scribe-mcp-code', attr: { rows: '2', spellcheck: 'false' } });
	control.value = value;
	return control;
}

function secretPicker(app: App, parent: HTMLElement, name: string, initialRef?: string, original?: string, removeEntry?: () => void) {
	const controls = parent.createDiv({ cls: 'scribe-secret-row scribe-mcp-secret-picker' });
	const host = controls.createDiv({ cls: 'scribe-secret-host' });
	const picker = new SecretComponent(app, host).setValue(initialRef ?? '');
	const link = controls.createEl('button', { cls: 'scribe-secret-button', attr: { type: 'button' } });
	const label = link.createSpan({ cls: 'scribe-mcp-secret-label' });
	const dot = link.createSpan({ cls: 'scribe-secret-dot', attr: { 'aria-hidden': 'true' } });
	const removeLabel = tr(`移除${name}关联`, `Remove ${name} link`);
	const remove = controls.createEl('button', { cls: 'scribe-secret-unlink', attr: { type: 'button', 'aria-label': removeLabel, title: removeLabel } });
	setIcon(remove, 'trash-2');
	let ref = initialRef;
	let literal = original;
	const paint = () => {
		const linked = Boolean(literal || (ref && app.secretStorage.getSecret(ref)));
		const text = linked ? tr('已连接', 'Connected') : tr(`连接${name}`, `Connect ${name}`);
		label.setText(text);
		link.title = linked ? `${name} · ${text}` : text;
		link.setAttribute('aria-label', link.title);
		link.toggleClass('is-linked', linked);
		dot.hidden = remove.hidden = !linked;
	};
	link.addEventListener('click', () => host.querySelector('button')?.click());
	picker.onChange((value) => { ref = value || undefined; literal = undefined; paint(); });
	remove.addEventListener('click', () => {
		if (removeEntry) { removeEntry(); return; }
		ref = literal = undefined;
		picker.setValue('');
		paint();
		link.focus();
	});
	paint();
	return () => ({ ref, literal });
}

function secretMap(app: App, parent: HTMLElement, name: string, original: Record<string, string> = {}, references: Record<string, string> = {}) {
	const group = parent.createEl('fieldset', { cls: 'scribe-mcp-secret-map is-wide' });
	group.createEl('legend', { text: name });
	const rows = group.createDiv({ cls: 'scribe-mcp-fields' });
	const fields = new Map<HTMLElement, { key: HTMLInputElement; readSecret: ReturnType<typeof secretPicker> }>();
	const append = (originalKey?: string) => {
		const row = rows.createDiv({ cls: 'scribe-mcp-secret-row is-wide' });
		const nameLabel = tr('名称', 'Name');
		const key = row.createEl('input', { cls: 'scribe-mcp-secret-name',
			attr: { type: 'text', placeholder: nameLabel, 'aria-label': nameLabel, autocomplete: 'off', spellcheck: 'false' } });
		key.value = originalKey ?? '';
		const readSecret = secretPicker(app, row, tr('钥匙串', 'secret storage'),
			originalKey === undefined ? undefined : references[originalKey],
			originalKey === undefined ? undefined : original[originalKey],
			() => { fields.delete(row); row.remove(); add.focus(); });
		fields.set(row, { key, readSecret });
		return key;
	};
	for (const name of new Set([...Object.keys(original), ...Object.keys(references)])) append(name);
	const add = mcpButton(group, tr('添加一项', 'Add entry'), 'scribe-icon-text-button', 'plus');
	add.addEventListener('click', () => append().focus());
	return () => {
		const literals = new Map<string, string>();
		const refs = new Map<string, string>();
		for (const { key, readSecret } of fields.values()) {
			const name = key.value.trim();
			const { literal, ref } = readSecret();
			if (!name && !literal && !ref) continue;
			if (!name || literals.has(name) || refs.has(name)) throw new Error(tr('请为每项填写不同的名称。', 'Enter a unique name for each entry.'));
			if (ref === undefined) literals.set(name, literal ?? '');
			else refs.set(name, ref);
		}
		return { literals: literals.size ? Object.fromEntries(literals) : undefined, refs: refs.size ? Object.fromEntries(refs) : undefined };
	};
}

const lines = (value: string) => value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
const optionalNumber = (value: string) => value === '' ? undefined : Number(value);

function headerReferences(value: string): Record<string, string> | undefined {
	const entries = new Map<string, string>();
	for (const line of lines(value)) {
		const separator = line.indexOf('=');
		const key = line.slice(0, separator).trim().toLowerCase();
		const name = line.slice(separator + 1).trim();
		if (separator < 1 || !key || !name || entries.has(key)) throw new Error(tr('请按「请求头=环境变量名」逐行填写，名称不要重复。', 'Enter one header=environment variable per line with unique header names.'));
		entries.set(key, name);
	}
	return entries.size ? Object.fromEntries(entries) : undefined;
}

function readArguments(value: string) {
	const refs: Record<string, string> = {};
	const args = value === '' ? [] : value.split('\n').map((arg, index) => {
		const match = /^(.*)\{\{secret:([a-z0-9][a-z0-9-]*)\}\}$/.exec(arg);
		if (!match?.[2]) return arg;
		refs[index] = match[2];
		return match[1] ?? '';
	});
	return { args, refs: Object.keys(refs).length ? refs : undefined };
}

export function renderMcpServerForm(app: App, parent: HTMLElement, original: McpServerDraft): {
	name: HTMLInputElement;
	type: HTMLSelectElement;
	read: (enabled: boolean, previous: McpServerDraft) => McpServerDraft;
} {
	const name = input(parent, tr('名称', 'Name'), original.name);
	name.required = true;
	const type = field(parent, tr('连接类型', 'Connection type')).createEl('select', { cls: 'dropdown' });
	for (const [value, label] of [
		['stdio', tr('本地命令（STDIO）', 'Local command (STDIO)')],
		['http', tr('流式 HTTP（远程连接推荐）', 'Streamable HTTP (recommended for remote servers)')],
		['sse', tr('服务器推送（旧版 SSE）', 'Server-sent events (legacy SSE)')],
	] as const) type.createEl('option', { text: label, attr: { value } });
	type.value = original.type;
	const description = input(parent, tr('说明', 'Description'), original.description, { wide: true });
	const local = parent.createDiv({ cls: 'scribe-mcp-fields is-wide' });
	local.createEl('p', { cls: 'scribe-mcp-description is-wide', text: tr('启用后，Obsidian 会在本机运行这里配置的命令。', 'When enabled, Obsidian runs this command on your computer.') });
	const command = input(local, tr('启动命令', 'Command'), original.command, { wide: true, placeholder: 'npx' });
	const argRefs = original.secretRefs?.args;
	const argsOriginal = original.args?.map((arg, index) => argRefs?.[index] ? `${arg}{{secret:${argRefs[index]}}}` : arg).join('\n') ?? '';
	const argsHint = argRefs ? tr('每行一个参数。密钥参数显示的是钥匙串名称。', 'One argument per line. Secret arguments show their storage names.')
		: tr('每行一个参数。', 'One argument per line.');
	const args = textarea(local, tr('参数', 'Arguments'), argsOriginal, argsHint);
	const cwd = input(local, tr('工作目录', 'Working directory'), original.cwd, { wide: true });
	const env = secretMap(app, local, tr('环境变量', 'Environment variables'), original.secrets?.env, original.secretRefs?.env);
	const envVars = textarea(local, tr('沿用本机环境变量', 'Use local environment variables'), original.envVars?.join('\n') ?? '', tr('每行填一个变量名。', 'One variable name per line.'));
	const remote = parent.createDiv({ cls: 'scribe-mcp-fields is-wide' });
	remote.createEl('p', { cls: 'scribe-mcp-description is-wide', text: tr('调用工具时，对应参数会发给这台服务器。', 'Tool arguments are sent to this server when a tool is called.') });
	const originalUrl = original.secrets?.url ? original.url?.split('?')[0] : original.url;
	const url = input(remote, tr('服务器地址', 'Server URL'), originalUrl, { wide: true, type: 'url', placeholder: 'https://example.com/mcp' });
	let keepUrlQuery = Boolean(original.secrets?.url || original.secretRefs?.url);
	if (keepUrlQuery) {
		const query = remote.createDiv({ cls: 'scribe-mcp-auth is-wide' });
		query.createEl('small', { cls: 'scribe-mcp-description', text: tr('已保存私密地址参数。修改地址将替换这些参数。', 'Private URL parameters are saved. Editing the URL replaces them.') });
		mcpButton(query, tr('移除地址参数', 'Remove URL parameters')).addEventListener('click', () => { keepUrlQuery = false; query.remove(); });
	}
	const headers = secretMap(app, remote, tr('请求头', 'Headers'), original.secrets?.headers, original.secretRefs?.headers);
	const envHeaders = textarea(remote, tr('引用本机环境变量的请求头', 'Headers from local environment variables'), Object.entries(original.envHeaders ?? {}).map(([key, value]) => `${key}=${value}`).join('\n'), tr('每行填写「请求头=环境变量名」。', 'One header=environment variable per line.'));
	const auth = remote.createEl('details', { cls: 'scribe-mcp-advanced is-wide' });
	auth.createEl('summary', { text: tr('身份验证', 'Authentication') });
	const authFields = auth.createDiv({ cls: 'scribe-mcp-fields' });
	const token = secretPicker(app, authFields.createDiv({ cls: 'is-wide' }), tr('访问令牌', 'Bearer token'),
		original.secretRefs?.bearerToken, original.secrets?.bearerToken);
	const tokenEnv = input(authFields, tr('访问令牌的环境变量名', 'Bearer token environment variable'), original.bearerTokenEnv, { wide: true });
	const client = input(authFields, tr('OAuth 客户端 ID', 'OAuth client ID'), original.oauthClientId, { wide: true });
	const clientSecret = secretPicker(app, authFields.createDiv({ cls: 'is-wide' }), tr('OAuth 客户端密钥', 'OAuth client secret'),
		original.secretRefs?.oauthClientSecret, original.secrets?.oauthClientSecret);
	const scopes = textarea(authFields, tr('OAuth 权限范围', 'OAuth scopes'), original.oauthScopes?.join('\n') ?? '', tr('每行一个权限范围。', 'One scope per line.'));
	const port = input(authFields, tr('OAuth 回调端口', 'OAuth callback port'), original.oauthCallbackPort?.toString(), { type: 'number' });
	port.step = '1';
	port.min = '1';
	port.max = '65535';
	const advanced = parent.createEl('details', { cls: 'scribe-mcp-advanced is-wide' });
	advanced.createEl('summary', { text: tr('高级设置', 'Advanced settings') });
	const advancedFields = advanced.createDiv({ cls: 'scribe-mcp-fields' });
	const startupTimeout = input(advancedFields, tr('连接等待时间（秒）', 'Connection timeout (seconds)'), original.startupTimeout?.toString(), { type: 'number', placeholder: '10' });
	const toolTimeout = input(advancedFields, tr('工具等待时间（秒）', 'Tool timeout (seconds)'), original.toolTimeout?.toString(), { type: 'number', placeholder: '60' });
	const tags = textarea(advancedFields, tr('标签', 'Tags'), original.tags?.join('\n') ?? '', tr('每行填写一个标签，可用于搜索。', 'One tag per line. Tags can be searched.'));
	const requiredLabel = advancedFields.createEl('label', { cls: 'scribe-mcp-required is-wide' });
	const required = requiredLabel.createEl('input', { attr: { type: 'checkbox' } });
	required.checked = original.required === true;
	requiredLabel.createSpan({ text: tr('启用后必须连接成功才能开始聊天', 'Require this server to connect before chat can start when enabled') });
	const showType = () => {
		local.hidden = type.value !== 'stdio';
		remote.hidden = !local.hidden;
	};
	type.addEventListener('change', showType);
	showType();
	return {
		name, type,
		read: (enabled, previous) => {
			const transport = type.value as McpTransport;
			const common = {
				...previous, name: name.value, type: transport, description: description.value, enabled, required: required.checked,
				tags: lines(tags.value), startupTimeout: optionalNumber(startupTimeout.value), toolTimeout: optionalNumber(toolTimeout.value),
			};
			if (transport === 'stdio') {
				const commandArgs = args.value === argsOriginal.replace(/\r\n?/g, '\n') ? { args: original.args, refs: argRefs } : readArguments(args.value);
				const values = env();
				return validateMcpDraft({
					...common, command: command.value, cwd: cwd.value, args: commandArgs.args, envVars: lines(envVars.value),
					secrets: { env: values.literals }, secretRefs: { env: values.refs, args: commandArgs.refs },
				});
			}
			const requestHeaders = headers();
			const bearer = token();
			const oauth = clientSecret();
			const keepPrivateUrl = keepUrlQuery && url.value.trim() === originalUrl;
			return validateMcpDraft({
				...common, url: url.value,
				envHeaders: headerReferences(envHeaders.value), bearerTokenEnv: tokenEnv.value, oauthClientId: client.value,
				oauthScopes: lines(scopes.value), oauthCallbackPort: optionalNumber(port.value),
				secrets: {
					headers: requestHeaders.literals, bearerToken: bearer.literal, oauthClientSecret: oauth.literal,
					url: keepPrivateUrl ? original.secrets?.url : undefined,
				},
				secretRefs: { headers: requestHeaders.refs, bearerToken: bearer.ref, oauthClientSecret: oauth.ref,
					url: keepPrivateUrl ? original.secretRefs?.url : undefined },
			});
		},
	};
}
