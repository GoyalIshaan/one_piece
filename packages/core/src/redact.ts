// Secret scrubbing applied to everything before it reaches a model, the store or the dashboard.

const PATTERNS: RegExp[] = [
	/\bsk-[A-Za-z0-9_-]{12,}/g,
	/\bsk-or-v1-[A-Za-z0-9]{12,}/g,
	/\bgh[pousr]_[A-Za-z0-9]{12,}/g,
	/\bgithub_pat_[A-Za-z0-9_]{12,}/g,
	/\bxai-[A-Za-z0-9]{12,}/g,
	/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/g,
	/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
	/\b(api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret)\b(["'\s]*[:=]\s*["']?)[^\s"',}]{6,}/gi,
];

const REDACTED = "[redacted]";

export class Redactor {
	private readonly literals = new Set<string>();

	/** Register a secret value so it is replaced wherever it appears. */
	addSecret(value: string): void {
		if (value && value.length >= 6) this.literals.add(value);
	}

	redactText(text: string): string {
		let out = text;
		for (const literal of this.literals) out = out.split(literal).join(REDACTED);
		for (const pattern of PATTERNS) {
			out = out.replace(pattern, (match, ...groups) => {
				// Keep the key name for the key=value pattern so logs stay readable.
				if (typeof groups[0] === "string" && typeof groups[1] === "string" && /[:=]/.test(groups[1])) {
					return `${groups[0]}${groups[1]}${REDACTED}`;
				}
				return match.startsWith("Bearer") ? `Bearer ${REDACTED}` : REDACTED;
			});
		}
		return out;
	}

	redact<T>(value: T): T {
		if (typeof value === "string") return this.redactText(value) as T;
		if (Array.isArray(value)) return value.map((v) => this.redact(v)) as T;
		if (value && typeof value === "object") {
			const out: Record<string, unknown> = {};
			for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
				out[key] = /^(authorization|api[_-]?key|password|secret|token|cookie)$/i.test(key) ? REDACTED : this.redact(v);
			}
			return out as T;
		}
		return value;
	}
}
