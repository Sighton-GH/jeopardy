import type { View } from '../src/protocol';
import realThemeMp3 from './audio/jeopardy-main-modern.mp3?url';
import realThemeOgg from './audio/jeopardy-main-modern.ogg?url';
import showtimethemeMp3 from './audio/showtime-theme.mp3?url';
import showtimethemeOgg from './audio/showtime-theme.ogg?url';
import thinkingpulseMp3 from './audio/thinking-pulse.mp3?url';
import thinkingpulseOgg from './audio/thinking-pulse.ogg?url';
import buzzinMp3 from './audio/buzz-in.mp3?url';
import buzzinOgg from './audio/buzz-in.ogg?url';
import answerrevealMp3 from './audio/answer-reveal.mp3?url';
import answerrevealOgg from './audio/answer-reveal.ogg?url';

// Audio is host-side only. The projector can carry the music; each player's phone stays silent.
type Cue = 'showtime-theme' | 'thinking-pulse' | 'buzz-in' | 'answer-reveal';
const sources = {
  'showtime-theme': { mp3: showtimethemeMp3, ogg: showtimethemeOgg },
  'thinking-pulse': { mp3: thinkingpulseMp3, ogg: thinkingpulseOgg },
  'buzz-in': { mp3: buzzinMp3, ogg: buzzinOgg },
  'answer-reveal': { mp3: answerrevealMp3, ogg: answerrevealOgg },
};
const source = (name: Cue) => {
  const audio = new Audio();
  audio.src = document.createElement('audio').canPlayType('audio/ogg; codecs="vorbis"') ? sources[name].ogg : sources[name].mp3;
  audio.preload = 'auto';
  return audio;
};
const lobby = source('showtime-theme');
const thinking = source('thinking-pulse');
const realTheme = new Audio(document.createElement('audio').canPlayType('audio/ogg; codecs="vorbis"') ? realThemeOgg : realThemeMp3);
realTheme.loop = true; realTheme.volume = .35; realTheme.preload = 'auto';
const buzz = source('buzz-in');
const reveal = source('answer-reveal');
lobby.loop = true;
thinking.loop = true;
lobby.volume = .28;
thinking.volume = .2;
buzz.volume = .48;
reveal.volume = .42;
let enabled = false;
let manuallyToggled = false;
let theme: View['theme'] | undefined;
const clueTrack = () => theme === 'slxca-2026' ? realTheme : thinking;
// Start the selected track inside the trusted click before the server acknowledges the clue.
export function prepareClueAudio() {
  if (lastPhase !== 'board') return;
  // A host's clue click is a browser audio gesture. Sound starts by default for SLxCA, unless switched off.
  if (!enabled) return;
  stop(lobby);
  stop(thinking); stop(realTheme);
  play(clueTrack());
}
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
    manuallyToggled = true;
    button.textContent = enabled ? 'Sound on' : 'Sound off';
    button.setAttribute('aria-pressed', String(enabled));
    if (!enabled) { for (const track of [lobby, thinking, realTheme, buzz, reveal]) stop(track); return; }
    if ((lastPhase === 'lobby' || lastPhase === 'board') && theme !== 'slxca-2026') play(lobby);
    if (lastCell && lastPhase !== 'board' && lastPhase !== 'complete') play(clueTrack());
  };
}

export function syncMusic(view: View) {
  if (view.version === lastVersion) return;
  const previousPhase = lastPhase;
  const previousBuzzer = lastBuzzer;
  const previousCell = lastCell;
  lastVersion = view.version;
  theme = view.theme;
  if (theme === 'slxca-2026' && !manuallyToggled && !enabled) { enabled = true; const button = document.getElementById('sound-toggle'); if (button) { button.textContent = 'Sound on'; button.setAttribute('aria-pressed', 'true'); } }
  lastPhase = view.phase;
  lastBuzzer = view.buzzQueue[0];
  lastCell = view.selectedCellId;
  // On first socket snapshot (including reconnect), align loops but don't fire stingers.
  if (view.phase === 'lobby' || view.phase === 'board') {
    stop(thinking); stop(realTheme);
    if (enabled && theme !== 'slxca-2026' && lobby.paused) play(lobby);
  } else if (view.selectedCellId && view.phase !== 'complete') {
    stop(lobby);
    if (previousCell !== view.selectedCellId) { stop(thinking); stop(realTheme); }
    const selected = clueTrack();
    if (enabled && selected.paused) play(selected);
  } else { stop(lobby); stop(thinking); stop(realTheme); }
  if (previousPhase === undefined || !enabled) return;
  if (theme !== 'slxca-2026' && view.phase === 'buzzed' && view.buzzQueue[0] && (previousPhase !== 'buzzed' || previousBuzzer !== view.buzzQueue[0])) play(buzz, true);
  if (theme !== 'slxca-2026' && view.phase === 'resolving' && previousPhase !== 'resolving') play(reveal, true);
}
