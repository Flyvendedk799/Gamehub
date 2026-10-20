'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { type FormEvent, useEffect, useState } from 'react';
import { PartyGameOverlay } from '../../../components/party/hud/PartyGameOverlay';
import { RoundOverStage } from '../../../components/party/intermission/RoundOverStage';
import { PartyActionBar } from '../../../components/party/lobby/PartyActionBar';
import { PartyAvatarPicker } from '../../../components/party/lobby/PartyAvatarPicker';
import { PartyLobbyHeader } from '../../../components/party/lobby/PartyLobbyHeader';
import { PartyNameInput } from '../../../components/party/lobby/PartyNameInput';
import { PartyPlayerGrid } from '../../../components/party/lobby/PartyPlayerGrid';
import { SpectatorTray } from '../../../components/party/lobby/SpectatorTray';
import { PodiumStage } from '../../../components/party/podium/PodiumStage';
import { GameVoteStage } from '../../../components/party/voting/GameVoteStage';
import { SynchronizedGameStartOverlay } from '../../../components/party/voting/SynchronizedGameStartOverlay';
import {
  type PartyRoomStatusResult,
  getPartyRoomStatus,
  joinPartyRoom,
} from '../../../lib/party/party-api';
import {
  PARTY_ACCENT_COLORS,
  PARTY_AVATARS,
  type PartySession,
  clearPartySession,
  getPartyProfile,
  getPartySession,
  normalizeRoomCode,
  savePartyProfile,
  savePartySession,
} from '../../../lib/party/party-types';
import { usePartySocket } from '../../../lib/party/use-party-socket';
import { usePartyAudio } from '../../../lib/party/usePartyAudio';

export interface PartyClientProps {
  roomCode: string;
}

export function PartyClient({ roomCode: rawCode }: PartyClientProps) {
  const router = useRouter();
  const roomCode = normalizeRoomCode(rawCode);

  const [session, setSession] = useState<PartySession | null>(null);
  const [initialLoading, setInitialLoading] = useState(true);
  const [roomStatus, setRoomStatus] = useState<PartyRoomStatusResult | null>(null);
  const [notFound, setNotFound] = useState(false);

  // Guest join modal state
  const savedProfile = getPartyProfile();
  const [guestName, setGuestName] = useState(savedProfile.displayName || 'Player');
  const [guestAvatarId, setGuestAvatarId] = useState(
    savedProfile.avatarId || PARTY_AVATARS[0]?.id || 'fox',
  );
  const [guestColor, setGuestColor] = useState(savedProfile.avatarColor || PARTY_ACCENT_COLORS[0]);
  const [rolePreference, setRolePreference] = useState<'PLAYER' | 'SPECTATOR'>('PLAYER');
  const [isJoining, setIsJoining] = useState(false);
  const [joinError, setJoinError] = useState<string | null>(null);

  // Initialize Audio
  const audio = usePartyAudio();

  // Load room status and existing session
  useEffect(() => {
    let isCancelled = false;

    async function checkRoomAndSession() {
      setInitialLoading(true);
      try {
        const status = await getPartyRoomStatus(roomCode);
        if (isCancelled) return;
        setRoomStatus(status);

        // Check if device holds an existing session
        const existingSession = getPartySession(roomCode);
        if (existingSession) {
          setSession(existingSession);
        }
      } catch (err: unknown) {
        if (!isCancelled) {
          setNotFound(true);
        }
      } finally {
        if (!isCancelled) {
          setInitialLoading(false);
        }
      }
    }

    if (roomCode) {
      checkRoomAndSession();
    } else {
      setNotFound(true);
      setInitialLoading(false);
    }

    return () => {
      isCancelled = true;
    };
  }, [roomCode]);

  // Connect WebSocket
  const {
    room,
    currentMember,
    members,
    pingMs,
    votingRemainingSec,
    countdownValue,
    activeMinigameId,
    chatMessages,
    floatingReactions,
    comboBlastActive,
    disconnectedMembersInGrace,
    errorMessage,
    setReady,
    castVote,
    triggerVeto,
    sendEmoji,
    sendSound,
    sendChat,
    startMatch,
    skipIntermission,
    requestRematch,
    kickPlayer,
    leaveRoom,
  } = usePartySocket({
    session,
  });

  // Handle guest join submission
  const handleJoinSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!guestName.trim()) {
      setJoinError('Please enter your player handle');
      return;
    }

    setIsJoining(true);
    setJoinError(null);

    try {
      savePartyProfile({
        displayName: guestName.trim(),
        avatarId: guestAvatarId,
        avatarColor: guestColor,
      });

      const res = await joinPartyRoom(roomCode, {
        displayName: guestName.trim(),
        avatarId: guestAvatarId,
        avatarColor: guestColor,
        rolePreference,
      });

      const newSession: PartySession = {
        roomId: res.room.roomId,
        roomCode: res.room.roomCode,
        memberId: res.memberId,
        sessionToken: res.sessionToken,
        isHost: res.room.members[res.memberId]?.isHost ?? false,
      };

      savePartySession(newSession);
      setSession(newSession);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Could not join room';
      setJoinError(msg);
    } finally {
      setIsJoining(false);
    }
  };

  const handleLeave = () => {
    leaveRoom();
    clearPartySession(roomCode);
    setSession(null);
    router.push('/party');
  };

  // Sync session isHost with authoritative server state
  useEffect(() => {
    if (currentMember && session && currentMember.isHost !== session.isHost) {
      const updatedSession: PartySession = { ...session, isHost: currentMember.isHost };
      savePartySession(updatedSession);
      setSession(updatedSession);
    }
  }, [currentMember, session]);

  // 1. Loading State
  if (initialLoading) {
    return (
      <main className="min-h-screen bg-void text-white flex items-center justify-center p-4">
        <div className="text-center space-y-3">
          <div className="w-12 h-12 border-4 border-indigo-500 border-t-transparent rounded-full animate-spin mx-auto" />
          <p className="text-sm font-mono text-neutral-400">Resolving party room {roomCode}...</p>
        </div>
      </main>
    );
  }

  // 2. Room Not Found
  if (notFound || !roomStatus) {
    return (
      <main className="min-h-screen bg-void text-white flex items-center justify-center p-4">
        <div className="max-w-md w-full bg-neutral-900 border border-neutral-800 rounded-3xl p-8 text-center space-y-4 shadow-2xl">
          <div className="w-16 h-16 rounded-2xl bg-rose-500/10 border border-rose-500/20 text-3xl flex items-center justify-center mx-auto text-rose-400">
            🔍
          </div>
          <h1 className="text-2xl font-black text-white">Party Room Not Found</h1>
          <p className="text-xs sm:text-sm text-neutral-400">
            Room <span className="font-mono font-bold text-amber-400">{roomCode}</span> does not
            exist or has expired.
          </p>
          <div className="pt-2">
            <Link
              href="/party"
              className="inline-flex items-center justify-center h-12 px-6 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white font-bold text-sm transition-colors"
            >
              Browse Party Directory
            </Link>
          </div>
        </div>
      </main>
    );
  }

  // 3. Guest Join Modal (if not joined yet)
  if (!session) {
    const isFull = roomStatus.memberCount >= roomStatus.maxPlayers;
    const canSpectate = roomStatus.allowSpectators;

    return (
      <main className="min-h-screen bg-void text-white flex items-center justify-center p-4 sm:p-6">
        <div className="max-w-xl w-full bg-neutral-900/95 border border-neutral-800 rounded-3xl p-6 sm:p-8 shadow-2xl space-y-6">
          <div className="text-center space-y-1">
            <span className="text-xs font-mono uppercase tracking-widest text-indigo-400 font-bold">
              Join Party Room
            </span>
            <h1 className="text-2xl sm:text-3xl font-black text-white tracking-tight">
              {roomStatus.title}
            </h1>
            <p className="text-xs text-neutral-400 font-mono">
              Room Code: <span className="font-bold text-amber-400">{roomStatus.roomCode}</span> •{' '}
              {roomStatus.memberCount}/{roomStatus.maxPlayers} Players
            </p>
          </div>

          {joinError && (
            <div
              role="alert"
              className="p-3.5 bg-rose-500/10 border border-rose-500/30 rounded-xl text-rose-300 text-xs font-semibold"
            >
              {joinError}
            </div>
          )}

          <form onSubmit={handleJoinSubmit} className="space-y-6">
            <PartyNameInput
              value={guestName}
              onChange={setGuestName}
              placeholder="Your player name..."
            />

            <PartyAvatarPicker
              selectedAvatarId={guestAvatarId}
              selectedColor={guestColor}
              onSelectAvatar={setGuestAvatarId}
              onSelectColor={setGuestColor}
            />

            {/* Role Preference (Player vs Spectator) */}
            <div className="space-y-2">
              <span className="block text-xs font-semibold uppercase tracking-wider text-neutral-400">
                Participation Mode
              </span>
              <div className="grid grid-cols-2 gap-3">
                <button
                  type="button"
                  disabled={isFull}
                  onClick={() => setRolePreference('PLAYER')}
                  className={`p-3 rounded-xl border text-left transition-all ${
                    rolePreference === 'PLAYER'
                      ? 'border-indigo-500 bg-indigo-500/10 text-white font-bold ring-1 ring-indigo-500'
                      : isFull
                        ? 'border-neutral-800 bg-neutral-950/40 text-neutral-600 cursor-not-allowed'
                        : 'border-neutral-800 bg-neutral-950/60 text-neutral-300 hover:bg-neutral-800/40'
                  }`}
                >
                  <span className="block text-xs font-bold">🎮 Active Player</span>
                  <span className="block text-[10px] text-neutral-400 mt-0.5">
                    {isFull ? 'Lobby is full' : 'Compete in games'}
                  </span>
                </button>

                <button
                  type="button"
                  disabled={!canSpectate}
                  onClick={() => setRolePreference('SPECTATOR')}
                  className={`p-3 rounded-xl border text-left transition-all ${
                    rolePreference === 'SPECTATOR'
                      ? 'border-indigo-500 bg-indigo-500/10 text-white font-bold ring-1 ring-indigo-500'
                      : !canSpectate
                        ? 'border-neutral-800 bg-neutral-950/40 text-neutral-600 cursor-not-allowed'
                        : 'border-neutral-800 bg-neutral-950/60 text-neutral-300 hover:bg-neutral-800/40'
                  }`}
                >
                  <span className="block text-xs font-bold">👁️ Spectator</span>
                  <span className="block text-[10px] text-neutral-400 mt-0.5">
                    {canSpectate ? 'Watch live & react' : 'Spectators disabled'}
                  </span>
                </button>
              </div>
            </div>

            <button
              type="submit"
              disabled={isJoining || (isFull && rolePreference === 'PLAYER')}
              className="w-full h-13 rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white font-extrabold text-sm uppercase tracking-wider shadow-lg shadow-indigo-600/30 transition-all flex items-center justify-center gap-2"
            >
              {isJoining ? (
                <span className="inline-flex items-center gap-2">
                  <span className="animate-spin">⏳</span> Joining Party...
                </span>
              ) : (
                <>
                  <span>🚀</span> Join Party Match
                </>
              )}
            </button>
          </form>
        </div>
      </main>
    );
  }

  // 4. In Party Room - Active FSM State Rendering
  const activeRoom = room;
  const isHost = currentMember ? Boolean(currentMember.isHost) : Boolean(session?.isHost);
  const spectators = members.filter((m) => m.role === 'SPECTATOR');
  const currentState = activeRoom?.state || 'LOBBY';

  return (
    <main className="min-h-screen bg-void text-white flex flex-col justify-between">
      {errorMessage && (
        <div
          role="alert"
          className="bg-rose-600 text-white p-3 text-xs font-bold text-center select-none"
        >
          {errorMessage}
        </div>
      )}

      {/* Countdown Tick Overlay */}
      {countdownValue !== null && (
        <SynchronizedGameStartOverlay
          countdownValue={countdownValue}
          gameTitle={activeMinigameId || 'Party Minigame'}
        />
      )}

      {/* FSM: 1. LOBBY */}
      {currentState === 'LOBBY' && activeRoom && (
        <div className="flex-1 flex flex-col max-w-5xl w-full mx-auto p-4 sm:p-6 space-y-6">
          <PartyLobbyHeader
            roomCode={activeRoom.roomCode}
            roomTitle={activeRoom.title}
            isHost={isHost}
            hostName={members.find((m) => m.id === activeRoom.hostId)?.displayName || 'Host'}
            playlistMode={activeRoom.playlist.mode}
            totalRounds={activeRoom.playlist.totalRounds}
          />

          <PartyPlayerGrid
            members={members}
            currentMemberId={currentMember?.id ?? null}
            isHost={isHost}
            maxPlayers={activeRoom.maxActivePlayers}
            onKickPlayer={kickPlayer}
          />

          <SpectatorTray spectators={spectators} />

          <PartyActionBar
            currentMember={currentMember}
            members={members}
            isHost={isHost}
            onToggleReady={setReady}
            onStartMatch={startMatch}
            onLeaveRoom={handleLeave}
          />
        </div>
      )}

      {/* FSM: 2. GAME_SELECT_VOTING */}
      {currentState === 'GAME_SELECT_VOTING' && activeRoom?.votingState && (
        <GameVoteStage
          votingState={activeRoom.votingState}
          remainingSec={votingRemainingSec}
          members={members}
          currentMember={currentMember}
          onCastVote={castVote}
          onTriggerVeto={triggerVeto}
        />
      )}

      {/* FSM: 3. IN_GAME or COUNTDOWN */}
      {(currentState === 'IN_GAME' || (currentState === 'COUNTDOWN' && activeMinigameId)) &&
        activeRoom && (
          <PartyGameOverlay
            room={activeRoom}
            currentMember={currentMember}
            members={members}
            pingMs={pingMs}
            activeMinigameId={activeMinigameId}
            volume={audio.volume}
            isMuted={audio.isMuted}
            canPlaySound={audio.canPlaySound}
            cooldownRemainingMs={audio.cooldownRemainingMs}
            reactions={floatingReactions}
            comboBlastActive={comboBlastActive}
            chatMessages={chatMessages}
            disconnectedMembers={disconnectedMembersInGrace}
            onVolumeChange={audio.setVolume}
            onToggleMute={audio.toggleMute}
            onPlaySound={sendSound}
            onSendEmoji={sendEmoji}
            onSendChat={sendChat}
            onTriggerVeto={triggerVeto}
          />
        )}

      {/* FSM: 4. ROUND_OVER */}
      {currentState === 'ROUND_OVER' && activeRoom && (
        <RoundOverStage
          room={activeRoom}
          members={members}
          currentMember={currentMember}
          isHost={isHost}
          onSkipIntermission={skipIntermission}
        />
      )}

      {/* FSM: 5. PODIUM_CELEBRATION */}
      {currentState === 'PODIUM_CELEBRATION' && activeRoom?.podiumState && (
        <PodiumStage
          roomCode={activeRoom.roomCode}
          roomTitle={activeRoom.title}
          podiumState={activeRoom.podiumState}
          isHost={isHost}
          onRematch={requestRematch}
          onReturnToLobby={isHost ? requestRematch : handleLeave}
        />
      )}
    </main>
  );
}
