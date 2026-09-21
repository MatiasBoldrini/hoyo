const HEAVY = new Set(["house", "building", "tower", "fountain", "bus"]);
const CRUNCH = new Set(["car", "van", "tree", "lamp", "bench", "cone", "hydrant", "bin", "fence"]);

// Grabaciones CC0, recortadas al golpe. No son síntesis.
// gulp: Breviceps, "Cartoon - Gulp!", Freesound 450624.
// gulp-small: OwlStorm, "Gulp (1)", Freesound 151234.
// crunch-*: StarNinjas / Tito, "7 Eating Crunches", OpenGameArt.
const BANKS = {
  gulp: ["gulp-small.wav", "gulp.wav"],
  crunch: ["crunch-3.wav", "crunch-4.wav", "crunch-5.wav", "crunch-6.wav", "crunch-7.wav"],
  heavy: ["crunch-1.wav", "crunch-2.wav"],
};

export function createSfx() {
  let ctx = null;
  let master = null;
  let noise = null;
  let clips = null;
  let loading = null;
  let lastSwallow = 0;
  let combo = 0;

  function context() {
    if (ctx) return ctx;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    ctx = new Ctx();
    master = ctx.createGain();
    master.gain.value = 0.85;
    master.connect(ctx.destination);

    noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const data = noise.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    return ctx;
  }

  function env(gain, t, peak, duration) {
    const attack = Math.min(0.012, duration * 0.28);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t + attack);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + Math.max(duration, attack + 0.02));
  }

  function air(t, duration, peak, fromHz, toHz, type, q) {
    const src = ctx.createBufferSource();
    src.buffer = noise;
    const filter = ctx.createBiquadFilter();
    filter.type = type;
    filter.Q.value = q;
    const gain = ctx.createGain();
    src.connect(filter);
    filter.connect(gain);
    gain.connect(master);
    filter.frequency.setValueAtTime(Math.max(48, fromHz), t);
    filter.frequency.exponentialRampToValueAtTime(Math.max(48, toHz), t + duration);
    env(gain, t, peak, duration);
    src.start(t);
    src.stop(t + duration + 0.03);
  }

  function voice(t, type, from, to, duration, peak) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.connect(gain);
    gain.connect(master);
    osc.frequency.setValueAtTime(Math.max(36, from), t);
    osc.frequency.exponentialRampToValueAtTime(Math.max(36, to), t + duration);
    env(gain, t, peak, duration);
    osc.start(t);
    osc.stop(t + duration + 0.03);
  }

  function loadClips() {
    const audio = context();
    if (!audio) return Promise.resolve(null);
    if (clips) return Promise.resolve(clips);
    if (loading) return loading;
    const names = [...new Set(Object.values(BANKS).flat())];
    loading = Promise.all(
      names.map(async (name) => {
        const res = await fetch(`/sfx/${name}`);
        if (!res.ok) throw new Error(name);
        const raw = await res.arrayBuffer();
        const buf = await audio.decodeAudioData(raw.slice(0));
        return [name, buf];
      }),
    )
      .then((pairs) => {
        clips = Object.fromEntries(pairs);
        return clips;
      })
      .catch(() => {
        loading = null;
        return null;
      });
    return loading;
  }

  function play(name, rate, peak) {
    const buf = clips?.[name];
    if (!buf || !ctx) return false;
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    const gain = ctx.createGain();
    src.buffer = buf;
    src.playbackRate.value = rate;
    src.connect(gain);
    gain.connect(master);
    const dur = buf.duration / rate;
    const tail = Math.min(0.035, dur * 0.22);
    gain.gain.setValueAtTime(peak, t);
    gain.gain.setValueAtTime(peak, t + Math.max(0, dur - tail));
    gain.gain.exponentialRampToValueAtTime(0.001, t + dur);
    src.start(t);
    src.stop(t + dur + 0.02);
    return true;
  }

  function bankFor(kind, mass) {
    if (HEAVY.has(kind) || mass >= 48) return "heavy";
    if (CRUNCH.has(kind) || mass >= 14) return "crunch";
    return "gulp";
  }

  function pick(bank, mass) {
    if (bank === "gulp") return mass <= 2 ? "gulp-small.wav" : "gulp.wav";
    const list = BANKS[bank];
    return list[(Math.random() * list.length) | 0];
  }

  return {
    resume() {
      const audio = context();
      if (audio && audio.state === "suspended") audio.resume();
      loadClips();
    },
    begin() {
      if (!context()) return;
      const t = ctx.currentTime;
      air(t, 0.28, 0.055, 260, 1700, "bandpass", 0.55);
      voice(t, "sine", 130, 390, 0.2, 0.045);
    },
    swallow(kind, mass, radius = 1) {
      if (!context() || !clips) {
        loadClips();
        return;
      }
      const now = ctx.currentTime;
      if (now - lastSwallow < 0.055) combo = Math.min(7, combo + 1);
      else combo = 0;
      lastSwallow = now;
      const bank = bankFor(kind, mass);
      const baseRate = bank === "heavy" ? 0.82 : bank === "crunch" ? 0.98 : 1.05;
      const rate = baseRate * (1 + combo * 0.03) * (0.97 + Math.random() * 0.06);
      const baseGain = bank === "heavy" ? 0.72 : bank === "crunch" ? 0.55 : 0.42;
      const gain = Math.min(0.92, baseGain * (0.78 + Math.min(radius, 10) * 0.04) * (1 + combo * 0.035));
      play(pick(bank, mass), rate, gain);
    },
    eaten() {
      if (!context()) return;
      loadClips().then(() => play("gulp.wav", 0.72, 0.7));
    },
    rival() {
      if (!context()) return;
      loadClips().then(() => {
        play("gulp.wav", 1.08, 0.4);
        window.setTimeout(() => play("gulp-small.wav", 1.16, 0.32), 78);
      });
    },
    finish(won) {
      if (!context()) return;
      const t = ctx.currentTime;
      if (won) {
        loadClips().then(() => {
          play("gulp.wav", 0.96, 0.4);
          window.setTimeout(() => play("gulp.wav", 1.12, 0.46), 120);
        });
        window.setTimeout(() => {
          if (!ctx || ctx.state === "closed") return;
          const now = ctx.currentTime;
          voice(now, "sine", 520, 880, 0.22, 0.06);
          air(now, 0.16, 0.04, 600, 1800, "bandpass", 0.8);
        }, 230);
        return;
      }
      voice(t, "sine", 240, 52, 0.4, 0.07);
      air(t, 0.36, 0.05, 900, 120, "lowpass", 0.6);
    },
  };
}
