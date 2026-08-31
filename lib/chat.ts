"use client";

import { useState, useRef, useCallback } from "react";
import { FEED_TYPES, type AuditEntry } from "@/lib/audit";
import { useAudit } from "@/components/providers/audit-provider";
import { useSession } from "@/components/providers/session-provider";

// Re-exported so chat-surface components (message list, receipt card) get their
// clock formatter from one place alongside the chat types.
export { formatClock } from "@/lib/audit";

/**
 * useChat — React port of public/js/chat.js submit().
 *
 * On send it fires POST /chat (messages history + provider + budget) AND, in
 * parallel, a streamed POST /chat/thinking (dedicated fast narration) whose
 * deltas type into the live thinking bar as they arrive — so the reasoning lands
 * while the work happens, not after. When the turn settles the bar collapses and
 * mirrors this turn's real audit blocks as a concrete step timeline.
 *
 * Everything shown is real: receipts and audit blocks come only from the server.
 * If the server is unreachable the turn fails honestly with a short notice — no
 * stub purchases, no fabricated receipts.
 */

// Real commerce prompts (chat.js EXAMPLES) — the quick-action chips.
export const EXAMPLES = [
  "Buy a mechanical keyboard under ₹8,000",
  "Order groceries for the week",
  "Compare two wireless earbuds",
  "What can you do?",
];

export interface ReceiptData {
  status?: string;
  merchantName?: string;
  orderId?: string;
  items?: { name?: string; price?: number }[];
  subtotal?: number;
  tax?: number;
  total?: number;
  refId?: string;
  timestamp?: number | string;
}

export type TranscriptItem =
  | { kind: "user"; id: string; content: string; timestamp: number }
  | { kind: "agent"; id: string; content: string; timestamp?: number }
  | { kind: "receipt"; id: string; data: ReceiptData; timestamp?: number }
  | { kind: "thinking"; id: string; text: string; steps: AuditEntry[]; live: boolean };

interface HistoryMessage {
  role: "user";
  content: string;
}

// Server /chat response items.
interface ServerMessage {
  role?: string;
  content?: string;
  message?: string;
  data?: ReceiptData;
  receipt?: ReceiptData;
  timestamp?: number | string;
}

// Shown only when the agent server can't be reached — never a fabricated receipt.
function offlineNotice(): ServerMessage[] {
  return [
    {
      role: "agent",
      timestamp: Date.now(),
      content:
        "I can't reach the agent server right now, so I can't run this. Start it with `npm start` and try again — every step is recorded to the tamper-evident audit chain.",
    },
  ];
}

export interface UseChat {
  transcript: TranscriptItem[];
  locked: boolean;
  send: (text: string) => void;
}

export function useChat(): UseChat {
  const audit = useAudit();
  const session = useSession();
  const [transcript, setTranscript] = useState<TranscriptItem[]>([]);
  const [locked, setLocked] = useState(false);

  // Only user turns are sent to the server (matches chat.js chatHistory).
  const historyRef = useRef<HistoryMessage[]>([]);
  const lockedRef = useRef(false);
  const idRef = useRef(0);
  const nextId = () => "m" + ++idRef.current;

  // Append a streamed delta to the live thinking bar (by id). textContent-style
  // plain text — model output stays inert.
  const appendNarration = useCallback((id: string, delta: string) => {
    setTranscript((prev) =>
      prev.map((it) => (it.kind === "thinking" && it.id === id ? { ...it, text: it.text + delta } : it))
    );
  }, []);

  // Open the parallel narration stream and pump deltas until the server closes it
  // (or the turn settles first and aborts us). Never throws: offline / no-key /
  // abort just leaves whatever text already streamed in.
  const streamThinking = useCallback(
    async (id: string, payload: unknown, signal: AbortSignal) => {
      try {
        const res = await fetch("/chat/thinking", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
          signal,
        });
        if (!res.ok || !res.body || !res.body.getReader) return;
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          const delta = decoder.decode(chunk.value, { stream: true });
          if (delta) appendNarration(id, delta);
        }
      } catch {
        /* aborted on finalize, or offline — keep whatever streamed */
      }
    },
    [appendNarration]
  );

  const send = useCallback(
    async (rawText: string) => {
      if (lockedRef.current) return;
      const text = (rawText || "").trim();
      if (!text) return;
      const provider = session.provider;
      const budget = session.budget;

      const thinkingId = nextId();
      const userItem: TranscriptItem = { kind: "user", id: nextId(), content: text, timestamp: Date.now() };
      const thinkingItem: TranscriptItem = { kind: "thinking", id: thinkingId, text: "", steps: [], live: true };

      historyRef.current.push({ role: "user", content: text });
      setTranscript((prev) => [...prev, userItem, thinkingItem]);
      lockedRef.current = true;
      setLocked(true);

      // Watermark the chain before the turn so we can later pull exactly the
      // blocks this turn appends into the thinking timeline.
      const startSeq = audit.maxSeq();

      const abort = new AbortController();
      const messagesForServer = historyRef.current.slice();
      const thinkingStream = streamThinking(thinkingId, { messages: messagesForServer, budget }, abort.signal);

      let messages: ServerMessage[];
      try {
        const res = await fetch("/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ messages: messagesForServer, provider, budget }),
        });
        if (!res.ok) throw new Error("chat HTTP " + res.status);
        const parsed = await res.json();
        messages = Array.isArray(parsed) ? parsed : [parsed];
        await audit.refresh(); // pull the blocks the server just appended (Trust drawer)
      } catch {
        // Server unreachable: fail honestly — never fabricate a receipt.
        messages = offlineNotice();
      }

      // The turn has settled — stop the live narration so reasoning always stays
      // temporally ahead of the answer, never trailing it.
      abort.abort();
      try {
        await thinkingStream;
      } catch {
        /* aborted */
      }

      // Mirror this turn's real audit events into the thinking disclosure.
      const fresh = audit
        .getEntries()
        .filter((e) => e && typeof e.seq === "number" && e.seq > startSeq && FEED_TYPES.has(e.event_type));

      const appended: TranscriptItem[] = [];
      let budgetDelta = 0;
      messages.forEach((m) => {
        if (!m) return;
        if (m.role === "receipt") {
          const data = (m.data || m.receipt || {}) as ReceiptData;
          appended.push({ kind: "receipt", id: nextId(), data, timestamp: toMs(m.timestamp) });
          if (data.status === "confirmed" && typeof data.total === "number") budgetDelta += data.total;
        } else {
          appended.push({
            kind: "agent",
            id: nextId(),
            content: m.content || m.message || "",
            timestamp: toMs(m.timestamp),
          });
        }
      });

      // Finalize the thinking bar: collapse it; drop it only when nothing landed
      // at all (no streamed reasoning and no real audit step).
      setTranscript((prev) => {
        const next = prev
          .map((it): TranscriptItem | null => {
            if (it.kind !== "thinking" || it.id !== thinkingId) return it;
            const hasText = !!it.text && !!it.text.trim();
            if (!hasText && fresh.length === 0) return null; // remove empty bar
            return { ...it, live: false, steps: fresh };
          })
          .filter((it): it is TranscriptItem => it !== null);
        return [...next, ...appended];
      });

      if (budgetDelta > 0) session.setBudget((b) => Math.max(0, b - budgetDelta));

      lockedRef.current = false;
      setLocked(false);
    },
    [audit, session, streamThinking]
  );

  return { transcript, locked, send };
}

function toMs(ts: number | string | undefined): number | undefined {
  if (ts == null) return undefined;
  if (typeof ts === "number") return ts;
  const n = Date.parse(ts);
  return isNaN(n) ? undefined : n;
}
