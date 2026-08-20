"use client";

// Completar los datos de una foto pendiente. Portado de FotoCompleteView
// (proto/foto.jsx).
//
// Al guardar: se cierra la fila de la hoja "Fotos", se escribe el Registro de
// consumo y el archivo se mueve a la carpeta de procesados. Antes eran 11
// llamadas al Apps Script solo para las celdas; ahora la acción `updateCells` las
// manda en una.

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/icons";
import { Btn, Input, Select } from "@/components/ui/controls";
import { Card, Field, SectionHead } from "@/components/ui/layout";
import { useToast } from "@/components/ui/toast";
import { completeFotoAction } from "@/app/actions/fotos";
import { TIPO_OPCIONES, UNIDADES } from "@/components/views/foto-hub";
import { TYPES } from "@/lib/domain/catalog";
import { getProviderOptionsFor, getSubcatsFor } from "@/lib/domain/sucursales";

export function FotoCompletar({ row, sucursales, mesActual }) {
  const router = useRouter();
  const toast = useToast();
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState("");

  const [datos, setDatos] = useState({
    tipo: row.tipo || "",
    sucursal: row.sucursal || "",
    periodo: row.periodo || "",
    subcat: row.subcat || "",
    consumo: row.consumo || "",
    unidad: row.unidad || TYPES[row.tipo]?.unit || "",
    costo: row.costo || "",
    proveedor: row.proveedor || "",
    notas: row.notas || "",
  });

  const set = (campo, valor) => setDatos((d) => ({ ...d, [campo]: valor }));

  const activas = sucursales.filter((s) => s.activa);
  const subcatOpts = datos.tipo
    ? getSubcatsFor(sucursales, datos.tipo, datos.sucursal).map((s) => ({ value: s.id, label: s.label }))
    : [];
  const provOpts = datos.tipo && datos.sucursal
    ? getProviderOptionsFor(sucursales, datos.sucursal, datos.tipo)
    : [];

  const guardar = async () => {
    if (!datos.consumo) {
      setError("Consumo es obligatorio.");
      return;
    }
    setError("");
    setGuardando(true);
    toast.info("Procesando foto…", "Guardando datos y moviendo archivo.");

    const res = await completeFotoAction({
      id: row.id,
      fotoRow: {
        ...row,
        tipo: datos.tipo,
        sucursal: datos.sucursal,
        periodo: datos.periodo,
      },
      patch: {
        consumo: datos.consumo,
        unidad: datos.unidad,
        costo: datos.costo,
        proveedor: datos.proveedor,
        subcat: datos.subcat,
        notas: datos.notas,
      },
    });
    setGuardando(false);

    if (!res.ok) {
      toast.error("Error procesando foto", res.error);
      return;
    }
    toast.success("Foto procesada", "Datos guardados y reflejados en el dashboard.");
    router.push("/registrar/foto");
  };

  return (
    <div>
      <SectionHead
        eyebrow="Completar foto"
        title={
          (datos.sucursal || "Foto pendiente") +
          (datos.tipo ? " · " + (TYPES[datos.tipo]?.label || datos.tipo) : "")
        }
        sub={`Período ${datos.periodo || "—"}. Al guardar se mueve el archivo a Procesados y se escribe el registro en el dashboard.`}
      />

      <div className="rc-foto-complete">
        <div className="rc-foto-complete-img">
          {row.fileId ? (
            <a href={row.link} target="_blank" rel="noopener noreferrer">
              {/* Miniatura de Drive: el archivo no es público, así que puede no
                  cargar según los permisos de la carpeta. */}
              <img
                src={`https://drive.google.com/thumbnail?id=${row.fileId}&sz=w800`}
                alt="Foto"
                referrerPolicy="no-referrer"
              />
            </a>
          ) : (
            <div className="prt-muted">Sin URL de Drive disponible.</div>
          )}
          {row.link && (
            <a
              className="prt-link"
              href={row.link}
              target="_blank"
              rel="noopener noreferrer"
              style={{ marginTop: 8, display: "inline-block" }}
            >
              Abrir en Drive →
            </a>
          )}
        </div>

        <Card style={{ flex: 1, minWidth: 0 }}>
          <div className="prt-col" style={{ gap: 14 }}>
            <Field label="Tipo de consumo">
              <Select
                value={datos.tipo}
                onChange={(v) => setDatos((d) => ({ ...d, tipo: v, subcat: "" }))}
                options={TIPO_OPCIONES}
                placeholder="Elige tipo"
              />
            </Field>
            <Field label="Sucursal">
              <Select
                value={datos.sucursal}
                onChange={(v) => set("sucursal", v)}
                options={activas.map((s) => ({ value: s.nombre, label: s.nombre }))}
                placeholder="Elige sucursal"
              />
            </Field>
            <Field label="Período (mes)">
              <Input type="month" value={datos.periodo} onChange={(v) => set("periodo", v)} max={mesActual} />
            </Field>
            {subcatOpts.length > 0 && (
              <Field label="Subcategoría">
                <Select value={datos.subcat} onChange={(v) => set("subcat", v)} options={subcatOpts} placeholder="—" />
              </Field>
            )}
            <Field label="Consumo" required>
              <Input value={datos.consumo} onChange={(v) => set("consumo", v)} suffix={datos.unidad} type="number" />
            </Field>
            {datos.tipo === "combustible" && (
              <Field label="Unidad">
                <Select value={datos.unidad} onChange={(v) => set("unidad", v)} options={UNIDADES} placeholder="Unidad" />
              </Field>
            )}
            <Field label="Costo (CLP)">
              <Input value={datos.costo} onChange={(v) => set("costo", v)} type="number" />
            </Field>
            <Field label="Proveedor">
              {provOpts.length > 0 ? (
                <Select value={datos.proveedor} onChange={(v) => set("proveedor", v)} options={provOpts} placeholder="Elige proveedor" />
              ) : (
                <Input value={datos.proveedor} onChange={(v) => set("proveedor", v)} placeholder="—" />
              )}
            </Field>
            <Field label="Notas">
              <Input value={datos.notas} onChange={(v) => set("notas", v)} placeholder="Opcional" />
            </Field>

            {error && (
              <div className="prt-help error">
                <Icon name="error" size={14} />
                <span>{error}</span>
              </div>
            )}

            <div className="prt-row" style={{ gap: 10, marginTop: 4, flexWrap: "wrap" }}>
              <Btn kind="primary" icon="check" onClick={guardar} disabled={guardando || !datos.consumo}>
                {guardando ? "Procesando…" : "Guardar y procesar"}
              </Btn>
              <Link className="prt-btn" href="/registrar/foto">Cancelar</Link>
            </div>
          </div>
        </Card>
      </div>
    </div>
  );
}
