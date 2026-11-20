"use client";
import { useEffect, useState } from "react";

// Age measures our fetch time, not the exchange timestamp or provider delay.
export default function SnapshotAge({ fetchedAt }: { fetchedAt: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 10000);
    return () => clearInterval(timer);
  }, [fetchedAt]);
  const timestamp = Date.parse(fetchedAt);
  if (!Number.isFinite(timestamp)) return <span>time unavailable</span>;
  const seconds = Math.max(0, Math.floor((now - timestamp) / 1000));
  const age = seconds < 60 ? `${seconds}s` : seconds < 3600 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}m`;
  return <span title="Time since FlashScope fetched this snapshot; market data may have additional provider delay.">{new Date(timestamp).toLocaleString()} · fetched {age} ago</span>;
}
