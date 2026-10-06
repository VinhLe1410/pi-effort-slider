export function isPrintableText(data: string): boolean {
	if (data.length === 0) return false;
	for (const ch of data) {
		const code = ch.codePointAt(0) ?? 0;
		// Ignore control characters and escape sequences. matchesKey handles functional keys first.
		if (code < 0x20 || code === 0x7f) return false;
	}
	return true;
}

// Ignore Kitty release events. They end in :3u. A release once reopened the slider after Enter. Releases also arrive after app switches.
export function isReleaseEvent(data: string): boolean {
	return /^\x1b\[.*:3u$/.test(data);
}
