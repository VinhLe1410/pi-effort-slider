export function isPrintableText(data: string): boolean {
	if (data.length === 0) return false;
	for (const ch of data) {
		const code = ch.codePointAt(0) ?? 0;
		// Ignore control characters and escape sequences. matchesKey handles functional keys first.
		if (code < 0x20 || code === 0x7f) return false;
	}
	return true;
}
