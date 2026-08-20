/** GET /api/status — état de session, file, dernier monitor, journal. */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { store } from "@/lib/session";
import { config } from "@/lib/config";

export async function GET() {
  return NextResponse.json({
    config: {
      dsn: config.dsn,
      machineIp: config.machineIp,
      serverIp: config.serverIp,
      serverPort: config.serverPort,
      generation: config.generation,
      lanKeyId: config.lanKeyId,
      lanKeySet: config.lanKey.length > 0,
    },
    session: store.session
      ? { active: true, startedAt: store.sessionStartedAt }
      : { active: false },
    lastRegisterAt: store.lastRegisterAt,
    program: store.program
      ? { active: store.program.active, label: store.program.label, counter: store.program.counter }
      : null,
    lastMonitor: store.lastMonitor,
    lastDataResponse: store.lastDataResponse,
    log: store.log.slice(0, 50),
  });
}
