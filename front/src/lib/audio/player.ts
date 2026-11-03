/**
 * Toca uma sequência de trechos de áudio como se fosse um arquivo só.
 *
 * `<audio>` trocando de `src` deixa um buraco audível entre arquivos, então cada trecho é baixado,
 * decodificado em AudioBuffer e agendado no relógio do AudioContext exatamente no fim do anterior.
 * A posição é sempre em horário real (ms epoch): trechos contíguos são emendados descartando a
 * sobreposição da virada do gravador; um buraco grande (app fechado) é pulado direto para o próximo.
 */

export type PlayerSegment = { id: string; start: number; end: number };

type Scheduled = {
	index: number;
	source: AudioBufferSourceNode;
	ctxStart: number;
	ctxEnd: number;
	/** Horário real tocado em `ctxStart`. */
	wallStart: number;
};

/** Até esse buraco entre trechos, a emenda mantém o silêncio real; acima disso, pula. */
const GAP_TOLERANCE_MS = 1_500;
const LOOKAHEAD_SECONDS = 20;
const CACHE_SIZE = 6;
const TICK_MS = 200;

export class SegmentPlayer {
	segments: PlayerSegment[] = [];
	playing = false;
	loading = false;
	error = '';

	private ctx: AudioContext | null = null;
	private gain: GainNode | null = null;
	private scheduled: Scheduled[] = [];
	private pausedAt = 0;
	private cache = new Map<string, Promise<AudioBuffer>>();
	private ticker: ReturnType<typeof setInterval> | null = null;
	private extending = false;
	private run = 0;
	private volume = 1;

	constructor(
		private readonly fetchSegment: (id: string) => Promise<ArrayBuffer>,
		private readonly onChange: () => void
	) {}

	setSegments(segments: PlayerSegment[]) {
		this.stopSources();
		this.playing = false;
		this.segments = [...segments].sort((a, b) => a.start - b.start);
		this.cache.clear();
		this.onChange();
	}

	position() {
		if (!this.playing || !this.ctx || !this.scheduled.length) return this.pausedAt;
		const now = this.ctx.currentTime;
		const active = [...this.scheduled].reverse().find((entry) => entry.ctxStart <= now);
		if (!active) return this.scheduled[0]!.wallStart;
		return active.wallStart + (Math.min(now, active.ctxEnd) - active.ctxStart) * 1_000;
	}

	setVolume(volume: number) {
		this.volume = volume;
		if (this.gain) this.gain.gain.value = volume;
	}

	async play(from = this.pausedAt) {
		const run = ++this.run;
		this.stopSources();
		this.error = '';
		const ctx = this.ensureContext();
		await ctx.resume();

		let index = this.segments.findIndex((segment) => segment.end > from);
		if (index === -1) {
			this.pausedAt = from;
			this.playing = false;
			this.onChange();
			return;
		}

		this.playing = true;
		this.loading = true;
		this.onChange();

		while (index < this.segments.length) {
			const segment = this.segments[index]!;
			const at = Math.max(from, segment.start);
			const buffer = await this.load(index).catch(() => null);
			if (run !== this.run) return;
			if (!buffer) {
				index += 1;
				continue;
			}
			const offset = (at - segment.start) / 1_000;
			if (offset >= buffer.duration) {
				index += 1;
				continue;
			}
			this.schedule(index, buffer, ctx.currentTime + 0.05, offset);
			break;
		}

		this.loading = false;
		if (!this.scheduled.length) {
			this.playing = false;
			this.error = 'Não foi possível carregar o áudio deste horário.';
		} else {
			this.startTicker();
		}
		this.onChange();
	}

	pause() {
		this.pausedAt = this.position();
		this.run += 1;
		this.stopSources();
		this.playing = false;
		this.loading = false;
		this.onChange();
	}

	seek(to: number) {
		if (this.playing) {
			void this.play(to);
		} else {
			this.pausedAt = to;
			this.onChange();
		}
	}

	destroy() {
		this.run += 1;
		this.stopSources();
		void this.ctx?.close();
		this.ctx = null;
	}

	private ensureContext() {
		if (!this.ctx) {
			this.ctx = new AudioContext();
			this.gain = this.ctx.createGain();
			this.gain.gain.value = this.volume;
			this.gain.connect(this.ctx.destination);
		}
		return this.ctx;
	}

	private schedule(index: number, buffer: AudioBuffer, ctxStart: number, offset: number) {
		const ctx = this.ctx!;
		const source = ctx.createBufferSource();
		source.buffer = buffer;
		source.connect(this.gain!);
		source.start(ctxStart, offset);
		this.scheduled.push({
			index,
			source,
			ctxStart,
			ctxEnd: ctxStart + (buffer.duration - offset),
			wallStart: this.segments[index]!.start + offset * 1_000
		});
		// Pre-fetch the next ones while this one plays.
		for (let ahead = index + 1; ahead <= index + 2 && ahead < this.segments.length; ahead++) {
			void this.load(ahead).catch(() => null);
		}
	}

	private startTicker() {
		if (this.ticker) return;
		this.ticker = setInterval(() => this.tick(), TICK_MS);
	}

	private tick() {
		if (!this.playing || !this.ctx) return;
		const now = this.ctx.currentTime;
		// Keep only what is still playing or queued.
		this.scheduled = this.scheduled.filter((entry) => entry.ctxEnd > now - 1);
		const last = this.scheduled.at(-1);
		if (!last) {
			this.finish();
			return;
		}
		if (last.ctxEnd - now < LOOKAHEAD_SECONDS) void this.extend(last);
		if (now >= last.ctxEnd && last.index >= this.segments.length - 1) this.finish();
		this.onChange();
	}

	/** Agenda o trecho seguinte colado no fim do último agendado. */
	private async extend(last: Scheduled) {
		if (this.extending) return;
		this.extending = true;
		const run = this.run;
		try {
			const lastEndWall = last.wallStart + (last.ctxEnd - last.ctxStart) * 1_000;
			for (let index = last.index + 1; index < this.segments.length; index++) {
				const buffer = await this.load(index).catch(() => null);
				if (run !== this.run) return;
				if (!buffer) continue;
				const segment = this.segments[index]!;
				const gap = segment.start - lastEndWall;
				let ctxStart = last.ctxEnd;
				let offset = 0;
				if (gap <= GAP_TOLERANCE_MS) {
					if (gap < 0) offset = -gap / 1_000;
					else ctxStart += gap / 1_000;
				}
				if (offset >= buffer.duration) continue;
				// Se o download atrasou além do fim do anterior, toca a partir de agora.
				const now = this.ctx!.currentTime;
				if (ctxStart < now + 0.02) {
					offset += now + 0.02 - ctxStart;
					ctxStart = now + 0.02;
					if (offset >= buffer.duration) continue;
				}
				this.schedule(index, buffer, ctxStart, offset);
				return;
			}
		} finally {
			this.extending = false;
		}
	}

	private finish() {
		const last = this.scheduled.at(-1);
		this.pausedAt = last ? last.wallStart + (last.ctxEnd - last.ctxStart) * 1_000 : this.position();
		this.stopSources();
		this.playing = false;
		this.onChange();
	}

	private load(index: number) {
		const segment = this.segments[index]!;
		let pending = this.cache.get(segment.id);
		if (!pending) {
			pending = this.fetchSegment(segment.id).then((bytes) =>
				this.ensureContext().decodeAudioData(bytes)
			);
			pending.catch(() => this.cache.delete(segment.id));
			this.cache.set(segment.id, pending);
			while (this.cache.size > CACHE_SIZE) {
				const oldest = this.cache.keys().next().value!;
				this.cache.delete(oldest);
			}
		}
		return pending;
	}

	private stopSources() {
		for (const entry of this.scheduled) {
			try {
				entry.source.stop();
			} catch {
				/* Not started yet or already stopped. */
			}
			entry.source.disconnect();
		}
		this.scheduled = [];
		if (this.ticker) clearInterval(this.ticker);
		this.ticker = null;
	}
}
