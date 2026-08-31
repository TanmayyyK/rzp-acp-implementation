/**
 * lib/audit.ts — pure port of the vanilla dashboard's store.js helpers.
 *
 * Framework-agnostic (no DOM, no React): money math, id/label extraction, human
 * narration, the shared stroke-icon set, and the tone→color mapping. The React
 * AuditProvider (poller) and the Trust Center / thinking bar / receipt components
 * all consume these so the Next UI narrates the real audit chain identically to
 * public/js/*.
 *
 * Everything here is derived from the server's real audit entries; nothing is
 * fabricated. Kept a faithful 1:1 port so the two front ends never diverge.
 */

// ─── Types ───────────────────────────────────────────────────────────────────
export type Tone = "trust" | "pending" | "broken" | "info" | "neutral";

// Payloads are heterogeneous by source (stub /chat vs checkout/orders/webhook
// taps), so payload access stays loosely typed — matching the dynamic original.
export type Payload = Record<string, any>;

export interface AuditEntry {
  seq: number;
  event_type: string;
  timestamp?: string;
  hash?: string;
  prev_hash?: string;
  session_id?: string;
  entry_id?: string;
  actor?: string;
  payload?: Payload;
}

export interface Integrity {
  valid: boolean | null;
  brokenAt: number | null;
}

export interface AuditSnapshot {
  entries: AuditEntry[];
  integrity: Integrity;
  connected: boolean;
  offline: boolean;
}

export interface FeedView {
  label: string;
  tone: Tone;
  amountPaise: number | null;
}

export interface Narration {
  title: string;
  detail: string;
  tone: Tone;
  icon: IconName;
}

// ─── Constants ─────────────────────────────────────────────────────────────
export const GENESIS_PREV_HASH = "0".repeat(64);

// The transaction-relevant subset the Activity timeline narrates. Raw genesis
// and low-level state transitions still appear in the Hash Chain view.
export const FEED_TYPES: ReadonlySet<string> = new Set([
  "AGENT_REASONING",
  "TOOL_CALL",
  "MANDATE_ISSUED",
  "MANDATE_VERIFIED",
  "GUARDRAIL_DECISION",
  "MONEY_ACTION",
  "WEBHOOK_RECEIVED",
  "FAILURE",
]);

// ─── Formatting ──────────────────────────────────────────────────────────────
export function formatPaise(paise: number): string {
  return (
    "₹" +
    (paise / 100).toLocaleString("en-IN", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })
  );
}

export function formatRupees(rupees: number): string {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
  }).format(rupees || 0);
}

export function truncateHash(hash: string | undefined | null): string {
  if (!hash) return "";
  if (hash === "GENESIS") return hash;
  if (hash.length <= 14) return hash;
  return hash.slice(0, 8) + "…" + hash.slice(-4);
}

// Short wall-clock stamp for chat bubbles / receipts (matches chat.js formatTime).
export function formatClock(ts: number | string | undefined): string {
  return new Date(ts || Date.now()).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

// ─── Money / id extraction ───────────────────────────────────────────────────
// MONEY_ACTION payloads vary by source (stub /chat uses amount_rupees; the
// checkout/orders taps use amount_paise), so accept either.
export function amountPaiseOf(payload: Payload | null | undefined): number | null {
  if (!payload || typeof payload !== "object") return null;
  if (typeof payload.amount_paise === "number") return payload.amount_paise;
  if (typeof payload.amount_rupees === "number") return Math.round(payload.amount_rupees * 100);
  return null;
}

export function idOf(entry: AuditEntry): string {
  const p: Payload = entry.payload || {};
  return (
    p.order_id ||
    p.razorpay_order_id ||
    p.receipt ||
    p.payment_link_id ||
    p.id ||
    entry.session_id ||
    entry.entry_id ||
    ""
  );
}

// ─── View mapping: an entry → { label, tone, amountPaise } ────────────────────
// tone ∈ trust | pending | broken | info | neutral (drives the accent color).
export function feedView(entry: AuditEntry): FeedView {
  const p: Payload = entry.payload || {};
  switch (entry.event_type) {
    case "AGENT_REASONING":
      return { label: "agent." + (p.step || "reasoning"), tone: "neutral", amountPaise: null };
    case "TOOL_CALL": {
      const out = p.output && typeof p.output === "object" ? p.output : null;
      const ap =
        out && typeof out.amount_total_rupees === "number"
          ? Math.round(out.amount_total_rupees * 100)
          : amountPaiseOf(out);
      return { label: "tool." + (p.tool || "call"), tone: p.error ? "broken" : "info", amountPaise: ap };
    }
    case "MONEY_ACTION":
      return { label: p.action || p.status || "money.action", tone: "trust", amountPaise: amountPaiseOf(p) };
    case "GUARDRAIL_DECISION": {
      const escalated = p.decision === "ESCALATE_TO_HUMAN" || p.outcome === "FAIL";
      const gl = "guardrail." + String(p.decision || p.outcome || "decision").toLowerCase();
      return { label: gl, tone: escalated ? "pending" : "trust", amountPaise: amountPaiseOf(p) };
    }
    case "MANDATE_ISSUED":
      return { label: "mandate.issued", tone: "info", amountPaise: null };
    case "MANDATE_VERIFIED":
      return { label: "mandate.verified", tone: "trust", amountPaise: null };
    case "WEBHOOK_RECEIVED": {
      const ev = String(p.event || "webhook");
      return { label: ev, tone: /fail|declin/i.test(ev) ? "broken" : "trust", amountPaise: amountPaiseOf(p) };
    }
    case "FAILURE":
      return { label: "failure", tone: "broken", amountPaise: amountPaiseOf(p) };
    case "GENESIS":
      return { label: "genesis", tone: "neutral", amountPaise: null };
    default:
      return {
        label: String(entry.event_type || "event").toLowerCase(),
        tone: "neutral",
        amountPaise: amountPaiseOf(p),
      };
  }
}

// ─── Human narration: an entry → { title, detail, tone, icon } ────────────────
// Used by the inline "thinking" timeline (chat) and the Activity feed (drawer).
export function narrate(entry: AuditEntry): Narration {
  const p: Payload = entry.payload || {};
  const money = amountPaiseOf(p);
  const moneyStr = money != null ? formatPaise(money) : "";
  switch (entry.event_type) {
    case "AGENT_REASONING":
      if (p.step === "search_catalog")
        return { title: "Searched the catalog", detail: p.note || "", tone: "info", icon: "search" };
      if (p.step === "create_cart") {
        const t = typeof p.total === "number" ? formatRupees(p.total) : "";
        return { title: "Built the cart", detail: t, tone: "info", icon: "cart" };
      }
      return {
        title: "Reasoned about your request",
        detail: p.user_message ? "“" + p.user_message + "”" : "",
        tone: "neutral",
        icon: "brain",
      };
    case "TOOL_CALL": {
      let argStr = "";
      if (p.error) {
        argStr = String(p.error);
      } else if (p.input) {
        try {
          const clone = Object.assign({}, p.input);
          if (clone.session_id) delete clone.session_id; // hide noise
          argStr = JSON.stringify(clone).replace(/["{}]/g, "").replace(/:/g, ": ").trim();
        } catch (e) {
          /* ignore */
        }
      }
      if (argStr.length > 60) argStr = argStr.substring(0, 57) + "...";
      return {
        title: "Called tool · " + (p.tool || "tool"),
        detail: argStr || moneyStr,
        tone: p.error ? "broken" : "info",
        icon: "tool",
      };
    }
    case "MANDATE_ISSUED": {
      const m = p.mandate || {};
      const cap = typeof m.max_paise === "number" ? formatPaise(m.max_paise) : "";
      return { title: "Issued intent mandate", detail: cap ? "cap " + cap : "", tone: "info", icon: "shield" };
    }
    case "MANDATE_VERIFIED":
      return {
        title: "Verified mandate signature",
        detail: p.method && p.path ? p.method + " " + p.path : "",
        tone: "trust",
        icon: "shieldCheck",
      };
    case "GUARDRAIL_DECISION": {
      const esc = p.decision === "ESCALATE_TO_HUMAN" || p.outcome === "FAIL";
      if (esc)
        return {
          title: "Held for your approval",
          detail:
            moneyStr +
            (p.threshold_rupees ? " · over ₹" + Number(p.threshold_rupees).toLocaleString("en-IN") : ""),
          tone: "pending",
          icon: "guardrail",
        };
      return { title: "Guardrail approved", detail: moneyStr, tone: "trust", icon: "guardrail" };
    }
    case "MONEY_ACTION":
      return { title: "Placed the order", detail: moneyStr, tone: "trust", icon: "money" };
    case "WEBHOOK_RECEIVED": {
      const ev = String(p.event || "webhook");
      const failed = /fail|declin/i.test(ev);
      return { title: "Razorpay · " + ev, detail: moneyStr, tone: failed ? "broken" : "trust", icon: "webhook" };
    }
    case "FAILURE":
      return { title: "Step failed", detail: p.reason || p.message || "", tone: "broken", icon: "alert" };
    case "GENESIS":
      return { title: "Audit chain genesis", detail: "server boot anchor", tone: "neutral", icon: "anchor" };
    default:
      return { title: String(entry.event_type || "event"), detail: "", tone: "neutral", icon: "dot" };
  }
}

// ─── Shared icon set (stroke-based, inherit currentColor) ─────────────────────
// Ported verbatim from store.js. Rendered via dangerouslySetInnerHTML on these
// constant strings (see components/ui/audit-icon.tsx) — no dependency on a
// specific lucide-react icon set/version.
export const ICONS = {
  brain:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M9.5 4.5a2.5 2.5 0 0 0-2.5 2.5 2.5 2.5 0 0 0-1 4.8A2.5 2.5 0 0 0 7 16.5a2.5 2.5 0 0 0 2.5 2.5V4.5Z"/><path d="M14.5 4.5A2.5 2.5 0 0 1 17 7a2.5 2.5 0 0 1 1 4.8A2.5 2.5 0 0 1 17 16.5a2.5 2.5 0 0 1-2.5 2.5V4.5Z"/></svg>',
  search:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.2-3.2"/></svg>',
  cart:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="20" r="1.4"/><circle cx="17" cy="20" r="1.4"/><path d="M3 4h2l2.2 11.2a1.5 1.5 0 0 0 1.5 1.2h8.1a1.5 1.5 0 0 0 1.5-1.2L21 8H6"/></svg>',
  shield:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>',
  shieldCheck:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="m9 12 2 2 4-4"/></svg>',
  shieldAlert:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="M12 8v4"/><path d="M12 16h.01"/></svg>',
  shieldQuestion:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3"/><path d="M12 17h.01"/></svg>',
  guardrail:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3 4 6v6c0 4.5 3.4 7.6 8 9 4.6-1.4 8-4.5 8-9V6l-8-3Z"/><path d="M12 8v4"/><path d="M12 16h.01"/></svg>',
  money:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="2.5"/><path d="M6 12h.01M18 12h.01"/></svg>',
  webhook:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M18 16.98a4 4 0 1 0-6-3.32"/><path d="M6 17a4 4 0 1 1 6-3.32"/><path d="M12 6.5 15 12H9l3-5.5Z"/></svg>',
  tool:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.5 2.5-2.8-.7-.7-2.8 2.7-2.5Z"/></svg>',
  alert:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>',
  anchor:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="5" r="2.5"/><path d="M12 22V7.5"/><path d="M5 12a7 7 0 0 0 14 0"/><path d="M2 12h3M19 12h3"/></svg>',
  link:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M9 17H7A5 5 0 0 1 7 7h2"/><path d="M15 7h2a5 5 0 1 1 0 10h-2"/><path d="M8 12h8"/></svg>',
  unlink:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M15 7h2a5 5 0 0 1 4 8"/><path d="M9 17H7A5 5 0 0 1 3 9"/><path d="m8 12 3 3"/><path d="M2 2l20 20"/></svg>',
  dot: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><circle cx="12" cy="12" r="3"/></svg>',
} as const;

export type IconName = keyof typeof ICONS;

export function icon(key: string): string {
  return (ICONS as Record<string, string>)[key] || ICONS.dot;
}

// ─── Tone → color ─────────────────────────────────────────────────────────────
// CSS custom properties defined in app/globals.css; consumed as hsl(var(--tone)).
export const TONE_VAR: Record<Tone, string> = {
  trust: "--trust",
  pending: "--pending",
  broken: "--broken",
  info: "--info",
  neutral: "--neutral",
};

export function toneColor(tone: string): string {
  return `hsl(var(${TONE_VAR[tone as Tone] || "--neutral"}))`;
}
