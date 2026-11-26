export function isLoopbackHost(hostname: string): boolean {
	const host = hostname.toLowerCase().replace(/\.$/u, '');
	return host === 'localhost' || host === '[::1]' || host === '::1' || /^127(?:\.\d{1,3}){3}$/u.test(host);
}

/** 远端服务必须通过 TLS；HTTP 仅用于本机模型和服务。 */
export function isSecureServiceUrl(url: URL): boolean {
	if (url.username || url.password) return false;
	if (url.protocol === 'https:') return true;
	return url.protocol === 'http:' && isLoopbackHost(url.hostname);
}
