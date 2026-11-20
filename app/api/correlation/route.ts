import { NextRequest, NextResponse } from "next/server";
import { computeCorrelation, syncMirror } from "@/lib/mirror";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function readDays(request: NextRequest) {
  return Number(request.nextUrl.searchParams.get("days")) || 7;
}

/** Read the latest correlation without re-syncing the mirror. */
export async function GET(request: NextRequest) {
  try {
    return NextResponse.json(await computeCorrelation(readDays(request)));
  } catch (error) {
    console.error("Correlation failed:", error);
    return NextResponse.json({ error: "Unable to calculate correlation." }, { status: 500 });
  }
}

let pendingSync: ReturnType<typeof syncMirror> | null = null;

/** Share mirror syncing across concurrent worker and browser requests. */
export async function POST(request: NextRequest) {
  try {
    if (!pendingSync) pendingSync = syncMirror().finally(() => { pendingSync = null; });
    const sync = await pendingSync;
    const payload = await computeCorrelation(readDays(request));
    return NextResponse.json({ ...payload, sync });
  } catch (error) {
    console.error("Correlation run failed:", error);
    return NextResponse.json({ error: "Unable to run correlation analysis." }, { status: 500 });
  }
}
