'use client';

import { useRouter } from 'next/navigation';
import { type FormEvent, useState } from 'react';
import { createPartyRoom } from '../../../lib/party/party-api';
import {
  PARTY_ACCENT_COLORS,
  PARTY_AVATARS,
  type PlaylistMode,
  type SelectionStrategy,
  getPartyProfile,
  savePartyProfile,
  savePartySession,
} from '../../../lib/party/party-types';
import { PartyAvatarPicker } from './PartyAvatarPicker';
import { PartyNameInput } from './PartyNameInput';

export function RoomCreationForm() {
  const router = useRouter();
  const savedProfile = getPartyProfile();

  const [title, setTitle] = useState("Grace's Game Night");
  const [isPrivate, setIsPrivate] = useState(false);
  const [maxPlayers, setMaxPlayers] = useState(8);
  const [playlistMode, setPlaylistMode] = useState<PlaylistMode>('BEST_OF_3');
  const [selectionStrategy, setSelectionStrategy] = useState<SelectionStrategy>('DEMOCRATIC_VOTE');

  // Host profile
  const [hostName, setHostName] = useState(savedProfile.displayName || 'PartyHost');
  const [avatarId, setAvatarId] = useState(savedProfile.avatarId || PARTY_AVATARS[0]?.id || 'fox');
  const [avatarColor, setAvatarColor] = useState(
    savedProfile.avatarColor || PARTY_ACCENT_COLORS[0],
  );

  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const playlistModes: { id: PlaylistMode; title: string; desc: string }[] = [
    {
      id: 'SINGLE_GAME',
      title: 'Single Game',
      desc: '1 quick round of pure showdown fun.',
    },
    {
      id: 'BEST_OF_3',
      title: 'Best of 3',
      desc: 'First to win across 3 rotating minigames.',
    },
    {
      id: 'BEST_OF_5',
      title: 'Best of 5',
      desc: '5 intensive rounds of competition.',
    },
    {
      id: 'POINTS_GAUNTLET',
      title: 'Points Gauntlet',
      desc: 'High-stakes Grand Prix placement scoring.',
    },
  ];

  const strategies: { id: SelectionStrategy; title: string; desc: string }[] = [
    {
      id: 'DEMOCRATIC_VOTE',
      title: 'Democratic Vote',
      desc: 'Players vote between 3 randomized candidates before each round.',
    },
    {
      id: 'RANDOM_SHUFFLE',
      title: 'Random Shuffle',
      desc: 'System shuffles and launches exciting games automatically.',
    },
    {
      id: 'HOST_CURATED',
      title: 'Host Curated',
      desc: 'Host chooses the games in queue.',
    },
  ];

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!hostName.trim()) {
      setError('Please provide a host name');
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      // Save profile for future sessions
      savePartyProfile({
        displayName: hostName.trim(),
        avatarId,
        avatarColor,
      });

      const res = await createPartyRoom({
        title: title.trim() || 'Gamehub Party',
        isPrivate,
        maxPlayers,
        playlistMode,
        selectionStrategy,
        hostName: hostName.trim(),
        avatarId,
        avatarColor,
      });

      // Persist host credentials
      savePartySession({
        roomId: res.roomId,
        roomCode: res.roomCode,
        memberId: res.memberId,
        sessionToken: res.hostSessionToken,
        isHost: true,
      });

      router.push(`/party/${res.roomCode}`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to create room';
      setError(msg);
      setIsLoading(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-8 max-w-2xl mx-auto">
      {error && (
        <div
          role="alert"
          className="p-4 rounded-xl bg-rose-500/10 border border-rose-500/30 text-rose-300 text-sm font-medium"
        >
          {error}
        </div>
      )}

      {/* Host Profile Section */}
      <section className="bg-neutral-900/80 border border-neutral-800 rounded-2xl p-6 space-y-5">
        <h2 className="text-base font-bold text-white uppercase tracking-wider flex items-center gap-2">
          <span>👑</span> Host Profile
        </h2>

        <PartyNameInput value={hostName} onChange={setHostName} placeholder="Your host name..." />

        <PartyAvatarPicker
          selectedAvatarId={avatarId}
          selectedColor={avatarColor}
          onSelectAvatar={setAvatarId}
          onSelectColor={setAvatarColor}
        />
      </section>

      {/* Room Settings */}
      <section className="bg-neutral-900/80 border border-neutral-800 rounded-2xl p-6 space-y-6">
        <h2 className="text-base font-bold text-white uppercase tracking-wider flex items-center gap-2">
          <span>⚙️</span> Room Settings
        </h2>

        <div>
          <label
            htmlFor="room-title"
            className="block text-xs font-semibold uppercase tracking-wider text-neutral-400 mb-1.5"
          >
            Party Room Title
          </label>
          <input
            id="room-title"
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={40}
            className="w-full h-12 px-4 rounded-xl bg-neutral-950 border border-neutral-700 text-white placeholder-neutral-500 focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 font-medium"
          />
        </div>

        {/* Max Active Players Slider (2-16) */}
        <div>
          <div className="flex justify-between items-center mb-2">
            <label
              htmlFor="max-players"
              className="text-xs font-semibold uppercase tracking-wider text-neutral-400"
            >
              Max Active Players
            </label>
            <span className="text-sm font-bold font-mono text-indigo-400">
              {maxPlayers} Players
            </span>
          </div>
          <input
            id="max-players"
            type="range"
            min={2}
            max={16}
            step={1}
            value={maxPlayers}
            onChange={(e) => setMaxPlayers(Number(e.target.value))}
            className="w-full accent-indigo-500 cursor-pointer h-2 bg-neutral-800 rounded-lg"
          />
          <div className="flex justify-between text-[11px] text-neutral-500 font-mono mt-1">
            <span>2 min</span>
            <span>8 recommended</span>
            <span>16 max</span>
          </div>
        </div>

        {/* Public / Private Toggle */}
        <div className="flex items-center justify-between p-4 bg-neutral-950 rounded-xl border border-neutral-800">
          <div>
            <span className="block text-sm font-semibold text-white">Private Room</span>
            <span className="block text-xs text-neutral-400">
              {isPrivate
                ? 'Only players with room code or direct link can join'
                : 'Visible in public Party Directory for anyone to discover'}
            </span>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={isPrivate}
            onClick={() => setIsPrivate(!isPrivate)}
            className={`relative inline-flex h-7 w-13 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-indigo-500 ${
              isPrivate ? 'bg-indigo-600' : 'bg-neutral-800'
            }`}
          >
            <span
              className={`pointer-events-none inline-block h-6 w-6 transform rounded-full bg-white shadow-lg ring-0 transition duration-200 ease-in-out ${
                isPrivate ? 'translate-x-6' : 'translate-x-0'
              }`}
            />
          </button>
        </div>
      </section>

      {/* Playlist & Selection Strategy */}
      <section className="bg-neutral-900/80 border border-neutral-800 rounded-2xl p-6 space-y-6">
        <h2 className="text-base font-bold text-white uppercase tracking-wider flex items-center gap-2">
          <span>🎯</span> Match Format & Selection
        </h2>

        <div>
          <span className="block text-xs font-semibold uppercase tracking-wider text-neutral-400 mb-2">
            Playlist Mode
          </span>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {playlistModes.map((mode) => {
              const isSelected = playlistMode === mode.id;
              return (
                <button
                  key={mode.id}
                  type="button"
                  onClick={() => setPlaylistMode(mode.id)}
                  className={`text-left p-4 rounded-xl border transition-all ${
                    isSelected
                      ? 'border-indigo-500 bg-indigo-500/10 shadow-md ring-1 ring-indigo-500'
                      : 'border-neutral-800 bg-neutral-950/60 hover:bg-neutral-800/50'
                  }`}
                >
                  <span className="block text-sm font-bold text-white mb-1">{mode.title}</span>
                  <span className="block text-xs text-neutral-400">{mode.desc}</span>
                </button>
              );
            })}
          </div>
        </div>

        <div>
          <span className="block text-xs font-semibold uppercase tracking-wider text-neutral-400 mb-2">
            Minigame Selection Strategy
          </span>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            {strategies.map((strat) => {
              const isSelected = selectionStrategy === strat.id;
              return (
                <button
                  key={strat.id}
                  type="button"
                  onClick={() => setSelectionStrategy(strat.id)}
                  className={`text-left p-4 rounded-xl border transition-all ${
                    isSelected
                      ? 'border-teal-500 bg-teal-500/10 shadow-md ring-1 ring-teal-500'
                      : 'border-neutral-800 bg-neutral-950/60 hover:bg-neutral-800/50'
                  }`}
                >
                  <span className="block text-sm font-bold text-white mb-1">{strat.title}</span>
                  <span className="block text-xs text-neutral-400">{strat.desc}</span>
                </button>
              );
            })}
          </div>
        </div>
      </section>

      {/* Submit Button */}
      <div className="pt-2">
        <button
          type="submit"
          disabled={isLoading}
          className="w-full h-14 rounded-xl bg-gradient-to-r from-indigo-500 via-purple-500 to-pink-500 hover:opacity-95 text-white font-extrabold text-base uppercase tracking-wider shadow-lg shadow-indigo-500/25 flex items-center justify-center gap-2 transition-all disabled:opacity-50"
        >
          {isLoading ? (
            <span className="inline-flex items-center gap-2">
              <span className="animate-spin">⏳</span> Creating Party Room...
            </span>
          ) : (
            <>
              <span>🎉</span> Create Party Room & Launch Lobby
            </>
          )}
        </button>
      </div>
    </form>
  );
}
