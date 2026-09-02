'use client';
import { useState, useEffect } from 'react';

export function useTrustCore() {
  const [blocks, setBlocks] = useState([]);
  const [rollingSpend, setRollingSpend] = useState(0);

  useEffect(() => {
    // 1. Fetch initial ledger state and rolling spend on mount
    async function fetchInitialState() {
      try {
        const [auditRes, velocityRes] = await Promise.all([
          fetch('/audit-log'),
          fetch('/api/v1/ledger/velocity')
        ]);
        
        if (auditRes.ok) {
          const data = await auditRes.json();
          // Reverse so newest blocks are at the top
          if (data.entries) setBlocks(data.entries.reverse());
        }
        
        if (velocityRes.ok) {
          const data = await velocityRes.json();
          setRollingSpend(data.rollingSpend || 0);
        }
      } catch (err) {
        console.error('TrustCore Initialization Error:', err);
      }
    }
    
    fetchInitialState();

    // 2. Establish SSE connection for real-time audit updates
    const eventSource = new EventSource('/api/v1/ledger/stream');

    eventSource.onmessage = (event) => {
      try {
        const newBlock = JSON.parse(event.data);
        // Prepend the new block so the ledger scrolls top-down
        setBlocks((prev) => [newBlock, ...prev]);
      } catch (err) {
        console.error('Failed to parse incoming audit block:', err);
      }
    };

    eventSource.onerror = (err) => {
      console.error('TrustCore SSE Error:', err);
    };

    // 3. Cleanup to prevent connection memory leaks on unmount
    return () => {
      eventSource.close();
    };
  }, []);

  return { blocks, rollingSpend };
}
