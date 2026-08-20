import { NextResponse } from "next/server";
import { ping } from "@/lib/apps-script";
import { instanceInfo } from "@/lib/data";
import { isSdkConfigured, sdkFaltantes, sdkPing } from "@/lib/google/auth";
import { estadoFlag } from "@/lib/backend-flag";
import { appsScriptConfigurado } from "@/lib/instance";
import { dbConfigurado, dbPing } from "@/lib/db/cliente";
import { backendDatos } from "@/lib/backend";

// Diagnóstico de la instancia. Durante la migración conviven varios backends, así
// que reporta cada uno por separado: cuál está configurado y cuál responde de
// verdad. Son tres: el Apps Script viejo, el SDK de Google, y PostgreSQL.
//
// OJO con `postgres.leeDatos`: si es false —y hoy lo es— significa que la app
// alcanza la base pero TODAVIA NO LA USA. Sigue leyendo y escribiendo en la
// planilla. Que la conexion responda no quiere decir que la app este migrada.
//
//   curl -s http://localhost:3000/api/health
//
// No expone la URL del /exec ni la clave privada, solo si están presentes.

export const dynamic = "force-dynamic";

async function probar(fn) {
  try {
    return { ok: true, detalle: await fn() };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

export async function GET() {
  const info = instanceInfo();

  // `info.configured` ahora significa "hay algún backend", así que no sirve para
  // decidir si sondear el viejo: con solo el SDK daría true y el sondeo fallaría.
  const appsScript = appsScriptConfigurado()
    ? await probar(ping)
    : { ok: false, error: "APPS_SCRIPT_URL no configurada" };

  const sdk = isSdkConfigured()
    ? await probar(sdkPing)
    : { ok: false, error: "falta " + sdkFaltantes().join(", ") };

  const postgres = dbConfigurado()
    ? await probar(dbPing)
    : { ok: false, error: "DATABASE_URL no configurada" };

  // 502 solo si NINGÚN backend responde: durante la migración basta con que uno
  // sirva para que la app siga en pie. Postgres NO cuenta aquí a proposito: la
  // app no depende de el todavia, así que una base caída no debe pintar la
  // instancia como caída.
  const status = appsScript.ok || sdk.ok ? 200 : 502;

  return NextResponse.json(
    { ...info, migracion: estadoFlag(), datos: backendDatos(), appsScript, sdk, postgres },
    { status },
  );
}
