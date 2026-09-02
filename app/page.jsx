'use client';
import TrustCentreSidebar from '../src/components/TrustCentreSidebar';

export default function Page() {
  return (
    <main className="flex h-screen w-full bg-zinc-950">
      <div className="flex-1 flex items-center justify-center text-zinc-500 font-mono text-sm">
        [Main Content Area]
      </div>
      <TrustCentreSidebar startAuthentication={() => alert('Biometric Step-Up Triggered!')} />
    </main>
  );
}
