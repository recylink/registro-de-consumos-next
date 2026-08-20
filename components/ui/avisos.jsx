import { Icon } from "@/components/icons";

/**
 * Aviso de que la instancia no tiene backend, o que la lectura falló. En el
 * prototipo esto era un console.warn y la pantalla quedaba vacía sin explicar
 * por qué.
 */
export function AvisoDatos({ configured, error }) {
  if (error) {
    return (
      <div className="rc-banner error" role="alert">
        <Icon name="error" size={16} />
        <span>No se pudieron leer los datos de la planilla: {error}</span>
      </div>
    );
  }
  if (!configured) {
    return (
      <div className="rc-banner warning" role="status">
        <Icon name="warning" size={16} />
        <span>
          Esta instancia todavía no tiene de dónde sacar los datos: falta
          configurar la base (<code>DATABASE_URL</code>) o la planilla (las
          credenciales de Google). Las pantallas se ven vacías y no se guarda
          nada.
        </span>
      </div>
    );
  }
  return null;
}
