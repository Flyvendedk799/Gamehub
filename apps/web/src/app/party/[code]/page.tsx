import type { Metadata } from 'next';
import React from 'react';
import { PartyClient } from './party-client';

export interface PartyRoomPageProps {
  params: {
    code: string;
  };
}

export function generateMetadata({ params }: PartyRoomPageProps): Metadata {
  const code = params.code?.toUpperCase() || '';
  return {
    title: `Party Room ${code} | Gamehub Party Mode`,
    description: `Join real-time party room ${code} on Gamehub. Vote on games, compete with friends, and reach the victory podium!`,
  };
}

export default function PartyRoomPage({ params }: PartyRoomPageProps) {
  return <PartyClient roomCode={params.code} />;
}
