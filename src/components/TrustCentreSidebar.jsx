'use client';
import React from 'react';
import { useTrustCore } from '../hooks/useTrustCore';

export default function TrustCentreSidebar({ startAuthentication }) {
  // Bind the SSE hook
  const { blocks, rollingSpend } = useTrustCore();
  const hardLimit = 100000;

  // Capacity Gauge Math
  const totalSegments = 32;
  const filledSegments = Math.round((rollingSpend / hardLimit) * totalSegments);
  const isDanger = rollingSpend / hardLimit > 0.9;

  return (
    <aside className="w-[360px] h-screen bg-zinc-950 border-l border-zinc-800 flex flex-col font-sans select-none antialiased">
      
      {/* 1. The Header (Security Status) */}
      <header className="flex-none px-5 py-4 border-b border-zinc-800 flex items-center justify-between bg-zinc-950 z-10 shadow-sm">
        <div className="flex items-center gap-3">
          <div className="relative flex items-center justify-center h-[6px] w-[6px]">
            <span className="absolute inline-flex h-[6px] w-[6px] rounded-full bg-emerald-500 opacity-75 animate-[ping_3s_ease-in-out_infinite]"></span>
            <span className="relative inline-flex rounded-full h-[6px] w-[6px] bg-emerald-500"></span>
          </div>
          <span className="text-[11px] font-medium text-zinc-400 uppercase tracking-widest">
            System Cryptographically Sealed
          </span>
        </div>
      </header>

      {/* 2. The Velocity Tracker (Financial Guardrail) */}
      <section className="flex-none px-5 py-6 border-b border-zinc-800 bg-zinc-950">
        <div className="flex justify-between items-baseline mb-4">
          <h2 className="text-[10px] font-semibold text-zinc-400 uppercase tracking-widest">
            Velocity Tracker
          </h2>
          <div className="text-right font-mono text-[13px] tracking-tight">
            <span className="text-white">₹{rollingSpend.toLocaleString('en-IN')}</span>
            <span className="text-zinc-500"> / ₹{hardLimit.toLocaleString('en-IN')}</span>
          </div>
        </div>
        
        {/* Micro-Segmented Capacity Gauge */}
        <div className="flex gap-[2px] h-[6px] w-full">
          {Array.from({ length: totalSegments }).map((_, i) => (
            <div 
              key={i} 
              className={`flex-1 rounded-[1px] transition-colors duration-300 ${
                i < filledSegments 
                  ? isDanger ? 'bg-amber-500' : 'bg-cyan-600'
                  : 'bg-zinc-800/40'
              }`} 
            />
          ))}
        </div>
        
        <div className="flex justify-between mt-3">
          <span className="text-[10px] font-medium text-zinc-500 uppercase tracking-wider">
            Rolling Window Spend
          </span>
          <span className="text-[10px] font-medium text-zinc-500 uppercase tracking-wider">
            Hard Limit
          </span>
        </div>
      </section>

      {/* 3. The Immutable Audit Ledger (The Hash Chain) */}
      <section className="flex-1 overflow-y-auto p-5 bg-zinc-950 [&::-webkit-scrollbar]:w-1 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:bg-zinc-800 [&::-webkit-scrollbar-thumb]:rounded-full">
        <div className="flex flex-col gap-4">
          {blocks.map((block) => {
            // Data mapping based on backend SQLite structure
            const isAlert = block.event_type === 'GUARDRAIL_DECISION' && block.payload?.outcome === 'FAIL';
            const statusLabel = isAlert ? 'Biometric Step-Up' : 'Verified';
            const intentText = block.payload?.intent || block.event_type;
            const hashId = block.hash || "0x0000000000000000000000000000000000000000000000000000000000000000";

            return (
              <div 
                key={block.seq || hashId} 
                className="flex flex-col bg-zinc-950 border border-zinc-800 rounded-md p-4 shadow-sm"
              >
                {/* Block Header */}
                <div className="flex justify-between items-start mb-4">
                  <span className="text-[10px] uppercase text-zinc-500 font-mono tracking-wider mt-0.5">
                    {block.timestamp || "PENDING_TS"}
                  </span>
                  <span className={`px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide rounded-sm ${
                    !isAlert 
                      ? 'bg-emerald-500/10 text-emerald-400' 
                      : 'bg-amber-500/10 text-amber-400'
                  }`}>
                    {statusLabel}
                  </span>
                </div>
                
                {/* Center: Action Intent */}
                <div className="text-[13px] text-white font-mono mb-4 tracking-tight">
                  {intentText}
                </div>
                
                {/* Bottom: SHA-256 JCS Hash */}
                <div className="bg-zinc-900 rounded-sm p-1.5 border border-zinc-800/50 flex items-center justify-between">
                  <span className="font-mono text-[10px] text-zinc-400 tracking-wider">
                    0x{hashId.slice(0, 6)}...{hashId.slice(-4)}
                  </span>
                  <span className="font-mono text-[9px] text-zinc-600 uppercase tracking-widest">
                    SHA-256 JCS
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {/* ISOLATION DIRECTIVE: Biometric trigger decoupled from the SSE render cycle */}
      <section className="flex-none p-5 border-t border-zinc-800 bg-zinc-950">
         <button 
           onClick={startAuthentication}
           className="w-full py-2.5 bg-amber-500/10 text-amber-400 border border-amber-500/20 rounded-md font-mono text-[11px] uppercase tracking-widest hover:bg-amber-500/20 transition-colors"
         >
           Trigger Biometric Step-Up
         </button>
      </section>
      
    </aside>
  );
}
