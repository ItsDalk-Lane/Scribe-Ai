import { RE2JS } from 're2js';

export function compilePathGlob(pattern: string): (path: string) => boolean {
	const expression: string[] = [];
	let groups = 0;
	for (let index = 0; index < pattern.length; index++) {
		const token = pattern.charAt(index);
		const following = pattern[index + 2];
		if (token === '*' && pattern[index + 1] === '*' && (index === 0 || pattern[index - 1] === '/')
			&& (following === '/' || following === undefined)) {
			expression.push(following === '/' ? '(?:[^/]+/)*' : '.*');
			index += following === '/' ? 2 : 1;
		} else if (token === '*') {
			expression.push('[^/]*');
			while (pattern[index + 1] === '*') index++;
		} else if (token === '?') {
			expression.push('[^/]');
		} else if (token === '{') {
			expression.push('(?:');
			groups++;
		} else if (token === '}' && groups > 0) {
			expression.push(')');
			groups--;
		} else if (token === ',' && groups > 0) {
			expression.push('|');
		} else {
			expression.push(token.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&'));
		}
	}
	if (groups !== 0) throw new Error('文件名模式中的花括号未闭合。');
	const regex = RE2JS.compile(expression.join(''), RE2JS.DOTALL);
	return (path) => regex.testExact(path);
}
