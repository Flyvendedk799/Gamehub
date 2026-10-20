'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { type ChangeEvent, type FormEvent, useEffect, useState } from 'react';
import { listPartyDirectory } from '../../lib/party/party-api';
import { type PartyRoomSummary, normalizeRoomCode } from '../../lib/party/party-types';

export default function PartyLandingPage() {
  const router = useRouter();
  const [roomCodeInput, setRoomCodeInput] = useState('');
  const [rooms, setRooms] = useState<PartyRoomSummary[]>([]);
  const [totalRooms, setTotalRooms] = useState(0);
  const [currentPage, setCurrentPage] = useState(1);
  const [isLoadingDirectory, setIsLoadingDirectory] = useState(true);
  const [searchFilter, setSearchFilter] = useState('');
  const [joinError, setJoinError] = useState<string | null>(null);

  const PAGE_SIZE = 10;

  // Fetch discoverable public rooms
  useEffect(() => {
    let isCancelled = false;
    async function loadDirectory() {
      setIsLoadingDirectory(true);
      try {
        const res = await listPartyDirectory(currentPage, PAGE_SIZE);
        if (!isCancelled) {
          setRooms(res.rooms || []);
          setTotalRooms(res.totalRooms || 0);
        }
      } catch {
        if (!isCancelled) {
          setRooms([]);
        }
      } finally {
        if (!isCancelled) {
          setIsLoadingDirectory(false);
        }
      }
    }
    loadDirectory();
    return () => {
      isCancelled = true;
    };
  }, [currentPage]);

  // Code input handler with Base32 normalization
  const handleCodeChange = (e: ChangeEvent<HTMLInputElement>) => {
    const raw = e.target.value;
    const normalized = normalizeRoomCode(raw);
    setRoomCodeInput(normalized);
    setJoinError(null);
  };

  const handleJoinByCode = (e: FormEvent) => {
    e.preventDefault();
    if (roomCodeInput.length !== 6) {
      setJoinError('Room code must be exactly 6 characters');
      return;
    }
    router.push(`/party/${roomCodeInput}`);
  };

  // Filtered rooms
  const filteredRooms = rooms.filter((r) => {
    if (!searchFilter.trim()) return true;
    const term = searchFilter.toLowerCase();
    return r.title.toLowerCase().includes(term) || r.roomCode.toLowerCase().includes(term);
  });

  const totalPages = Math.ceil(totalRooms / PAGE_SIZE) || 1;

  return (
    <main className="min-h-screen bg-void text-white p-4 sm:p-8 lg:p-12">
      <div className="max-w-6xl mx-auto space-y-12">
        {/* Hero Section */}
        <div className="text-center space-y-4 pt-4 sm:pt-8">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-indigo-500/10 border border-indigo-500/20 text-indigo-400 text-xs sm:text-sm font-semibold">
            <span>🎉</span> Gamehub Real-Time Party Mode
          </div>
          <h1 className="text-4xl sm:text-6xl xl:text-7xl font-black tracking-tight text-white">
            Play Together in{' '}
            <span className="text-transparent bg-clip-text bg-gradient-to-r from-indigo-400 via-purple-400 to-pink-400">
              Real-Time
            </span>
          </h1>
          <p className="text-sm sm:text-base lg:text-lg text-neutral-400 max-w-2xl mx-auto leading-relaxed">
            Host or join party lobbies with friend groups, vote on rotating minigames, drop live
            emoji combos, sound bites, and celebrate on the 3D winner&apos;s podium!
          </p>
        </div>

        {/* Quick Join & Create Action Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 max-w-4xl mx-auto">
          {/* Enter Room Code Card */}
          <div className="p-6 sm:p-8 rounded-3xl bg-neutral-900/90 border border-neutral-800 shadow-2xl flex flex-col justify-between space-y-4">
            <div>
              <span className="text-xs font-mono font-bold uppercase tracking-wider text-indigo-400">
                Join Existing Match
              </span>
              <h2 className="text-2xl font-black text-white mt-1">Enter Room Code</h2>
              <p className="text-xs text-neutral-400 mt-1">
                Type the 6-character room code from your party host.
              </p>
            </div>

            <form onSubmit={handleJoinByCode} className="space-y-3">
              <div className="relative">
                <input
                  type="text"
                  value={roomCodeInput}
                  onChange={handleCodeChange}
                  placeholder="e.g. 234567"
                  maxLength={6}
                  className="w-full h-14 px-4 text-center text-2xl sm:text-3xl font-mono font-black tracking-widest uppercase bg-neutral-950 border border-neutral-700 rounded-2xl text-white placeholder-neutral-600 focus:outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500 transition-all select-all"
                  aria-label="6-character room code"
                />
              </div>

              {joinError && (
                <p className="text-xs text-rose-400 font-medium" role="alert">
                  {joinError}
                </p>
              )}

              <button
                type="submit"
                disabled={roomCodeInput.length !== 6}
                className="w-full h-12 rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 text-white font-extrabold text-sm uppercase tracking-wider transition-all shadow-lg shadow-indigo-600/20 flex items-center justify-center gap-2"
              >
                <span>🚀</span> Join Party Room
              </button>
            </form>
          </div>

          {/* Create Party Room Card */}
          <div className="p-6 sm:p-8 rounded-3xl bg-gradient-to-br from-indigo-950/40 via-neutral-900 to-purple-950/40 border border-indigo-500/30 shadow-2xl flex flex-col justify-between space-y-4">
            <div>
              <span className="text-xs font-mono font-bold uppercase tracking-wider text-pink-400">
                Start Something Big
              </span>
              <h2 className="text-2xl font-black text-white mt-1">Host a New Party</h2>
              <p className="text-xs text-neutral-400 mt-1">
                Create a custom lobby, pick playlist format (Best of 3, Best of 5, Gauntlet), and
                invite your crew with QR codes.
              </p>
            </div>

            <div className="space-y-3 pt-2">
              <div className="flex items-center gap-2 text-xs text-neutral-300 font-medium">
                <span>✓</span> Scannable SVG QR codes for instant mobile phone entry
              </div>
              <div className="flex items-center gap-2 text-xs text-neutral-300 font-medium">
                <span>✓</span> Democratic game voting &amp; 1-time tournament vetoes
              </div>
              <div className="flex items-center gap-2 text-xs text-neutral-300 font-medium">
                <span>✓</span> Grand Prix scoring &amp; 3D victory podium with confetti
              </div>

              <Link
                href="/party/create"
                className="w-full h-12 rounded-xl bg-gradient-to-r from-pink-500 via-purple-500 to-indigo-500 hover:opacity-95 text-white font-extrabold text-sm uppercase tracking-wider transition-all shadow-xl shadow-pink-500/25 flex items-center justify-center gap-2"
              >
                <span>✨</span> Create Party Room
              </Link>
            </div>
          </div>
        </div>

        {/* Discoverable Public Rooms Directory */}
        <section className="space-y-4 pt-6">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div>
              <h2 className="text-xl sm:text-2xl font-black text-white flex items-center gap-2">
                <span>🌐</span> Public Party Directory
              </h2>
              <p className="text-xs text-neutral-400 mt-0.5">
                Browse open lobbies looking for players
              </p>
            </div>

            {/* Directory search input */}
            <div className="w-full sm:w-64">
              <input
                type="text"
                value={searchFilter}
                onChange={(e) => setSearchFilter(e.target.value)}
                placeholder="Search rooms..."
                className="w-full h-10 px-3 bg-neutral-900 border border-neutral-800 rounded-xl text-xs text-white placeholder-neutral-500 focus:outline-none focus:border-indigo-500"
              />
            </div>
          </div>

          {isLoadingDirectory ? (
            <div className="text-center py-12 text-neutral-400 text-sm">
              <span className="animate-spin inline-block mr-2">⏳</span> Loading public party
              directory...
            </div>
          ) : filteredRooms.length === 0 ? (
            <div className="text-center py-12 bg-neutral-900/40 border border-neutral-800/80 rounded-2xl p-6 text-neutral-400 text-sm space-y-2">
              <p>No public parties matching your search right now.</p>
              <Link
                href="/party/create"
                className="inline-block text-xs text-indigo-400 font-bold hover:underline"
              >
                Create the first party room! →
              </Link>
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {filteredRooms.map((room) => {
                const isFull = room.memberCount >= room.maxPlayers;
                const canJoin = !isFull || room.allowSpectators;

                return (
                  <div
                    key={room.roomId}
                    className="p-5 rounded-2xl bg-neutral-900/90 border border-neutral-800 hover:border-neutral-700 transition-all flex flex-col justify-between space-y-4 shadow-lg"
                  >
                    <div>
                      <div className="flex items-center justify-between gap-2 mb-1.5">
                        <span className="font-mono text-xs font-black px-2 py-0.5 rounded bg-neutral-950 border border-neutral-800 text-amber-400">
                          {room.roomCode}
                        </span>
                        <span
                          className={`text-[10px] font-bold uppercase px-2 py-0.5 rounded-full ${
                            room.state === 'LOBBY'
                              ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30'
                              : 'bg-indigo-500/20 text-indigo-300 border border-indigo-500/30'
                          }`}
                        >
                          {room.state}
                        </span>
                      </div>
                      <h3 className="font-extrabold text-white text-base truncate">{room.title}</h3>
                      <p className="text-xs text-neutral-400 mt-0.5">
                        Format:{' '}
                        <strong className="text-neutral-300">
                          {room.playlistMode.replace(/_/g, ' ')}
                        </strong>
                      </p>
                    </div>

                    <div className="flex items-center justify-between pt-3 border-t border-neutral-800/80">
                      <span className="text-xs font-mono text-neutral-400 flex items-center gap-1">
                        <span>👥</span> {room.memberCount}/{room.maxPlayers}
                        {isFull && room.allowSpectators && (
                          <span className="text-[10px] text-sky-400">(Spectate)</span>
                        )}
                      </span>

                      <Link
                        href={`/party/${room.roomCode}`}
                        className={`px-4 py-1.5 rounded-xl text-xs font-bold transition-colors ${
                          canJoin
                            ? 'bg-indigo-600 hover:bg-indigo-500 text-white'
                            : 'bg-neutral-800 text-neutral-500 cursor-not-allowed'
                        }`}
                      >
                        {isFull ? 'Spectate' : 'Join'}
                      </Link>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* Pagination Controls */}
          {totalPages > 1 && (
            <div className="flex items-center justify-center gap-3 pt-4">
              <button
                type="button"
                disabled={currentPage <= 1}
                onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                className="px-4 py-2 rounded-xl bg-neutral-900 border border-neutral-800 text-xs font-semibold text-neutral-300 hover:text-white disabled:opacity-40 transition-colors"
              >
                ← Previous
              </button>
              <span className="text-xs font-mono text-neutral-400">
                Page {currentPage} of {totalPages}
              </span>
              <button
                type="button"
                disabled={currentPage >= totalPages}
                onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
                className="px-4 py-2 rounded-xl bg-neutral-900 border border-neutral-800 text-xs font-semibold text-neutral-300 hover:text-white disabled:opacity-40 transition-colors"
              >
                Next →
              </button>
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
