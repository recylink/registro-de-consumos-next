"use client";

// Tomar foto: captura ahora, datos después. Portado de proto/foto.jsx
// (FotoHubView + FotoCaptureForm + FotoColaSection).
//
// La subida sigue siendo en segundo plano: el formulario se limpia y la vista
// cambia a la cola de inmediato, con una fila fantasma mientras el archivo va
// camino a Drive. La diferencia es que el trabajo pendiente vive en el estado de
// esta pantalla y no en el estado global de la app, y que el aviso sale del toast
// del layout, que sobrevive a la navegación.

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Icon } from "@/components/icons";
import { Btn, Input, Select } from "@/components/ui/controls";
import { Card, Chip, Field, SectionHead } from "@/components/ui/layout";
import { useToast } from "@/components/ui/toast";
import { uploadFotoAction } from "@/app/actions/fotos";
import { errorArchivo } from "@/lib/domain/archivos";
import { TYPES } from "@/lib/domain/catalog";
import { fmtDateTime } from "@/lib/domain/format";
import { getProviderOptionsFor, getSubcatsFor } from "@/lib/domain/sucursales";

// Sin `refrigerantes`, y aca la razon es mas grave que en la configuracion.
//
// Esta lista tiene un gemelo que hay que mover con ella: la lista blanca de
// `completeFoto` en lib/sheets/fotos.js:104, que decide para que tipos se
// escribe el registro de consumo. Ofrecer aqui un tipo que alli no esta
// significa que la foto se marca procesada y el archivo se mueve a
// "procesados", pero el consumo no se escribe en ninguna parte: sin error y
// sin aviso. Los dos se cambian juntos o no se cambian.
//
// Ver ITEM_TYPES en lib/domain/sucursales.js y PLAYBOOK-NUEVO-TIPO.md.
export const TIPO_OPCIONES = [
  { value: "electricidad", label: "Electricidad" },
  { value: "combustible", label: "Combustible" },
  { value: "agua", label: "Agua" },
];

export const UNIDADES = ["L", "kg", "m³", "gal", "t", "kWh"];

const VACIO = {
  tipo: "", sucursal: "", periodo: "", subcat: "", consumo: "",
  unidad: "", costo: "", proveedor: "", notas: "",
};

// Campos que se pueden completar después: el único requisito para subir es la foto.
const OPCIONALES = ["tipo", "sucursal", "periodo", "subcat", "consumo", "costo", "proveedor", "notas"];

function FormularioCaptura({ sucursales, mesActual, onSubir }) {
  const [datos, setDatos] = useState(VACIO);
  const [file, setFile] = useState(null);
  const [preview, setPreview] = useState("");
  const [abierto, setAbierto] = useState(false);
  const inputRef = useRef(null);

  // La URL del preview es un recurso del navegador: hay que liberarla.
  useEffect(() => () => preview && URL.revokeObjectURL(preview), [preview]);

  const set = (campo, valor) => setDatos((d) => ({ ...d, [campo]: valor }));

  // La unidad sigue al tipo mientras no se elija a mano.
  const setTipo = (v) =>
    setDatos((d) => ({ ...d, tipo: v, subcat: "", unidad: d.unidad || TYPES[v]?.unit || "" }));

  const elegirArchivo = (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    setFile(f);
    setPreview(URL.createObjectURL(f));
  };

  const limpiar = () => {
    setDatos(VACIO);
    setFile(null);
    setPreview("");
    if (inputRef.current) inputRef.current.value = "";
  };

  const subir = () => {
    if (!file) return;
    onSubir({ file, ...datos });
    limpiar();
  };

  const activas = sucursales.filter((s) => s.activa);
  const subcatOpts = datos.tipo
    ? getSubcatsFor(sucursales, datos.tipo, datos.sucursal).map((s) => ({ value: s.id, label: s.label }))
    : [];
  const provOpts = datos.tipo && datos.sucursal
    ? getProviderOptionsFor(sucursales, datos.sucursal, datos.tipo)
    : [];
  const completados = OPCIONALES.filter((k) => datos[k]).length;

  return (
    <Card>
      <div className="prt-col" style={{ gap: 18 }}>
        <label className={"rc-foto-drop" + (preview ? " has-image" : "")} htmlFor="rc-foto-file">
          <input
            id="rc-foto-file"
            ref={inputRef}
            type="file"
            accept="image/*"
            capture="environment"
            onChange={elegirArchivo}
            className="rc-foto-input"
          />
          {preview ? (
            <>
              <img src={preview} alt="Vista previa" className="rc-foto-drop-img" />
              <div className="rc-foto-drop-overlay">
                <Icon name="refresh" size={18} />
                <span>Cambiar foto</span>
              </div>
            </>
          ) : (
            <div className="rc-foto-drop-empty">
              <div className="rc-foto-drop-icon">
                <Icon name="photo_camera" size={36} />
              </div>
              <div className="rc-foto-drop-title">Tomar o subir foto</div>
              <div className="rc-foto-drop-sub">Móvil: abre la cámara · Desktop: selector de archivos</div>
              <div className="rc-foto-drop-cta">
                <Icon name="cloud_upload" size={16} />
                <span>Seleccionar archivo</span>
              </div>
            </div>
          )}
        </label>

        {file && (
          <div className="rc-foto-filemeta">
            <Icon name="check_circle" size={16} />
            <span className="rc-foto-filemeta-name">{file.name}</span>
            <span className="rc-foto-filemeta-size">{Math.round(file.size / 1024)} KB</span>
          </div>
        )}

        <button
          type="button"
          className={"rc-foto-collapse-head" + (abierto ? " open" : "")}
          onClick={() => setAbierto((o) => !o)}
        >
          <Icon name={abierto ? "expand_less" : "expand_more"} size={18} />
          <span className="rc-foto-collapse-title">
            Datos opcionales
            {completados > 0 ? ` · ${completados} completado${completados === 1 ? "" : "s"}` : ""}
          </span>
          <span className="rc-foto-collapse-hint">Se pueden completar después</span>
        </button>

        {abierto && (
          <div className="rc-foto-collapse-body">
            <Field label="Tipo de consumo">
              <Select value={datos.tipo} onChange={setTipo} options={TIPO_OPCIONES} placeholder="Elige tipo" />
            </Field>
            <Field
              label="Sucursal"
              helper={activas.length === 0 ? "Configura sucursales para asignar." : undefined}
            >
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
            <Field label="Consumo">
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
          </div>
        )}

        <div className="rc-foto-actions">
          <Btn kind="primary" icon="cloud_upload" onClick={subir} disabled={!file}>
            Subir foto
          </Btn>
        </div>
      </div>
    </Card>
  );
}

function FilaFoto({ row }) {
  const tipo = TIPO_OPCIONES.find((t) => t.value === row.tipo);
  return (
    <div className="rc-foto-row">
      <span className="rc-foto-row-ico" style={{ background: "var(--rl-gray-100)", color: "var(--rl-gray-700)" }}>
        <Icon name={TYPES[row.tipo]?.icon || "photo_camera"} size={16} />
      </span>
      <div className="rc-foto-row-body">
        <div className="rc-foto-row-title">
          {row.sucursal || "—"}
          {row.tipo && <span style={{ color: "var(--rl-gray-600)" }}> · {tipo?.label || row.tipo}</span>}
        </div>
        <div className="rc-foto-row-sub">
          {row.periodo || "—"} · {row.fechaSubida ? fmtDateTime(row.fechaSubida) : "—"}
          {row.link && (
            <>
              {" · "}
              <a href={row.link} target="_blank" rel="noopener noreferrer" className="prt-link">Foto</a>
            </>
          )}
        </div>
      </div>
      <div className="rc-foto-row-actions">
        <Chip size="sm" kind={row.status === "procesado" ? "success" : "warning"}>
          {row.status === "procesado" ? "Procesado" : "Pendiente"}
        </Chip>
        {row.status !== "procesado" && (
          <Link className="prt-btn sm" href={`/registrar/foto/completar?foto=${row.id}`}>
            <Icon name="edit" />
            Completar
          </Link>
        )}
      </div>
    </div>
  );
}

function Cola({ fotos, error, subiendo }) {
  const pendientes = fotos.filter((r) => r.status !== "procesado");
  const procesadas = fotos.filter((r) => r.status === "procesado");

  if (error) {
    return (
      <Card>
        <div className="prt-help error">
          <Icon name="error" size={14} />
          <span>{error}</span>
        </div>
      </Card>
    );
  }

  return (
    <>
      <Card flush>
        <div className="rc-home-card-head">
          <div>
            <div className="rc-home-kpi">{pendientes.length + subiendo.length}</div>
            <div className="prt-hint" style={{ marginTop: 2 }}>
              pendientes{subiendo.length > 0 ? ` · ${subiendo.length} subiendo` : ""}
            </div>
          </div>
        </div>
        <div className="rc-home-list">
          {subiendo.map((j) => (
            <div key={j.id} className="rc-foto-row rc-foto-row-ghost">
              <span className="rc-foto-row-ico" style={{ background: "var(--rl-primary-50)", color: "var(--rl-primary-900)" }}>
                <span className="prt-spinner" style={{ width: 14, height: 14, borderWidth: 2 }} />
              </span>
              <div className="rc-foto-row-body">
                <div className="rc-foto-row-title">Subiendo foto…</div>
                <div className="rc-foto-row-sub">{j.label}</div>
              </div>
              <div className="rc-foto-row-actions">
                <Chip size="sm" kind="info">En curso</Chip>
              </div>
            </div>
          ))}
          {pendientes.length === 0 && subiendo.length === 0 ? (
            <div className="rc-home-empty">
              <Icon name="check_circle" size={28} style={{ color: "var(--rl-success-500)" }} />
              <div className="prt-hint" style={{ marginTop: 6 }}>Sin fotos pendientes.</div>
            </div>
          ) : (
            pendientes.map((r) => <FilaFoto key={r.id} row={r} />)
          )}
        </div>
      </Card>

      <div style={{ height: 14 }} />

      <Card flush>
        <div className="rc-home-card-head">
          <div>
            <div className="rc-home-kpi">{procesadas.length}</div>
            <div className="prt-hint" style={{ marginTop: 2 }}>procesadas</div>
          </div>
        </div>
        <div className="rc-home-list">
          {procesadas.length === 0 ? (
            <div className="rc-home-empty">
              <Icon name="inbox" size={28} style={{ color: "var(--rl-gray-300)" }} />
              <div className="prt-hint" style={{ marginTop: 6 }}>Aún no hay fotos procesadas.</div>
            </div>
          ) : (
            // Solo las 20 más recientes: la historia completa está en la planilla.
            procesadas.slice(0, 20).map((r) => <FilaFoto key={r.id} row={r} />)
          )}
        </div>
      </Card>
    </>
  );
}

export function FotoHub({ fotos, error, sucursales, mesActual }) {
  const router = useRouter();
  const toast = useToast();
  const [tab, setTab] = useState("nueva");
  const [subiendo, setSubiendo] = useState([]);

  const subir = async (params) => {
    // Una foto de cámara puede pesar bastante; sobre el tope el Server Action
    // corta el cuerpo y el error llega sin mensaje.
    const problema = errorArchivo(params.file);
    if (problema) {
      toast.error("Foto demasiado grande", problema);
      return;
    }

    const job = { id: `${Date.now()}-${params.file.name}`, label: params.file.name };
    setTab("cola");
    setSubiendo((s) => [...s, job]);
    toast.info("Subiendo foto…", "Sigue trabajando, te aviso al terminar.");

    const fd = new FormData();
    fd.set("file", params.file);
    for (const k of OPCIONALES.concat("unidad")) fd.set(k, params[k] ?? "");

    const res = await uploadFotoAction(fd);
    setSubiendo((s) => s.filter((j) => j.id !== job.id));

    if (!res.ok) {
      toast.error("Error subiendo foto", res.error);
      return;
    }
    toast.success("Foto subida", "Disponible en la cola.");
    router.refresh();
  };

  const pendientes = fotos.filter((r) => r.status !== "procesado").length;

  return (
    <div>
      <SectionHead
        eyebrow="Tomar foto"
        title="Foto + datos diferidos"
        sub="Captura una foto del medidor o documento. Los datos se pueden completar después, aquí mismo o directo en el Sheet."
      />

      <div className="rc-foto-tabs">
        <button className={"rc-foto-tab" + (tab === "nueva" ? " active" : "")} onClick={() => setTab("nueva")}>
          <Icon name="photo_camera" size={16} />
          <span>Nueva</span>
        </button>
        <button className={"rc-foto-tab" + (tab === "cola" ? " active" : "")} onClick={() => setTab("cola")}>
          <Icon name="list" size={16} />
          <span>Cola{pendientes > 0 ? ` · ${pendientes}` : ""}</span>
        </button>
      </div>

      {subiendo.length > 0 && (
        <div className="rc-foto-inflight">
          <span className="prt-spinner" />
          <span className="rc-foto-inflight-label">
            {subiendo.length === 1 ? `Subiendo ${subiendo[0].label}…` : `${subiendo.length} fotos subiendo…`}
          </span>
          <span className="rc-foto-inflight-hint">Puedes seguir usando la app.</span>
        </div>
      )}

      {tab === "nueva" ? (
        <FormularioCaptura sucursales={sucursales} mesActual={mesActual} onSubir={subir} />
      ) : (
        <Cola fotos={fotos} error={error} subiendo={subiendo} />
      )}
    </div>
  );
}
