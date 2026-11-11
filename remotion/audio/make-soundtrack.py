#!/usr/bin/env python3
"""Synthesises the RixorFilm soundtrack (30 s, 48 kHz stereo) with numpy only: no samples, no downloads.

    python3 remotion/audio/make-soundtrack.py        ->  public/audio/rixor-film.wav

Every event is placed on a video frame (30 fps), using the same frame numbers as remotion/compositions/RixorFilm.tsx.
Music runs at 120 BPM, so one beat is exactly 15 frames and one bar is 60 frames.
"""
import os
import wave
import numpy as np

SR, FPS, TOTAL = 48000, 30, 900
N = SR * TOTAL // FPS
rng = np.random.default_rng(11)
dry = np.zeros((N, 2))
wet = np.zeros((N, 2))  # reverb send

# ---- frame map (mirrors RixorFilm.tsx) -------------------------------------------------------------------------
TWEETS = [8, 56, 96, 134, 168, 194]
TWEETS_END = 224
HOOK1, HOOK2, DROP = 240, 270, 300
FLOW = 360
TAPS = [FLOW + 15, FLOW + 105, FLOW + 120, FLOW + 135, FLOW + 285]
TYPING = [FLOW + 68, FLOW + 74, FLOW + 80, FLOW + 86]
CONNECTED = FLOW + 19
LOCKED = FLOW + 150
EARN = FLOW + 180
COINS = [EARN + 22 + 5 * i for i in range(13)]
CLAIMED = FLOW + 289
TRUST = [720, 750, 780]
END = 840
BEAT = 15


def T(frame):
    return frame / FPS


def tt(d):
    return np.arange(int(d * SR)) / SR


def noise(n):
    return rng.standard_normal(n)


def filt(x, lo=None, hi=None, order=2):
    """Zero-phase Butterworth-shaped filter in the frequency domain."""
    X = np.fft.rfft(x)
    f = np.fft.rfftfreq(len(x), 1 / SR)
    H = np.ones_like(f)
    if hi:
        H /= np.sqrt(1 + (f / hi) ** (2 * order))
    if lo:
        r = (f / lo) ** order
        H *= r / np.sqrt(1 + r * r)
    return np.fft.irfft(X * H, len(x))


def fade(sig, a=0.002, r=0.02):
    na, nr = max(1, int(a * SR)), max(1, int(r * SR))
    sig = sig.copy()
    sig[:na] *= np.linspace(0, 1, na)
    sig[-nr:] *= np.linspace(1, 0, nr)
    return sig


def place(bus, sig, t0, gain=1.0, pan=0.0):
    i = int(round(t0 * SR))
    if sig.ndim == 1:
        left, right = np.cos((pan + 1) * np.pi / 4) * 1.4142, np.sin((pan + 1) * np.pi / 4) * 1.4142
        sig = np.stack([sig * left, sig * right], axis=1)
    if i < 0:
        sig, i = sig[-i:], 0
    n = min(len(sig), N - i)
    if n > 0:
        bus[i:i + n] += sig[:n] * gain


def put(sig, frame, gain=1.0, pan=0.0, send=0.0, offset=0.0):
    place(dry, sig, T(frame) + offset, gain, pan)
    if send:
        place(wet, sig, T(frame) + offset, gain * send, pan)


def saw(f, t, partials=10):
    return sum(np.sin(2 * np.pi * f * k * t) / k for k in range(1, partials + 1) if f * k < 9000)


# ---- instruments ----------------------------------------------------------------------------------------------

def kick():
    t = tt(0.42)
    ph = 2 * np.pi * np.cumsum(50 + 150 * np.exp(-t / 0.028)) / SR
    s = (np.sin(ph) + 0.35 * np.sin(2 * ph) * np.exp(-t / 0.05)) * np.exp(-t / 0.12)
    s += filt(noise(len(t)), lo=1800) * np.exp(-t / 0.005) * 0.4
    return fade(np.tanh(s * 1.5))


def impact(pitch=1.0, bright=0.4, d=2.6, tone=110.0):
    """Cinematic hit. Most of its weight sits at 90-600 Hz so it still lands on a phone speaker."""
    t = tt(d)
    sub = np.sin(2 * np.pi * np.cumsum((40 + 110 * np.exp(-t / 0.05)) * pitch) / SR) * np.exp(-t / 0.34) * 0.55
    thump = np.sin(2 * np.pi * np.cumsum((92 + 150 * np.exp(-t / 0.03)) * pitch) / SR) * np.exp(-t / 0.13) * 0.9
    body = filt(noise(len(t)), lo=90, hi=650) * np.exp(-t / 0.24) * 2.4
    crack = filt(noise(len(t)), lo=1000, hi=6500) * np.exp(-t / 0.05) * bright * 1.6
    braam = filt(saw(tone * pitch, t, 16) + saw(tone * pitch * 1.008, t, 16) + 0.6 * saw(tone * pitch * 2, t, 10), lo=130, hi=1500) * np.exp(-t / 0.5) * 0.3
    return fade(np.tanh((sub + thump + body * 0.6 + crack + braam) * 1.2), r=0.08)


def clap():
    t = tt(0.4)
    env = sum(np.where(t >= o, np.exp(-(t - o) / 0.006), 0) for o in (0, 0.011, 0.022)) * 0.6 + np.where(t >= 0.03, np.exp(-(t - 0.03) / 0.09), 0)
    return fade(filt(noise(len(t)), lo=900, hi=3800) * env * 2.2)


def hat(open_=False):
    t = tt(0.3 if open_ else 0.08)
    return fade(filt(noise(len(t)), lo=7500) * np.exp(-t / (0.09 if open_ else 0.018)), r=0.005)


def crash(d=2.6):
    t = tt(d)
    return fade(filt(noise(len(t)), lo=3800) * np.exp(-t / 0.8), r=0.1)


def swell(d=0.5):
    """Reverse cymbal ending exactly at its last sample."""
    t = tt(d)
    return fade(filt(noise(len(t)), lo=2500) * np.exp(-(d - t) / (d * 0.28)), a=0.02, r=0.004)


def whoosh(d=0.7):
    t = tt(d)
    out = np.zeros(len(t))
    for k, c in enumerate([350, 700, 1400, 2800, 5200]):
        mu = d * (0.3 + 0.1 * k)
        out += filt(noise(len(t)), lo=c / 1.5, hi=c * 1.5) * np.exp(-((t - mu) ** 2) / (2 * (0.13 * d) ** 2)) * (1.6 + 0.5 * k)
    x = t / d
    return np.stack([fade(out) * (1 - x * 0.7), fade(out) * (0.3 + x * 0.7)], axis=1)


def riser(d):
    t = tt(d)
    x = t / d
    out = np.zeros(len(t))
    for k, c in enumerate([300, 600, 1200, 2400, 4800, 8000]):
        mu = d * (0.25 + 0.15 * k)
        out += filt(noise(len(t)), lo=c / 1.5, hi=c * 1.5) * np.exp(-((t - mu) ** 2) / (2 * (0.22 * d) ** 2)) * 2.0
    out *= x ** 1.6
    glide = 170 * 2 ** (2.4 * x ** 2)
    out += np.sin(2 * np.pi * np.cumsum(glide) / SR) * x ** 2 * 0.5
    out *= 1 - 0.35 * (0.5 + 0.5 * np.sin(2 * np.pi * np.cumsum(4 + 14 * x ** 2) / SR)) * x  # accelerating tremolo
    return fade(out, a=0.05, r=0.003)


def drone(d):
    t = tt(d)
    x = t / d
    out = []
    for det in (1.0, 1.004):
        s = saw(55 * det, t, 14) + 0.7 * saw(82.41 / det, t, 9) + 0.5 * saw(110.3 * det, t, 7)
        s = filt(s, lo=70, hi=750, order=2)
        s *= (0.3 + 0.7 * x ** 1.5) * (1 - 0.18 * np.sin(2 * np.pi * 0.42 * t))
        air = (np.sin(2 * np.pi * 440 * det * t) + np.sin(2 * np.pi * 880 * det * t) + 0.7 * np.sin(2 * np.pi * 1318.5 / det * t)) * x ** 2.5 * 0.06
        out.append(fade(s * 0.5 + air, a=1.2, r=0.012))
    return np.stack(out, axis=1)


def ping(f, d=0.9):
    t = tt(d)
    s = np.sin(2 * np.pi * f * t) + 0.5 * np.sin(2 * np.pi * 2.76 * f * t) * np.exp(-t / 0.05) + 0.25 * np.sin(2 * np.pi * 5.4 * f * t) * np.exp(-t / 0.02)
    return fade(s * np.exp(-t / 0.2), a=0.001, r=0.05)


def tap():
    t = tt(0.09)
    s = np.sin(2 * np.pi * np.cumsum(520 + 900 * np.exp(-t / 0.004)) / SR) * np.exp(-t / 0.016)
    s += filt(noise(len(t)), lo=3000) * np.exp(-t / 0.002) * 0.3
    return fade(s, a=0.0005, r=0.01)


def tick():
    t = tt(0.035)
    return fade(filt(noise(len(t)), lo=2500, hi=7000) * np.exp(-t / 0.004) * 1.4 + np.sin(2 * np.pi * 3100 * t) * np.exp(-t / 0.005) * 0.4, a=0.0003, r=0.005)


def clunk():
    t = tt(0.6)
    thud = np.sin(2 * np.pi * np.cumsum(68 + 70 * np.exp(-t / 0.02)) / SR) * np.exp(-t / 0.1)
    metal = sum(a * np.sin(2 * np.pi * f * t) * np.exp(-t / dcy) for f, dcy, a in [(820, 0.09, 0.5), (1370, 0.07, 0.4), (2210, 0.05, 0.3), (3290, 0.04, 0.2), (4410, 0.03, 0.15)])
    click = filt(noise(len(t)), lo=2500) * np.exp(-t / 0.003) * 0.6
    s = thud * 1.1 + metal + click
    o = int(0.05 * SR)  # the latch falls a moment later
    s[o:] += (metal[:-o] * 0.5 + click[:-o] * 0.6)
    return fade(np.tanh(s * 1.2), a=0.0005, r=0.05)


def stab(notes, d=2.4, decay=1.0, cutoff=2600):
    t = tt(d)
    out = []
    for det in (0.997, 1.003):
        s = sum(saw(f * det, t, 12) for f in notes) / len(notes)
        out.append(fade(filt(s, hi=cutoff) * np.exp(-t / decay), a=0.004, r=0.2))
    return np.stack(out, axis=1)


# ---- 1. cold open: drone, a hit on every post, riser, vacuum -----------------------------------------------------
place(dry, drone(T(TWEETS_END)), 0, 0.6)
place(wet, drone(T(TWEETS_END)), 0, 0.18)
for i, f in enumerate(TWEETS):
    put(impact(pitch=1.0 + i * 0.045, bright=0.35 + i * 0.05), f, 0.85 + i * 0.03, send=0.55)
    put(tick(), f, 0.5, pan=(-0.3, 0.3)[i % 2], send=0.4)
rise_from = 120
put(riser(T(TWEETS_END - rise_from)), rise_from, 0.3, send=0.25)

# ---- 2. hook slams and the drop -----------------------------------------------------------------------------------
put(impact(pitch=0.92, bright=0.7), HOOK1, 1.0, send=0.6)
put(impact(pitch=1.0, bright=0.8), HOOK2, 1.0, send=0.6)
sw = swell(0.5)
put(sw, DROP, 0.34, send=0.2, offset=-0.5)
put(impact(pitch=1.1, bright=0.9), DROP, 1.0, send=0.5)
put(crash(), DROP, 0.2, send=0.3)

# ---- 3. music: 120 BPM, bars of 60 frames from the drop to the end card -------------------------------------------
A1, F1, C2, G1 = 55.0, 43.65, 65.41, 49.0
CHORDS = {
    'Am': (A1, [220.0, 261.63, 329.63]),
    'F': (F1, [220.0, 261.63, 349.23]),
    'C': (C2, [196.0, 261.63, 329.63]),
    'G': (G1, [196.0, 246.94, 293.66]),
}
BARS = ['Am', 'F', 'C', 'G', 'Am', 'F', 'C', 'G', 'F']  # bar k starts at frame DROP + 60k; the end card (840) resolves to C
bar_frame = lambda k: DROP + 60 * k

kicks = []
for k in range(len(BARS)):
    beats = [0, 2] if k in (0, 7) else [0, 1, 2, 3]
    if k == 8:
        beats = [2]  # 780 is a statement slam; one kick at 810 before the roll
    kicks += [bar_frame(k) + b * BEAT for b in beats]
K = kick()
for f in kicks:
    put(K, f, 0.62)

side = np.ones(N)  # sidechain: everything musical ducks under the kick
for f in kicks + TRUST:
    i = int(T(f) * SR)
    n = min(int(0.45 * SR), N - i)
    side[i:i + n] = np.minimum(side[i:i + n], 1 - 0.7 * np.exp(-tt(0.45)[:n] / 0.11))

bass = np.zeros(N)
pad = np.zeros((N, 2))
arp = np.zeros(N)
hats = np.zeros(N)
for k, name in enumerate(BARS):
    root, chord = CHORDS[name]
    b0 = T(bar_frame(k))
    # bass: eighth notes
    t = tt(0.24)
    note = fade(saw(root, t, 12) * (0.35 + 0.65 * np.exp(-t / 0.12)), a=0.004, r=0.03)
    for e in range(8):
        if k == 8 and e >= 4:
            break
        i = int((b0 + e * 0.25) * SR)
        bass[i:i + len(note)] += note * (1.0 if e % 2 else 0.8)
    # pad: one chord per bar
    t = tt(2.0)
    for ch, det in enumerate((0.996, 1.004)):
        s = sum(saw(f * det, t, 10) + 0.5 * saw(f * 2 / det, t, 6) for f in chord) / 3
        s = fade(s, a=0.18, r=0.25)
        i = int(b0 * SR)
        pad[i:i + len(s), ch] += s
    # arp: sixteenth notes, from the phone flow to the end of the flow; denser octave in the earn/claim bars
    if 1 <= k <= 6:
        tones = [chord[0] * 2, chord[1] * 2, chord[2] * 2, chord[1] * 4 if k >= 4 else chord[1] * 2]
        pattern = [0, 2, 1, 2, 3, 2, 1, 2] * 2
        t = tt(0.3)
        for s16, idx in enumerate(pattern):
            f = tones[idx]
            pl = fade((np.sin(2 * np.pi * f * t) + 0.4 * np.sin(4 * np.pi * f * t) + 0.15 * np.sin(6 * np.pi * f * t)) * np.exp(-t / 0.085), a=0.002, r=0.02)
            i = int((b0 + s16 * 0.125) * SR)
            arp[i:i + len(pl)] += pl * (1.0 if s16 % 4 == 0 else 0.7)
        # hats: offbeat eighths, plus quiet sixteenths once the position is earning
        h, ho = hat(), hat(True)
        for e in range(8):
            i = int((b0 + e * 0.25) * SR)
            if e % 2:
                hats[i:i + len(h)] += h
        if k >= 4:
            for s16 in range(16):
                if s16 % 2:
                    i = int((b0 + s16 * 0.125) * SR)
                    hats[i:i + len(h)] += h * 0.45
        i = int((b0 + 1.75) * SR)
        hats[i:i + len(ho)] += ho * 0.6
        C_ = clap()
        for b in (1, 3):
            put(C_, bar_frame(k) + b * BEAT, 0.3, send=0.35)

bass = filt(bass, lo=45, hi=950) * side
place(dry, bass, 0, 0.42)
for ch in range(2):
    pad[:, ch] = filt(pad[:, ch], lo=160, hi=2400) * side
place(dry, pad, 0, 0.36)
place(wet, pad, 0, 0.12)
arp = arp * (0.6 + 0.4 * side)
place(dry, arp, 0, 0.24, pan=-0.15)
place(dry, arp, 0.375, 0.1, pan=0.6)   # ping-pong delay (dotted eighth)
place(dry, arp, 0.75, 0.05, pan=-0.6)
place(wet, arp, 0, 0.09)
place(dry, hats, 0, 0.12, pan=0.2)

put(crash(), bar_frame(1), 0.14, send=0.3)
put(crash(), bar_frame(4), 0.12, send=0.3)

# snare roll into the end card
for j, f in enumerate(np.linspace(810, 838, 12)):
    put(clap(), float(f), 0.1 + j * 0.022, send=0.3)
put(swell(0.9), END, 0.36, send=0.2, offset=-0.9)

# ---- 4. interface sounds, on the frames where the picture changes --------------------------------------------------
for f in TAPS:
    put(tap(), f, 0.5, pan=0.35, send=0.15)
for f in TYPING:
    put(tick(), f, 0.34, pan=0.35)
put(ping(1318.5, 0.4), CONNECTED, 0.2, pan=0.35, send=0.3)
put(ping(1760.0, 0.6), CONNECTED, 0.2, pan=0.35, send=0.3, offset=0.075)
put(clunk(), LOCKED, 0.75, pan=0.3, send=0.3)
put(impact(pitch=1.3, bright=0.2, d=1.2), LOCKED, 0.4, send=0.3)
PENTA = [880.0, 1046.5, 1174.66, 1318.5, 1568.0, 1760.0, 2093.0, 2349.3, 2637.0]
for i, f in enumerate(COINS):
    put(ping(PENTA[(i * 2) % 5 + min(4, i // 3)], 0.7), f, 0.15 + i * 0.006, pan=0.1 + 0.3 * (i % 2), send=0.4)
for j, f0 in enumerate([1046.5, 1318.5, 1568.0, 2093.0, 2637.0]):  # claim: a rising major arpeggio of bells
    put(ping(f0, 1.4), CLAIMED, 0.24, pan=0.35 - 0.15 * j, send=0.6, offset=0.045 * j)
t = tt(1.2)
put(fade(filt(noise(len(t)), lo=6500) * np.exp(-t / 0.35), r=0.1), CLAIMED, 0.1, send=0.5)
put(impact(pitch=1.2, bright=0.3, d=1.4), CLAIMED, 0.5, send=0.3)

for f, d, g in [(DROP + 23, 0.45, 0.2), (FLOW, 0.7, 0.3), (FLOW + 60, 0.5, 0.16), (EARN, 0.6, 0.2), (FLOW + 270, 0.5, 0.16), (720, 0.7, 0.3), (END, 0.7, 0.3)]:
    place(dry, whoosh(d), T(f) - d * 0.55, g)
    place(wet, whoosh(d), T(f) - d * 0.55, g * 0.3)

# ---- 5. the three statements and the end card ----------------------------------------------------------------------
for i, f in enumerate(TRUST):
    put(impact(pitch=1.0 + i * 0.08, bright=0.9, d=1.6), f, 0.9, send=0.45)
    put(clap(), f, 0.3, send=0.4)

put(impact(pitch=0.95, bright=1.0, d=2.8), END, 1.0, send=0.6)
put(crash(3.0), END, 0.2, send=0.4)
END_CHORD = [130.81, 196.0, 261.63, 329.63, 392.0, 523.25]
place(dry, stab(END_CHORD), T(END), 0.5)
place(wet, stab(END_CHORD), T(END), 0.35)
put(ping(2093.0, 1.6), END, 0.16, send=0.7)

# ---- reverb, automation, master -------------------------------------------------------------------------------------
L = int(2.6 * SR)
tl = np.arange(L) / SR
size = 1 << int(np.ceil(np.log2(N + L)))
mix = dry.copy()
for ch in range(2):
    ir = filt(noise(L) * np.exp(-tl / 0.5), lo=250, hi=7000)
    ir[: int(0.02 * SR)] = 0
    ir /= np.sqrt(np.sum(ir ** 2))
    tail = np.fft.irfft(np.fft.rfft(wet[:, ch], size) * np.fft.rfft(ir, size), size)[:N]
    mix[:, ch] += tail * 0.9

auto = np.ones(N)  # the "vacuum": everything is pulled out just before the hook slams back in
a, b = int(T(TWEETS_END) * SR), int(T(HOOK1) * SR)
auto[a:b] = 0.04
ramp = int(0.03 * SR)
auto[a:a + ramp] = np.linspace(1, 0.04, ramp)
auto[-int(0.3 * SR):] *= np.linspace(1, 0, int(0.3 * SR))
for ch in range(2):
    mix[:, ch] = filt(mix[:, ch], lo=38) * auto

mix *= 0.75 / np.percentile(np.abs(mix), 99.9)
mix = np.tanh(mix)
mix *= 0.93 / np.max(np.abs(mix))

out = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'public', 'audio', 'rixor-film.wav')
os.makedirs(os.path.dirname(out), exist_ok=True)
with wave.open(out, 'wb') as w:
    w.setnchannels(2)
    w.setsampwidth(2)
    w.setframerate(SR)
    w.writeframes((mix * 32767).astype('<i2').tobytes())

rms = lambda x: 20 * np.log10(np.sqrt(np.mean(x ** 2)) + 1e-9)
print('wrote', os.path.normpath(out), f'{N / SR:.2f}s', 'peak', round(float(np.max(np.abs(mix))), 3), 'nan', bool(np.isnan(mix).any()))
for name, f0, f1 in [('cold open', 0, 224), ('vacuum', 226, 240), ('hook', 240, 300), ('logo', 300, 360), ('flow', 360, 720), ('trust', 720, 840), ('end', 840, 900)]:
    seg = mix[int(T(f0) * SR):int(T(f1) * SR)]
    print(f'  {name:10s} rms {rms(seg):6.1f} dBFS   peak {20 * np.log10(np.max(np.abs(seg)) + 1e-9):6.1f} dBFS')
