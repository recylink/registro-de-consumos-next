import Link from "next/link";
import { FotoCompletar } from "@/components/views/foto-completar";
import { SectionHead } from "@/components/ui/layout";
import { loadFotos, loadSucursales } from "@/lib/data";
import { currentMonthKey } from "@/lib/domain/periods";

export const metadata = { title: "Completar foto" };

// Qué foto completar viene en la URL (?foto=<id>). Antes era ?fila=N, el número
// de fila de la hoja: eso dejó de servir al pasar a PostgreSQL, donde una fila no
// tiene posición. El id es texto y opaco a propósito.
// En el prototipo era un campo del estado global, así que la pantalla no era
// enlazable y un refresh la perdía.
export default async function CompletarFotoPage({ searchParams }) {
  const { foto, fila } = await searchParams;
  // `fila` se sigue aceptando para no romper un enlace guardado de antes.
  const id = String(foto ?? fila ?? "");

  const [fotos, sucursales] = await Promise.all([loadFotos(), loadSucursales()]);
  const row = fotos.data.find((r) => String(r.id) === id);

  if (!row) {
    return (
      <div>
        <SectionHead
          eyebrow="Completar"
          title="Foto no encontrada"
          sub={
            fotos.configured
              ? "La fila indicada no está en la cola: puede haberse procesado ya."
              : "Esta instancia no tiene backend configurado, así que no hay cola que leer."
          }
        />
        <Link className="prt-btn" href="/registrar/foto">Volver a la cola</Link>
      </div>
    );
  }

  return <FotoCompletar row={row} sucursales={sucursales.data} mesActual={currentMonthKey()} />;
}
