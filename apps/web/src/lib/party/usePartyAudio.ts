'use client';

import { useCallback, useEffect, useState } from 'react';
import { partyAudio } from './PartyAudioBank';
import type { SoundBiteId } from './party-types';

export interface UsePartyAudioReturn {
  volume: number;
  isMuted: boolean;
  cooldownRemainingMs: number;
  canPlaySound: boolean;
  setVolume: (v: number) => void;
  toggleMute: () => void;
  playSoundBite: (id: SoundBiteId) => boolean;
  playUiClick: () => void;
  playPop: () => void;
  playCountdownBeep: (isFinal?: boolean) => void;
  playVetoSound: () => void;
}

export function usePartyAudio(): UsePartyAudioReturn {
  const [volume, setVolumeState] = useState(0.8);
  const [isMuted, setIsMutedState] = useState(false);
  const [cooldownRemainingMs, setCooldownRemainingMs] = useState(0);

  useEffect(() => {
    setVolumeState(partyAudio.getVolume());
    setIsMutedState(partyAudio.getMuted());
  }, []);

  // Update cooldown timer every 100ms when cooldown is active
  useEffect(() => {
    if (cooldownRemainingMs <= 0) return;

    const interval = setInterval(() => {
      const rem = partyAudio.getCooldownRemainingMs();
      setCooldownRemainingMs(rem);
      if (rem <= 0) {
        clearInterval(interval);
      }
    }, 100);

    return () => clearInterval(interval);
  }, [cooldownRemainingMs]);

  const setVolume = useCallback((v: number) => {
    partyAudio.setVolume(v);
    setVolumeState(v);
  }, []);

  const toggleMute = useCallback(() => {
    const next = !partyAudio.getMuted();
    partyAudio.setMuted(next);
    setIsMutedState(next);
  }, []);

  const playSoundBite = useCallback((id: SoundBiteId) => {
    const success = partyAudio.playSoundBite(id);
    if (success) {
      setCooldownRemainingMs(partyAudio.getCooldownRemainingMs());
    }
    return success;
  }, []);

  const playUiClick = useCallback(() => partyAudio.playUiClick(), []);
  const playPop = useCallback(() => partyAudio.playPop(), []);
  const playCountdownBeep = useCallback(
    (isFinal?: boolean) => partyAudio.playCountdownBeep(isFinal),
    [],
  );
  const playVetoSound = useCallback(() => partyAudio.playVetoSound(), []);

  return {
    volume,
    isMuted,
    cooldownRemainingMs,
    canPlaySound: cooldownRemainingMs === 0,
    setVolume,
    toggleMute,
    playSoundBite,
    playUiClick,
    playPop,
    playCountdownBeep,
    playVetoSound,
  };
}
