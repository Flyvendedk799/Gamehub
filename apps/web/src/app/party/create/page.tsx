'use client';

import { RoomCreationForm } from '../../../components/party/lobby/RoomCreationForm';

export default function CreatePartyPage() {
  return (
    <main className="min-h-screen bg-void text-white p-4 sm:p-8 lg:p-12">
      <div className="max-w-4xl mx-auto space-y-8">
        {/* Navigation Breadcrumb */}
        <div className="flex items-center gap-2 text-xs font-mono text-neutral-400">
          <a href="/party" className="hover:text-white transition-colors">
            ← Back to Party Directory
          </a>
        </div>

        {/* Header */}
        <div className="text-center sm:text-left space-y-2">
          <span className="text-xs font-mono uppercase tracking-widest text-indigo-400 font-bold">
            Host Match Configurator
          </span>
          <h1 className="text-3xl sm:text-4xl font-black text-white tracking-tight">
            Create Party Room
          </h1>
          <p className="text-xs sm:text-sm text-neutral-400 max-w-xl">
            Configure match format, player limits, and your host identity. Your lobby will be ready
            to accept players immediately.
          </p>
        </div>

        {/* Configurator Form */}
        <RoomCreationForm />
      </div>
    </main>
  );
}
