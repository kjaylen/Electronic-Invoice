/**
 * Feedback on key actions: a short vibration where the device can (Android; iOS web views cannot) and
 * an optional soft click, both chosen per device under Devices. The visible response (the pressed
 * state) is always there and comes first, within one frame of the tap.
 */

const HAPTIC = 'till.haptics';
const SOUND = 'till.sound';
const flag = (key: string, fallback: boolean) => {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : v === '1';
  } catch {
    return fallback;
  }
};

export const feedbackSettings = {
  haptics: () => flag(HAPTIC, true),
  sound: () => flag(SOUND, false),
  set(key: 'haptics' | 'sound', on: boolean) {
    try {
      localStorage.setItem(key === 'haptics' ? HAPTIC : SOUND, on ? '1' : '0');
    } catch {
      /* blocked */
    }
  },
};

let audio: AudioContext | null = null;

/** kind: a tap on a key or tile, a success (paid, sent), or a refusal. */
export function feedback(kind: 'tap' | 'success' | 'error' = 'tap') {
  if (feedbackSettings.haptics() && typeof navigator !== 'undefined' && 'vibrate' in navigator) {
    try {
      navigator.vibrate(kind === 'tap' ? 8 : kind === 'success' ? [12, 40, 12] : [30, 30, 30]);
    } catch {
      /* not allowed */
    }
  }
  if (!feedbackSettings.sound()) return;
  try {
    audio ??= new AudioContext();
    const o = audio.createOscillator();
    const g = audio.createGain();
    o.frequency.value = kind === 'error' ? 220 : kind === 'success' ? 880 : 640;
    g.gain.setValueAtTime(0.05, audio.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + (kind === 'tap' ? 0.04 : 0.12));
    o.connect(g).connect(audio.destination);
    o.start();
    o.stop(audio.currentTime + 0.13);
  } catch {
    /* no audio */
  }
}
