import type { View } from '../src/protocol';

// Audio is host-side only. The projector can carry the music; each player's phone stays silent.
type Cue = 'showtime-theme' | 'thinking-pulse' | 'buzz-in' | 'answer-reveal';
const source = (name: Cue) => {
  const audio = new Audio();
  const probe = document.createElement('audio');
  audio.src = `/audio/${name}.${probe.canPlayType('audio/ogg; codecs="vorbis"') ? 'ogg' : 'mp3'}`;
  audio.preload = 'auto';
  return audio;
};
const theme = source('showtime-theme');
const thinking = source('thinking-pulse');
const buzz = source('buzz-in');
const reveal = source('answer-reveal');
theme.loop = true;
thinking.loop = true;
theme.volume = .28;
thinking.volume = .2;
buzz.volume = .48;
reveal.volume = .42;
let enabled = false;
let lastVersion = -1;
let lastPhase: View['phase'] | undefined;
let lastBuzzer: string | undefined;
let lastCell: string | null = null;
const play = (audio: HTMLAudioElement, restart = false) => {
  if (!enabled) return;
  if (restart) audio.currentTime = 0;
  void audio.play().catch(() => { /* browser or device declined audio */ });
};
function stop(audio: HTMLAudioElement) { audio.pause(); audio.currentTime = 0; }

export function makeMusicToggle(button: HTMLButtonElement) {
  button.onclick = () => {
    enabled = !enabled;
    button.textContent = enabled ? 'Sound on' : 'Sound off';
    button.setAttribute('aria-pressed', String(enabled));
    if (!enabled) { for (const track of [theme, thinking, buzz, reveal]) stop(track); return; }
    if (lastPhase === 'lobby' || lastPhase === 'board') play(theme);
    if (lastPhase === 'question-showing' || lastPhase === 'buzz-open') play(thinking);
  };
}

export function syncMusic(view: View) {
  if (view.version === lastVersion) return;
  const previousPhase = lastPhase;
  const previousBuzzer = lastBuzzer;
  const previousCell = lastCell;
  lastVersion = view.version;
  lastPhase = view.phase;
  lastBuzzer = view.buzzQueue[0];
  lastCell = view.selectedCellId;
  // On first socket snapshot (including reconnect), align loops but don't fire stingers.
  if (view.phase === 'lobby' || view.phase === 'board') {
    stop(thinking);
    if (enabled && theme.paused) play(theme);
  } else if (view.phase === 'question-showing' || view.phase === 'buzz-open') {
    stop(theme);
    if (previousCell !== view.selectedCellId) stop(thinking);
    if (enabled && thinking.paused) play(thinking);
  } else { stop(theme); stop(thinking); }
  if (previousPhase === undefined || !enabled) return;
  if (view.phase === 'buzzed' && view.buzzQueue[0] && (previousPhase !== 'buzzed' || previousBuzzer !== view.buzzQueue[0])) play(buzz, true);
  if (view.phase === 'resolving' && previousPhase !== 'resolving') play(reveal, true);
}
